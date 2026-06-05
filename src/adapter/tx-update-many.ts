/**
 * tx-update-many handler — extracted from createTransactionWrapper.
 *
 * Finds all matching items via findMany, then buffers an Update action
 * per item with field-level SET expressions. Returns the count.
 */

import { buildUpdateExpression } from "../helpers/update-item";
import { getKeySchema } from "../helpers/key-builder";
import { assertTransactionCapacity } from "../helpers/assert-capacity";
import type { TransactionContext } from "./tx-types";
import type { WhereClause } from "../types";

export async function txUpdateMany(
  ctx: TransactionContext,
  args: {
    model: string;
    where: WhereClause[];
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

  const { setClauses, attrNames, attrValues: baseAttrValues } =
    buildUpdateExpression(update, schema.pkField, schema.skField);

  // Each item gets its own Update with a cloned ExpressionAttributeValues map.
  // attrNames is shared (identical for every item); attrValues must be unique
  // per command to avoid DynamoDB reference-collision errors.
  for (const item of items) {
    const itemValues = { ...baseAttrValues };

    const key: Record<string, any> = { [schema.pkField]: item[schema.pkField] };
    if (schema.skField && item[schema.skField] !== undefined) {
      key[schema.skField] = item[schema.skField];
    }

    ctx.writeBuffer.push({
      Update: {
        TableName: tableName,
        Key: key,
        UpdateExpression: `SET ${setClauses.join(", ")}`,
        ExpressionAttributeNames: attrNames,
        ExpressionAttributeValues: itemValues,
      },
    });
  }

  return items.length;
}
