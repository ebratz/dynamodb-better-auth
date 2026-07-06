/**
 * tx-delete handler — extracted from createTransactionWrapper.
 *
 * Applies the framework where-transform, then buffers a DynamoDB
 * DeleteItem for a single item resolved by where clause.
 * When enableEmailUniqueness and model is "user", additionally reads the
 * user to get the email and buffers an email-lookup Delete action via
 * buildEmailUniquenessActions.
 */

import { getKeySchema } from "../helpers/key-builder";
import { assertTransactionCapacity } from "../helpers/assert-capacity";
import { toDefaultModelName } from "../helpers/model-name";
import { buildEmailUniquenessActions } from "../email-uniqueness";
import { buildTxKey } from "./tx-key-builder";
import type { TransactionContext } from "./tx-types";
import type { WhereClause } from "../types";

export async function txDelete(
  ctx: TransactionContext,
  args: {
    model: string;
    where: WhereClause[];
  },
): Promise<void> {
  const { model } = args;
  const helpers = ctx.getHelpers();
  const mappedModel = helpers.getModelName?.(model) ?? model;
  const where = (helpers.transformWhereClause?.({
    model,
    where: args.where,
    action: "delete",
  }) ?? args.where) as WhereClause[];

  const tableName = ctx.getTable(model);
  const schema = getKeySchema(model, ctx.config);

  const key = buildTxKey(where, schema, model);

  const isUserModel =
    ctx.config.enableEmailUniqueness &&
    toDefaultModelName(ctx.config, model) === "user";

  // If enableEmailUniqueness and model is "user", release email too.
  // Resolve the email actions BEFORE the capacity check so the guard
  // accounts for the real number of buffered actions.
  let emailActions: ReturnType<typeof buildEmailUniquenessActions> = [];
  if (isUserModel) {
    ctx.hasEmailUniqueness.value = true;
    // We need to read the user to get the email
    const user = await ctx.nativeAdapter.findOne({ model: mappedModel, where });
    emailActions = buildEmailUniquenessActions("delete", ctx.config, { user: user ?? undefined });
  }

  assertTransactionCapacity(ctx.writeBuffer, 1 + emailActions.length);

  ctx.writeBuffer.push({
    Delete: {
      TableName: tableName,
      Key: key,
    },
  });
  for (const action of emailActions) {
    ctx.writeBuffer.push(action);
  }
}
