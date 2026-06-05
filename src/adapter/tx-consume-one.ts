/**
 * tx-consume-one handler — extracted from createTransactionWrapper.
 *
 * Atomically reads and deletes a single item:
 *  1. Eagerly captures the item via nativeAdapter.findOne.
 *  2. Releases email-lookup if email uniqueness is enabled.
 *  3. Buffers a conditional Delete (attribute_exists) to prevent
 *     double-consumption at commit time.
 *
 * Returns the captured item, or null if none found.
 */

import { getKeySchema } from "../helpers/key-builder";
import { assertTransactionCapacity } from "../helpers/assert-capacity";
import { buildEmailUniquenessActions } from "../email-uniqueness";
import type { TransactionContext } from "./tx-types";
import type { WhereClause } from "../types";

export async function txConsumeOne(
  ctx: TransactionContext,
  args: {
    model: string;
    where: WhereClause[];
  },
): Promise<Record<string, any> | null> {
  const { model, where } = args;
  const tableName = ctx.getTable(model);
  const schema = getKeySchema(model, ctx.config);

  // Block >100 actions
  assertTransactionCapacity(ctx.writeBuffer, 1);

  // Eagerly capture the item (outside transaction — acceptable for
  // short-lived tokens where capture→commit is ~ms)
  const item = await ctx.nativeAdapter.findOne({ model, where });
  if (!item) return null;

  // Build key from the captured item
  const key: Record<string, any> = { [schema.pkField]: item[schema.pkField] };
  if (schema.skField && item[schema.skField] !== undefined) {
    key[schema.skField] = item[schema.skField];
  }

  // Release email-lookup on consumeOne
  if (ctx.config.enableEmailUniqueness && model === "user") {
    ctx.hasEmailUniqueness.value = true;
    const emailActions = buildEmailUniquenessActions("delete", ctx.config, { user: item ?? undefined });
    for (const action of emailActions) {
      ctx.writeBuffer.push(action);
    }
  }

  // Buffer conditional Delete — ensures item still exists at commit
  ctx.writeBuffer.push({
    Delete: {
      TableName: tableName,
      Key: key,
      ConditionExpression: "attribute_exists(#pk)",
      ExpressionAttributeNames: { "#pk": schema.pkField },
      ReturnValuesOnConditionCheckFailure: "ALL_OLD" as const,
    },
  });

  return item;
}
