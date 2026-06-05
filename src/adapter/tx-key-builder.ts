/**
 * Key builder for transaction operations — extracted from transaction.ts.
 *
 * Resolves a DynamoDB Key from a Better Auth where clause.
 * Requires eq clauses for both PK and (when the model uses a composite key) SK.
 */

import type { KeySchema, WhereClause } from "../types";
import { DynamoAdapterError } from "../errors";

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
