/**
 * tx-delete handler — extracted from createTransactionWrapper.
 *
 * Applies the framework where-transform, then buffers a DynamoDB
 * DeleteItem for a single item resolved by where clause.
 * When enableEmailUniqueness and model is "user", additionally reads the
 * user to get the email and buffers an email-lookup Delete action via
 * buildEmailUniquenessActions.
 */

import { writeCondition, snapshotWhere } from "../helpers/write-condition";
import { getKeySchema } from "../helpers/key-builder";
import { assertTransactionCapacity } from "../helpers/assert-capacity";
import { toDefaultModelName } from "../helpers/model-name";
import { buildEmailUniquenessActions } from "../email-uniqueness";
import { tryBuildTxKey } from "./tx-key-builder";
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

  // Non-PK where: pre-resolve through the planner, mirroring tx-update.
  // Missing row is a no-op — buffering a Delete for a row we could not
  // find would either silently succeed (no condition) or fail the whole
  // transaction (with one), and neither matches delete-missing semantics.
  let key = tryBuildTxKey(where, schema);
  if (!key) {
    const found = await ctx.nativeAdapter.findOne({ model: mappedModel, where });
    if (!found) return;
    key = { [schema.pkField]: found[schema.pkField] };
    if (schema.skField) key[schema.skField] = found[schema.skField];
  }

  const current = await ctx.nativeAdapter.findOne({ model: mappedModel, where });
  if (!current) return;

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
    const user = current;
    emailActions = buildEmailUniquenessActions("delete", ctx.config, { user: user ?? undefined });
  }

  assertTransactionCapacity(ctx.writeBuffer, 1 + emailActions.length);

  ctx.writeBuffer.push({
    Delete: {
      TableName: tableName,
      Key: key,
      ...writeCondition(snapshotWhere(current), schema.pkField, current),
    },
  });
  for (const action of emailActions) {
    ctx.writeBuffer.push(action);
  }
}
