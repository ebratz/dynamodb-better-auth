/**
 * tx-delete-many handler — extracted from createTransactionWrapper.
 *
 * Finds matching items via findMany, builds composite keys, then
 * buffers a Delete action per item via TransactWriteItems. Returns count.
 *
 * Includes empty-where guard: where: [] returns 0 without scanning.
 */

import { getKeySchema } from "../helpers/key-builder";
import { assertTransactionCapacity } from "../helpers/assert-capacity";
import type { TransactionContext } from "./tx-types";
import type { WhereClause } from "../types";

export async function txDeleteMany(
  ctx: TransactionContext,
  args: {
    model: string;
    where: WhereClause[];
  },
): Promise<number> {
  const { model, where } = args;

  // Guard: empty where clause would delete everything
  if (!where || where.length === 0) return 0;

  const tableName = ctx.getTable(model);
  const schema = getKeySchema(model, ctx.config);

  // Find all matching items
  const items = await ctx.nativeAdapter.findMany({ model, where });

  if (items.length === 0) {
    return 0;
  }

  // Block >100 actions
  assertTransactionCapacity(ctx.writeBuffer, items.length);

  for (const item of items) {
    const key: Record<string, any> = { [schema.pkField]: item[schema.pkField] };
    if (schema.skField && item[schema.skField] !== undefined) {
      key[schema.skField] = item[schema.skField];
    }

    ctx.writeBuffer.push({
      Delete: {
        TableName: tableName,
        Key: key,
      },
    });
  }

  return items.length;
}
