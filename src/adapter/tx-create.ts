/**
 * tx-create handler — extracted from createTransactionWrapper.
 *
 * Buffers a DynamoDB PutItem with attribute_not_exists guard.
 * When enableEmailUniqueness and model is "user", additionally
 * buffers an email-lookup Put via buildEmailUniquenessActions.
 *
 * Returns the created item (after transformOutput).
 */

import { getKeySchema } from "../helpers/key-builder";
import { assertTransactionCapacity } from "../helpers/assert-capacity";
import { buildEmailUniquenessActions } from "../email-uniqueness";
import type { TransactionContext } from "./tx-types";

export async function txCreate(
  ctx: TransactionContext,
  args: {
    model: string;
    data: Record<string, any>;
    select?: string[];
    forceAllowId?: boolean;
  },
): Promise<Record<string, any>> {
  const { model, data: unsafeData, select, forceAllowId } = args;
  const helpers = ctx.getHelpers();
  const defaultModelName = helpers.getDefaultModelName(model);

  // Mirror the framework's non-transactional `create` path: run
  // input through `transformInput` so the adapter sees the same
  // shape it would outside a transaction (id generated, defaults
  // applied, fieldName mapping, Date → ISO via customTransformInput).
  const item = (await helpers.transformInput(
    unsafeData,
    defaultModelName,
    "create",
    forceAllowId ?? true,
  )) as Record<string, any>;

  const tableName = ctx.getTable(model);
  const schema = getKeySchema(model, ctx.config);
  const pkField = schema.pkField;

  assertTransactionCapacity(ctx.writeBuffer, 1);

  // If enableEmailUniqueness and model is "user", buffer email-lookup too
  if (ctx.config.enableEmailUniqueness && model === "user" && item.email) {
    ctx.hasEmailUniqueness.value = true;

    // User put
    ctx.writeBuffer.push({
      Put: {
        TableName: tableName,
        Item: item,
        ConditionExpression: "attribute_not_exists(#pk)",
        ExpressionAttributeNames: { "#pk": pkField },
      },
    });

    // Email-lookup actions via buildEmailUniquenessActions
    const emailActions = buildEmailUniquenessActions("create", ctx.config, { data: item });
    for (const action of emailActions) {
      ctx.writeBuffer.push(action);
    }
  } else {
    ctx.writeBuffer.push({
      Put: {
        TableName: tableName,
        Item: item,
        ConditionExpression: "attribute_not_exists(#pk)",
        ExpressionAttributeNames: { "#pk": pkField },
      },
    });
  }

  return helpers.transformOutput(item, defaultModelName, select);
}
