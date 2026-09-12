/**
 * Key builder for transaction operations — extracted from transaction.ts.
 *
 * Resolves a DynamoDB Key from a Better Auth where clause.
 * Requires eq clauses for both PK and (when the model uses a composite key) SK.
 */

import type { KeySchema, WhereClause } from "../types";
import { DynamoAdapterError } from "../errors";

/**
 * Non-throwing variant: returns null when the where clause cannot name the
 * full primary key. Callers fall back to a pre-resolving findOne
 * (planner-routed: GSI or scan) and take the key from the found item — the
 * pattern Better Auth's oauth-provider relies on when it updates
 * `oauthClient` rows inside a transaction keyed by `clientId` +
 * `clientDiscoveryId` instead of the adapter's PK.
 */
export function tryBuildTxKey(
  where: WhereClause[],
  schema: KeySchema,
): Record<string, any> | null {
  const pkEq = where.find(
    (w: WhereClause) => w.field === schema.pkField && (!w.operator || w.operator === "eq"),
  );
  if (!pkEq) return null;
  const key: Record<string, any> = { [schema.pkField]: pkEq.value };
  if (schema.skField) {
    const skEq = where.find(
      (w: WhereClause) => w.field === schema.skField && (!w.operator || w.operator === "eq"),
    );
    if (!skEq) return null;
    key[schema.skField] = skEq.value;
  }
  return key;
}

export function buildTxKey(
  where: WhereClause[],
  schema: KeySchema,
  model: string,
): Record<string, any> {
  const pkEq = where.find(
    (w: WhereClause) => w.field === schema.pkField && (!w.operator || w.operator === "eq"),
  );
  if (!pkEq) {
    throw new DynamoAdapterError(
      "INVALID_WHERE",
      `Transaction operation requires PK field "${schema.pkField}" in where clause for model "${model}"`,
    );
  }

  const key: Record<string, any> = { [schema.pkField]: pkEq.value };

  if (schema.skField) {
    const skEq = where.find(
      (w: WhereClause) => w.field === schema.skField && (!w.operator || w.operator === "eq"),
    );
    if (!skEq) {
      throw new DynamoAdapterError(
        "INVALID_WHERE",
        `Transaction operation requires SK field "${schema.skField}" in where clause for model "${model}"`,
      );
    }
    key[schema.skField] = skEq.value;
  }

  return key;
}
