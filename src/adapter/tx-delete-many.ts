/**
 * tx-delete-many handler — extracted from createTransactionWrapper.
 *
 * Applies the framework where-transform, finds ALL matching items (no
 * silent 100-row default limit — bounded by maxDeleteManyItems, with the
 * transaction capacity guard as the loud 100-action backstop), builds
 * composite keys, then buffers a Delete action per item. Returns count.
 *
 * An empty where array matches every existing row, subject to action limits.
 */

import { writeCondition, snapshotWhere } from "../helpers/write-condition";
import { buildEmailUniquenessActions } from "../email-uniqueness";
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

  if (!args.where) return 0;

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
  const fetchLimit = maxItems > 0 ? maxItems + 1 : 101;
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

  // Coalesce with actions already buffered in this transaction: better-auth
  // core's verification consumption runs consumeOne(id) and then
  // deleteMany(identifier) in ONE transaction, and the sweep resolves the
  // very row consumeOne already claimed. DynamoDB forbids two actions on the
  // same item per TransactWriteItems, and the buffered action already
  // guarantees that row's removal — skipping it preserves the caller's
  // intent exactly.
  const alreadyTargeted = (key: Record<string, any>) =>
    ctx.writeBuffer.some((action: any) => {
      const op = action.Delete;
      if (!op || op.TableName !== tableName) return false;
      const target = op.Key ?? op.Item;
      return (
        target !== undefined &&
        Object.entries(key).every(([k, v]) => target[k] === v)
      );
    });

  const keys = items
    .map((item) => {
      const key: Record<string, any> = { [schema.pkField]: item[schema.pkField] };
      if (schema.skField && item[schema.skField] !== undefined) {
        key[schema.skField] = item[schema.skField];
      }
      return key;
    })
    .filter((key) => !alreadyTargeted(key));

  // A pending update followed by deletion becomes a deletion. Preserve its
  // optimistic guard through the original row snapshot below.
  for (const key of keys) {
    const index = ctx.writeBuffer.findIndex(action => action.Update?.TableName === tableName && Object.entries(key).every(([field, value]) => action.Update.Key[field] === value));
    if (index >= 0) ctx.writeBuffer.splice(index, 1);
  }
  assertTransactionCapacity(ctx.writeBuffer, keys.length);

  for (const key of keys) {
    const item = items.find(row => Object.entries(key).every(([field, value]) => row[field] === value))!;
    const claims = ctx.config.enableEmailUniqueness && helpers.getDefaultModelName(model) === "user"
      ? buildEmailUniquenessActions("delete", ctx.config, { user: item }) : [];
    assertTransactionCapacity(ctx.writeBuffer, 1 + claims.length);
    ctx.writeBuffer.push(...claims);
    ctx.writeBuffer.push({
      Delete: {
        TableName: tableName,
        Key: key,
        ...writeCondition(snapshotWhere(item), schema.pkField, item),
      },
    });
  }

  return items.length;
}
