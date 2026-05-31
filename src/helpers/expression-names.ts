/**
 * Builds safe ExpressionAttributeNames for DynamoDB expressions.
 * Uses #n0, #n1, #n2... to avoid collisions with 573 reserved words.
 *
 * Pattern: field names in expression strings never appear literally.
 * DDB has 573 reserved words (including "name", "token", "value", "data",
 * "user", "type", "role", "default", "condition", "update", "delete",
 * "status", "true", "false", "null", "order") — prefixing with #n avoids
 * every one of them unconditionally, with zero runtime reserved-word checks.
 *
 * Per DESIGN.md §7.
 */

import type { ExpressionNamesResult } from "../types";

/**
 * Build ExpressionAttributeNames and accessors for a set of field names.
 *
 * - Deduplicates: the same field always maps to the same #n placeholder.
 * - Appends on the fly: `toRef` for unknown fields creates new entries.
 * - Value reference generator: auto-incrementing when called without index.
 */
export function buildExpressionNames(fields: string[]): ExpressionNamesResult {
  const names: Record<string, string> = {};
  const known = new Map<string, string>();
  let valueCounter = 0;

  // Seed deduped entries from the provided list.
  for (const field of fields) {
    register(field);
  }

  function register(field: string): string {
    if (!known.has(field)) {
      const key = `#n${known.size}`;
      names[key] = field;
      known.set(field, key);
    }
    return known.get(field)!;
  }

  return {
    names,
    toRef: (field: string): string => {
      // Lazy-register unknown fields — callers may not know every field upfront.
      if (known.has(field)) return known.get(field)!;
      return register(field);
    },
    toValueRef: (index?: number): string => {
      const i = index ?? valueCounter++;
      return `:v${i}`;
    },
    nextValueIndex: valueCounter,
  };
}

/**
 * DynamoDB rejects requests that carry `ExpressionAttributeNames` or
 * `ExpressionAttributeValues` when no expression in the same request
 * actually references the placeholders. The query planner emits empty
 * `{}` maps for queries with no filter/key-condition; passing those
 * straight through trips `ValidationException: ExpressionAttributeNames
 * can only be specified when using expressions`.
 *
 * This helper returns the two fields only when their maps are non-empty,
 * so call sites can spread the result into the SDK command object.
 */
export function compactExpr(
  names: Record<string, string> | undefined,
  values: Record<string, unknown> | undefined,
): {
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
} {
  const out: {
    ExpressionAttributeNames?: Record<string, string>;
    ExpressionAttributeValues?: Record<string, unknown>;
  } = {};
  if (names && Object.keys(names).length > 0) out.ExpressionAttributeNames = names;
  if (values && Object.keys(values).length > 0) out.ExpressionAttributeValues = values;
  return out;
}
