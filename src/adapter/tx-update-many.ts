/**
 * tx-update-many handler — extracted from createTransactionWrapper.
 *
 * Finds all matching items via findMany, then buffers an Update action
 * per item with field-level SET expressions. Returns the count.
 */

import { buildExpressionNames } from "../helpers/expression-names";
import { getKeySchema } from "../helpers/key-builder";
import { assertTransactionCapacity } from "../helpers/assert-capacity";
import type { TransactionContext } from "./tx-types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Where = any;

export async function txUpdateMany(
  ctx: TransactionContext,
  args: {
    model: string;
    where: Where[];
    update: Record<string, any>;
  },
): Promise<number> {
  const { model, where, update: unsafeUpdate } = args;
  const helpers = ctx.getHelpers();
  const defaultModelName = helpers.getDefaultModelName(model);
  const update = (await helpers.transformInput(
    unsafeUpdate,
    defaultModelName,
    "update",
  )) as Record<string, any>;

  const tableName = ctx.getTable(model);
  const schema = getKeySchema(model, ctx.config);

  // Find all matching items
  const items = await ctx.nativeAdapter.findMany({ model, where });

  if (items.length === 0) {
    return 0;
  }

  // Block >100 actions
  assertTransactionCapacity(ctx.writeBuffer, items.length);

  const { names, toRef } = buildExpressionNames(Object.keys(update));

  // Each item gets its own Update expression with its own values
  for (const item of items) {
    const itemValues: Record<string, any> = {};
    const itemClauses: string[] = [];
    let vi = 0;
    for (const [field, value] of Object.entries(update)) {
      const vk = `:v${vi}`;
      itemValues[vk] = value;
      itemClauses.push(`${toRef(field)} = ${vk}`);
      vi++;
    }

    const key: Record<string, any> = { [schema.pkField]: item[schema.pkField] };
    if (schema.skField && item[schema.skField] !== undefined) {
      key[schema.skField] = item[schema.skField];
    }

    ctx.writeBuffer.push({
      Update: {
        TableName: tableName,
        Key: key,
        UpdateExpression: `SET ${itemClauses.join(", ")}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: itemValues,
      },
    });
  }

  return items.length;
}
