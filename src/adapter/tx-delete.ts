/**
 * tx-delete handler — extracted from createTransactionWrapper.
 *
 * Buffers a DynamoDB DeleteItem for a single item resolved by where clause.
 * When enableEmailUniqueness and model is "user", additionally reads the
 * user to get the email and buffers an email-lookup Delete action via
 * buildEmailUniquenessActions.
 */

import { getKeySchema } from "../helpers/key-builder";
import { assertTransactionCapacity } from "../helpers/assert-capacity";
import { buildEmailUniquenessActions } from "../email-uniqueness";
import { buildTxKey } from "./tx-key-builder";
import type { TransactionContext } from "./tx-types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Where = any;

export async function txDelete(
  ctx: TransactionContext,
  args: {
    model: string;
    where: Where[];
  },
): Promise<void> {
  const { model, where } = args;
  const tableName = ctx.getTable(model);
  const schema = getKeySchema(model, ctx.config);

  assertTransactionCapacity(ctx.writeBuffer, 1);

  const key = buildTxKey(where, schema, model);

  ctx.writeBuffer.push({
    Delete: {
      TableName: tableName,
      Key: key,
    },
  });

  // If enableEmailUniqueness and model is "user", release email too
  if (ctx.config.enableEmailUniqueness && model === "user") {
    ctx.hasEmailUniqueness.value = true;
    // We need to read the user to get the email
    const user = await ctx.nativeAdapter.findOne({ model, where });
    const emailActions = buildEmailUniquenessActions("delete", ctx.config, { user: user ?? undefined });
    for (const action of emailActions) {
      ctx.writeBuffer.push(action);
    }
  }
}
