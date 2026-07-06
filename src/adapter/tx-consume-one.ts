/**
 * tx-consume-one handler — extracted from createTransactionWrapper.
 *
 * Atomically reads and deletes a single item:
 *  1. Applies the framework where-transform, eagerly captures the item
 *     via nativeAdapter.findOne.
 *  2. Releases email-lookup if email uniqueness is enabled.
 *  3. Buffers a conditional Delete (attribute_exists) to prevent
 *     double-consumption at commit time.
 *
 * Returns the captured item, or null if none found. Note the returned
 * item is captured BEFORE commit — build further transactional writes
 * from it, but don't perform irreversible non-transactional side effects
 * until the transaction resolves.
 */

import { getKeySchema } from "../helpers/key-builder";
import { assertTransactionCapacity } from "../helpers/assert-capacity";
import { toDefaultModelName } from "../helpers/model-name";
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
  const { model } = args;
  const helpers = ctx.getHelpers();
  const mappedModel = helpers.getModelName?.(model) ?? model;
  const where = (helpers.transformWhereClause?.({
    model,
    where: args.where,
    action: "consumeOne",
  }) ?? args.where) as WhereClause[];

  const tableName = ctx.getTable(model);
  const schema = getKeySchema(model, ctx.config);

  // Eagerly capture the item (outside transaction — acceptable for
  // short-lived tokens where capture→commit is ~ms)
  const item = await ctx.nativeAdapter.findOne({ model: mappedModel, where });
  if (!item) return null;

  // Build key from the captured item
  const key: Record<string, any> = { [schema.pkField]: item[schema.pkField] };
  if (schema.skField && item[schema.skField] !== undefined) {
    key[schema.skField] = item[schema.skField];
  }

  // Release email-lookup on consumeOne — resolved before the capacity
  // check so the guard accounts for the real number of actions.
  let emailActions: ReturnType<typeof buildEmailUniquenessActions> = [];
  if (
    ctx.config.enableEmailUniqueness &&
    toDefaultModelName(ctx.config, model) === "user"
  ) {
    ctx.hasEmailUniqueness.value = true;
    emailActions = buildEmailUniquenessActions("delete", ctx.config, { user: item ?? undefined });
  }

  assertTransactionCapacity(ctx.writeBuffer, 1 + emailActions.length);

  for (const action of emailActions) {
    ctx.writeBuffer.push(action);
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
