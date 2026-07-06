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
import { toDefaultModelName } from "../helpers/model-name";
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

  // Resolve email-lookup actions FIRST so the capacity guard accounts
  // for the real number of buffered actions (model check runs on the
  // default name — better-auth may pass a mapped name).
  let emailActions: ReturnType<typeof buildEmailUniquenessActions> = [];
  if (
    ctx.config.enableEmailUniqueness &&
    toDefaultModelName(ctx.config, model) === "user" &&
    item.email
  ) {
    ctx.hasEmailUniqueness.value = true;
    emailActions = buildEmailUniquenessActions("create", ctx.config, { data: item });
  }

  assertTransactionCapacity(ctx.writeBuffer, 1 + emailActions.length);

  ctx.writeBuffer.push({
    Put: {
      TableName: tableName,
      Item: item,
      ConditionExpression: "attribute_not_exists(#pk)",
      ExpressionAttributeNames: { "#pk": pkField },
    },
  });
  for (const action of emailActions) {
    ctx.writeBuffer.push(action);
  }

  return helpers.transformOutput(item, defaultModelName, select);
}
