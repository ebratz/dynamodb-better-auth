/**
 * Analyses a Better Auth where clause and determines the DynamoDB access pattern.
 *
 * Tier 1: PK equality (simple or composite) → GetItem
 * Tier 2: Matches a declared GSI key → Query
 * Tier 3: No index match → Scan + FilterExpression
 *
 * Sets needsFollowUpGetItem for KEYS_ONLY GSIs (e.g., account by-id).
 *
 * Per DESIGN.md §3.
 */

import type { DynamoDBAdapterConfig, QueryPlan } from "../types";
import { getKeySchema } from "./key-builder";
import { convertWhereClause } from "./where-converter";

// ── Where clause shape ─────────────────────────────────────────

interface WhereEntry {
  field: string;
  value: string | number | boolean | string[] | number[] | Date | null;
  operator?: string;
  connector?: "AND" | "OR";
  mode?: "sensitive" | "insensitive";
}

// ── Resolvers ──────────────────────────────────────────────────

/**
 * Simple identity resolver — where-converter handles field name
 * transformation internally, so the planner uses raw field names
 * for Key construction and GSI matching.
 */
export function identityGetFieldName({ field }: { model: string; field: string }): string {
  return field;
}
export function identityGetFieldAttributes(): any {
  return {};
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Build a plain FilterExpression (and associated names/values) from a
 * where clause — useful for count, updateMany _findItems, deleteMany
 * _findItems, and any Scan path that just needs a filter.
 *
 * Delegates to convertWhereClause with identity field resolvers.
 */
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

export function resolveQueryPlan(
  where: WhereEntry[],
  model: string,
  config: DynamoDBAdapterConfig,
): QueryPlan {
  const tableName = config.tables[model];
  if (!tableName) {
    throw new Error(`No table configured for model "${model}"`);
  }

  const schema = getKeySchema(model, config);
  const indexes = config.indexes?.[model] ?? {};

  // ── Tier 1: PK equality check ────────────────────────────────
  const pkEq = findEqClause(where, schema.pkField);
  if (pkEq !== undefined) {
    // PK is resolvable. Build the key from PK (+ optional SK).
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

  // ── Tier 2: GSI match ────────────────────────────────────────
  for (const [fieldName, gsi] of Object.entries(indexes)) {
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

    // Build KeyConditionExpression and FilterExpression with a shared
    // namespace to avoid #nX placeholder collisions when merging.
    const allClauses = [...keyConditionClauses, ...filterClauses];
    const combined = convertWhereClause(allClauses, {
      model,
      getFieldName: identityGetFieldName,
      getFieldAttributes: identityGetFieldAttributes,
    });

    // The combined expression includes both key conditions and filters —
    // we need to split them back out. Extract the key condition portion
    // by building it separately from the shared namespace.
    const kcOnly = convertWhereClause(keyConditionClauses, {
      model,
      getFieldName: identityGetFieldName,
      getFieldAttributes: identityGetFieldAttributes,
    });

    // Filter expression is the rest (combined minus key condition).
    // Since DynamoDB evaluates them separately, we pass the combined
    // names/values and use a manually split expression.
    // Simplest correct approach: use kcOnly for keyCondition,
    // and rebuild filter with a fresh call that starts after kcOnly's indices.
    //
    // But the simplest correct approach is: use combined names/values
    // for both expressions. DynamoDB ignores unused entries.
    let filterExpr = "";
    if (filterClauses.length > 0) {
      const fResult = convertWhereClause(filterClauses, {
        model,
        getFieldName: identityGetFieldName,
        getFieldAttributes: identityGetFieldAttributes,
      });
      filterExpr = fResult.expression;
      // Merge names/values: start with kc names, then add filter names
      // avoiding key collisions.
      let offset = Object.keys(kcOnly.expressionAttributeNames).length;
      const mergedNames = { ...kcOnly.expressionAttributeNames };
      const mergedValues = { ...kcOnly.expressionAttributeValues };
      for (const [key, field] of Object.entries(fResult.expressionAttributeNames)) {
        if (mergedNames[key] !== undefined && mergedNames[key] !== field) {
          // Collision — remap to a fresh #nX slot.
          const newKey = `#n${offset++}`;
          mergedNames[newKey] = field;
          // Replace old key references in the filter expression.
          const escapedKey = key.replace(/#/g, "\\#");
          filterExpr = filterExpr.replace(new RegExp(escapedKey, "g"), newKey);
        } else if (mergedNames[key] === undefined) {
          mergedNames[key] = field;
        }
        // If same field mapped to same key, no action needed.
      }
      Object.assign(mergedValues, fResult.expressionAttributeValues);

      // Use the merged map for the final plan.
      kcOnly.expressionAttributeNames = mergedNames;
      kcOnly.expressionAttributeValues = mergedValues;
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

  // ── Tier 3: Scan fallback ────────────────────────────────────
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

/**
 * Finds an eq clause for a given field and returns its value, or undefined.
 * An omitted operator defaults to eq.
 */
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

/**
 * Operators that can be used in a KeyConditionExpression on a sort key.
 * DynanoDB docs: =, <, <=, >, >=, BETWEEN, begins_with
 */
const SORT_KEY_OPERATORS = new Set([
  "eq", "lt", "lte", "gt", "gte", "starts_with", "between",
]);

function isSortKeyOperator(op: string): boolean {
  return SORT_KEY_OPERATORS.has(op);
}
