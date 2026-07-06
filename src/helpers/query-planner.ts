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
import { toDefaultModelName } from "./model-name";
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
  alwaysFalse?: boolean;
  postFilters?: Array<{ field: string; operator: string; value: any }>;
} | undefined {
  if (!where || where.length === 0) return undefined;
  const result = convertWhereClause(where, {
    model,
    getFieldName: identityGetFieldName,
    getFieldAttributes: identityGetFieldAttributes,
  });
  if (result.alwaysFalse) {
    return {
      expression: "",
      expressionAttributeNames: {},
      expressionAttributeValues: {},
      alwaysFalse: true,
    };
  }
  if (!result.expression && !result.postFilters) return undefined;
  return {
    expression: result.expression,
    expressionAttributeNames: result.expressionAttributeNames,
    expressionAttributeValues: result.expressionAttributeValues,
    ...(result.postFilters ? { postFilters: result.postFilters } : {}),
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
  // Normalize usePlural / modelName mapping — config maps are keyed by
  // default model names.
  const defaultModel = toDefaultModelName(config, model);
  const tableName = config.tables[defaultModel];
  if (!tableName) {
    throw new DynamoAdapterError(
      "UNKNOWN_MODEL",
      `[UNKNOWN_MODEL] No table configured for model "${model}".`,
    );
  }

  const schema = getKeySchema(model, config);
  const indexes = config.indexes?.[defaultModel] ?? {};

  // OR semantics cannot be expressed through a GetItem key or a
  // KeyConditionExpression (both are implicitly ANDed with any filter).
  // Any OR connector → straight to Tier 3, where convertWhereClause
  // renders the full expression with correct grouping.
  const hasOrConnector = where.some(
    (w, i) => i > 0 && w.connector === "OR",
  );
  if (hasOrConnector) {
    return fallbackTier3(where, tableName, model);
  }

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
 * Returns a plan only when the key is COMPLETE: the PK field (and the SK
 * for composite-key models) present with an eq operator. GetItem requires
 * the full key — a partial key is a ValidationException on real DynamoDB,
 * so incomplete keys fall through to Tier 2/3 instead.
 *
 * Extra where clauses beyond the key are flagged for client-side filtering
 * since GetItem has no FilterExpression. Clauses are matched by identity,
 * not field name, so a second clause on the key field (e.g. `id ne X`)
 * is preserved as a filter instead of being silently dropped.
 */
function tryTier1(
  where: WhereEntry[],
  schema: KeySchema,
  tableName: string,
): QueryPlan | null {
  const pkClause = findEqClauseEntry(where, schema.pkField);
  if (!pkClause) return null;

  const key: Record<string, any> = { [schema.pkField]: pkClause.value };
  const usedClauses = new Set<WhereEntry>([pkClause]);

  if (schema.skField) {
    const skClause = findEqClauseEntry(where, schema.skField);
    // Composite key without SK → key incomplete → not a GetItem.
    if (!skClause) return null;
    key[schema.skField] = skClause.value;
    usedClauses.add(skClause);
  }

  // Extra clauses beyond the key must be filtered client-side
  // because GetItem has no FilterExpression.
  const extraClauses = where.filter((w) => !usedClauses.has(w));

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
    const hashClause = findEqClauseEntry(where, gsi.hashKey);
    if (!hashClause) continue;

    // Found a GSI whose hash key has an eq match.
    const keyConditionClauses: WhereEntry[] = [];
    const filterClauses: WhereEntry[] = [];

    // Hash key eq goes into KeyConditionExpression
    keyConditionClauses.push({
      field: gsi.hashKey,
      operator: "eq",
      value: hashClause.value,
    });

    // Sort key: the FIRST clause with a key-condition-capable operator
    // goes into KeyConditionExpression (DynamoDB allows only one condition
    // per sort key). Everything else — including additional clauses on the
    // hash/range key (matched by identity, not field name) — is a filter.
    let rangeKeyConsumed = false;
    for (const w of where) {
      if (w === hashClause) continue; // the clause consumed as hash key

      if (gsi.rangeKey && w.field === gsi.rangeKey && !rangeKeyConsumed) {
        const op = (w.operator ?? "eq").toLowerCase();
        if (isSortKeyOperator(op)) {
          keyConditionClauses.push(w);
          rangeKeyConsumed = true;
          continue;
        }
      }
      filterClauses.push(w);
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
    let filterAlwaysFalse = false;
    let postFilters: Array<{ field: string; operator: string; value: any }> | undefined;
    if (filterClauses.length > 0) {
      const fResult = convertWhereClause(filterClauses, {
        model,
        getFieldName: identityGetFieldName,
        getFieldAttributes: identityGetFieldAttributes,
      });
      filterAlwaysFalse = fResult.alwaysFalse === true;
      postFilters = fResult.postFilters;
      const merged = mergeKeyAndFilterExpressions(kcOnly, fResult);
      filterExpr = merged.filterExpression;
      kcOnly.expressionAttributeNames = merged.names;
      kcOnly.expressionAttributeValues = merged.values;
    }

    // Sparse projections (KEYS_ONLY or { include }) don't carry every
    // base-table attribute — resolve full rows via follow-up GetItem.
    const isSparseProjection =
      gsi.projection !== undefined && gsi.projection !== "ALL";

    return {
      tier: 2,
      operation: "query",
      tableName,
      indexName: gsi.indexName,
      keyCondition: kcOnly.expression,
      filterExpression: filterExpr || undefined,
      expressionAttributeNames: kcOnly.expressionAttributeNames,
      expressionAttributeValues: kcOnly.expressionAttributeValues,
      ...(filterAlwaysFalse ? { alwaysFalse: true } : {}),
      ...(postFilters ? { postFilters } : {}),
      ...(isSparseProjection
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
    ...(scanResult.alwaysFalse ? { alwaysFalse: true } : {}),
    ...(scanResult.postFilters ? { postFilters: scanResult.postFilters } : {}),
  };
}

// ── Internal helpers ────────────────────────────────────────────

function findEqClauseEntry(
  where: WhereEntry[],
  field: string,
): WhereEntry | undefined {
  for (const w of where) {
    if (w.field === field) {
      const op = (w.operator ?? "eq").toLowerCase();
      if (op === "eq") return w;
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
