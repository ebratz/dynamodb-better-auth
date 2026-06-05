/**
 * Analyses a Better Auth where clause and determines the DynamoDB access pattern.
 *
 * Strategy chain: tryTier1 → tryTier2 → fallbackTier3.
 * Each tier is a standalone function returning a QueryPlan or null.
 * Adding Tier 4 requires adding one function + one `??` call.
 *
 * Tier 1: PK equality (simple or composite) → GetItem
 * Tier 2: Matches a declared GSI key → Query
 * Tier 3: Scan + FilterExpression (always succeeds)
 *
 * Sets needsFollowUpGetItem for KEYS_ONLY GSIs (e.g., account by-id).
 *
 * Per DESIGN.md §3.
 */

import type { DynamoDBAdapterConfig, QueryPlan, KeySchema } from "../types";
import { getKeySchema } from "./key-builder";
import { convertWhereClause } from "./where-converter";
import { mergeKeyAndFilterExpressions } from "./merge-expressions";
import { DynamoAdapterError } from "../errors";

// ── Where clause shape ─────────────────────────────────────────

interface WhereEntry {
  field: string;
  value: string | number | boolean | string[] | number[] | Date | null;
  operator?: string;
  connector?: "AND" | "OR";
  mode?: "sensitive" | "insensitive";
}

// ── GSI declaration shape (from types) ────────────────────────

interface GsiInfo {
  indexName: string;
  hashKey: string;
  rangeKey?: string;
  projection?: "ALL" | "KEYS_ONLY" | { include: string[] };
}

// ── Resolvers ──────────────────────────────────────────────────

export function identityGetFieldName({ field }: { model: string; field: string }): string {
  return field;
}
export function identityGetFieldAttributes(): any {
  return {};
}

// ── Public API ──────────────────────────────────────────────────

export function resolveFilter(
  where: WhereEntry[],
  model: string,
  _config: DynamoDBAdapterConfig,
): {
  expression: string;
  expressionAttributeNames: Record<string, string>;
  expressionAttributeValues: Record<string, any>;
} | undefined {
  if (!where || where.length === 0) return undefined;
  const result = convertWhereClause(where, {
    model,
    getFieldName: identityGetFieldName,
    getFieldAttributes: identityGetFieldAttributes,
  });
  if (!result.expression) return undefined;
  return {
    expression: result.expression,
    expressionAttributeNames: result.expressionAttributeNames,
    expressionAttributeValues: result.expressionAttributeValues,
  };
}

/**
 * Strategy chain: try Tier 1, then Tier 2, then fallback to Tier 3.
 * Each tier returns a complete QueryPlan or null (Tier 3 always succeeds).
 */
export function resolveQueryPlan(
  where: WhereEntry[],
  model: string,
  config: DynamoDBAdapterConfig,
): QueryPlan {
  const tableName = config.tables[model];
  if (!tableName) {
    throw new DynamoAdapterError(
      "UNKNOWN_MODEL",
      `[UNKNOWN_MODEL] No table configured for model "${model}".`,
    );
  }

  const schema = getKeySchema(model, config);
  const indexes = config.indexes?.[model] ?? {};

  return (
    tryTier1(where, schema, tableName) ??
    tryTier2(where, indexes, schema, tableName, model) ??
    fallbackTier3(where, tableName, model)
  );
}

// ── Tier 1: GetItem ────────────────────────────────────────────

/**
 * Attempts a direct GetItem when the primary key is fully known.
 *
 * Returns a plan if the PK field (and optional SK for composite keys)
 * is present with an eq operator. Extra where clauses beyond the key
 * are flagged for client-side filtering since GetItem has no FilterExpression.
 */
function tryTier1(
  where: WhereEntry[],
  schema: KeySchema,
  tableName: string,
): QueryPlan | null {
  const pkEq = findEqClause(where, schema.pkField);
  if (pkEq === undefined) return null;

  const key: Record<string, any> = { [schema.pkField]: pkEq };
  const usedFields = new Set([schema.pkField]);

  if (schema.skField) {
    const skEq = findEqClause(where, schema.skField);
    if (skEq !== undefined) {
      key[schema.skField] = skEq;
      usedFields.add(schema.skField);
    }
    // SK is optional — if not present, key is still valid.
  }

  // Extra clauses beyond the key must be filtered client-side
  // because GetItem has no FilterExpression.
  const extraClauses = where.filter((w) => !usedFields.has(w.field));

  if (extraClauses.length > 0) {
    return {
      tier: 1,
      operation: "getItem",
      tableName,
      key,
      expressionAttributeNames: {},
      expressionAttributeValues: {},
      needsClientSideFilter: true,
      clientSideFilters: extraClauses.map((w) => ({
        field: w.field,
        operator: w.operator ?? "eq",
        value: w.value,
      })),
    };
  }

  return {
    tier: 1,
    operation: "getItem",
    tableName,
    key,
    expressionAttributeNames: {},
    expressionAttributeValues: {},
  };
}

// ── Tier 2: GSI Query ──────────────────────────────────────────

/**
 * Attempts a GSI Query when a where clause matches a declared GSI.
 *
 * Scans the configured indexes for a hash-key eq match. If the GSI has a
 * range key and the where clause includes a sort-key-operator clause on it,
 * that clause goes into KeyConditionExpression; all other clauses become
 * FilterExpression. KEYS_ONLY projections trigger a followUpGetItem flag.
 */
function tryTier2(
  where: WhereEntry[],
  indexes: Record<string, GsiInfo>,
  schema: KeySchema,
  tableName: string,
  model: string,
): QueryPlan | null {
  for (const [, gsi] of Object.entries(indexes)) {
    const hashEq = findEqClause(where, gsi.hashKey);
    if (hashEq === undefined) continue;

    // Found a GSI whose hash key has an eq match.
    const keyConditionClauses: WhereEntry[] = [];
    const filterClauses: WhereEntry[] = [];

    // Hash key eq goes into KeyConditionExpression
    keyConditionClauses.push({
      field: gsi.hashKey,
      operator: "eq",
      value: hashEq,
    });

    // Sort key: if present and has a comparable operator,
    // include in KeyConditionExpression. Otherwise filter.
    for (const w of where) {
      if (w.field === gsi.hashKey) continue; // already handled

      if (gsi.rangeKey && w.field === gsi.rangeKey) {
        const op = (w.operator ?? "eq").toLowerCase();
        if (isSortKeyOperator(op)) {
          keyConditionClauses.push(w);
        } else {
          filterClauses.push(w);
        }
      } else {
        filterClauses.push(w);
      }
    }

    // Build KeyConditionExpression and FilterExpression with collision-free
    // namespacing. The key condition and filter share the same #nX / :vN
    // namespace — DynamoDB ignores unused entries, but we remap collisions.
    const kcOnly = convertWhereClause(keyConditionClauses, {
      model,
      getFieldName: identityGetFieldName,
      getFieldAttributes: identityGetFieldAttributes,
    });

    let filterExpr = "";
    if (filterClauses.length > 0) {
      const fResult = convertWhereClause(filterClauses, {
        model,
        getFieldName: identityGetFieldName,
        getFieldAttributes: identityGetFieldAttributes,
      });
      const merged = mergeKeyAndFilterExpressions(kcOnly, fResult);
      filterExpr = merged.filterExpression;
      kcOnly.expressionAttributeNames = merged.names;
      kcOnly.expressionAttributeValues = merged.values;
    }

    const isKeysOnly = gsi.projection === "KEYS_ONLY";

    return {
      tier: 2,
      operation: "query",
      tableName,
      indexName: gsi.indexName,
      keyCondition: kcOnly.expression,
      filterExpression: filterExpr || undefined,
      expressionAttributeNames: kcOnly.expressionAttributeNames,
      expressionAttributeValues: kcOnly.expressionAttributeValues,
      ...(isKeysOnly
        ? {
            needsFollowUpGetItem: true,
            followUpKeyFields: {
              pkField: schema.pkField,
              skField: schema.skField,
            },
          }
        : {}),
    };
  }

  return null;
}

// ── Tier 3: Scan (always succeeds) ─────────────────────────────

/**
 * Fallback: full-table Scan with FilterExpression.
 * Always succeeds — if no where clauses, returns a scan-everything plan.
 */
function fallbackTier3(
  where: WhereEntry[],
  tableName: string,
  model: string,
): QueryPlan {
  const scanResult = convertWhereClause(where, {
    model,
    getFieldName: identityGetFieldName,
    getFieldAttributes: identityGetFieldAttributes,
  });

  return {
    tier: 3,
    operation: "scan",
    tableName,
    filterExpression: scanResult.expression || undefined,
    expressionAttributeNames: scanResult.expressionAttributeNames,
    expressionAttributeValues: scanResult.expressionAttributeValues,
    needsClientSideSort: where.length > 0,
  };
}

// ── Internal helpers ────────────────────────────────────────────

function findEqClause(
  where: WhereEntry[],
  field: string,
): WhereEntry["value"] | undefined {
  for (const w of where) {
    if (w.field === field) {
      const op = (w.operator ?? "eq").toLowerCase();
      if (op === "eq") return w.value;
    }
  }
  return undefined;
}

const SORT_KEY_OPERATORS = new Set([
  "eq", "lt", "lte", "gt", "gte", "starts_with", "between",
]);

function isSortKeyOperator(op: string): boolean {
  return SORT_KEY_OPERATORS.has(op);
}
