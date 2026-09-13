/**
 * tx-update-many handler — extracted from createTransactionWrapper.
 *
 * Applies the framework where-transform, finds ALL matching items (no
 * silent 100-row default limit — the fetch is bounded by
 * maxUpdateManyItems, then the transaction capacity guard throws loudly
 * past DynamoDB's 100-action limit), then buffers an Update action per
 * item with field-level SET expressions and an attribute_exists guard
 * (an unconditional Update is an upsert: a row deleted between the read
 * and the commit would be resurrected as a corrupt partial item).
 *
 * Returns the count.
 */

import { writeCondition, snapshotWhere } from "../helpers/write-condition";
import { withTtlAttribute } from "../helpers/ttl";
import { buildUpdateExpression } from "../helpers/update-item";
import { getKeySchema } from "../helpers/key-builder";
import { assertTransactionCapacity } from "../helpers/assert-capacity";
import { DynamoAdapterError } from "../errors";
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
  const { model, update: unsafeUpdate } = args;
  const helpers = ctx.getHelpers();
  const defaultModelName = helpers.getDefaultModelName(model);
  const mappedModel = helpers.getModelName?.(model) ?? model;

  const where = (helpers.transformWhereClause?.({
    model,
    where: args.where,
    action: "updateMany",
  }) ?? args.where) as WhereClause[];

  const update = withTtlAttribute(ctx.config, model, (await helpers.transformInput(
    unsafeUpdate,
    defaultModelName,
    "update",
  )) as Record<string, any>);

  if (ctx.config.enableEmailUniqueness && defaultModelName === "user" && update.email !== undefined) {
    throw new DynamoAdapterError("INVALID_DATA", "Bulk email changes are not supported with email uniqueness. Update users individually.");
  }
  const tableName = ctx.getTable(model);
  const schema = getKeySchema(model, ctx.config);

  // Find ALL matching items. Without an explicit limit the raw findMany
  // applies its 100-row default and silently truncates the operation.
  const maxItems = ctx.config.maxUpdateManyItems ?? 1000;
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
      `tx.updateMany matched more than ${maxItems} items. ` +
        `Refine your where clause or increase maxUpdateManyItems in config.`,
    );
  }

  // Block >100 actions
  assertTransactionCapacity(ctx.writeBuffer, items.length);

  const { setClauses, attrNames, attrValues: baseAttrValues } =
    buildUpdateExpression(update, schema.pkField, schema.skField);

  if (!setClauses.length) return items.length;

  // Each item gets its own Update with a cloned ExpressionAttributeValues map.
  // attrNames is shared (identical for every item); attrValues must be unique
  // per command to avoid DynamoDB reference-collision errors.
  const sharedNames = { ...attrNames, "#pk": schema.pkField };
  for (const item of items) {
    const condition = writeCondition(snapshotWhere(item), schema.pkField, item);
    const itemValues = { ...baseAttrValues, ...condition.ExpressionAttributeValues };

    const key: Record<string, any> = { [schema.pkField]: item[schema.pkField] };
    if (schema.skField && item[schema.skField] !== undefined) {
      key[schema.skField] = item[schema.skField];
    }

    ctx.writeBuffer.push({
      Update: {
        TableName: tableName,
        Key: key,
        UpdateExpression: `SET ${setClauses.join(", ")}`,
        ...condition,
        ExpressionAttributeNames: { ...sharedNames, ...condition.ExpressionAttributeNames },
        ExpressionAttributeValues: itemValues,
        // Prevent upsert-resurrection of rows deleted between the read
        // above and the transaction commit.

      },
    });
  }

  return items.length;
}
