/**
 * tx-delete-many handler — extracted from createTransactionWrapper.
 *
 * Applies the framework where-transform, finds ALL matching items (no
 * silent 100-row default limit — bounded by maxDeleteManyItems, with the
 * transaction capacity guard as the loud 100-action backstop), builds
 * composite keys, then buffers a Delete action per item. Returns count.
 *
 * Includes empty-where guard: where: [] returns 0 without scanning.
 */

import { getKeySchema } from "../helpers/key-builder";
import { assertTransactionCapacity } from "../helpers/assert-capacity";
import { DynamoAdapterError } from "../errors";
import type { TransactionContext } from "./tx-types";
import type { WhereClause } from "../types";

export async function txDeleteMany(
  ctx: TransactionContext,
  args: {
    model: string;
    where: WhereClause[];
  },
): Promise<number> {
  const { model } = args;

  // Guard: empty where clause would delete everything
  if (!args.where || args.where.length === 0) return 0;

  const helpers = ctx.getHelpers();
  const mappedModel = helpers.getModelName?.(model) ?? model;
  const where = (helpers.transformWhereClause?.({
    model,
    where: args.where,
    action: "deleteMany",
  }) ?? args.where) as WhereClause[];

  const tableName = ctx.getTable(model);
  const schema = getKeySchema(model, ctx.config);

  // Find ALL matching items — the raw findMany would default to 100.
  const maxItems = ctx.config.maxDeleteManyItems ?? 1000;
  const fetchLimit = maxItems > 0 ? maxItems + 1 : undefined;
  const items = await ctx.nativeAdapter.findMany({
    model: mappedModel,
    where,
    ...(fetchLimit !== undefined ? { limit: fetchLimit } : {}),
  });

  if (items.length === 0) {
    return 0;
  }
  if (maxItems > 0 && items.length > maxItems) {
    throw new DynamoAdapterError(
      "TOO_MANY_ITEMS",
      `tx.deleteMany matched more than ${maxItems} items. ` +
        `Refine your where clause or increase maxDeleteManyItems in config.`,
    );
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
