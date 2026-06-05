/**
 * tx-update handler — extracted from createTransactionWrapper.
 *
 * Eagerly reads pre-state via findOne (non-transactional), then buffers
 * an UpdateItem with ConditionExpression attribute_exists. When
 * enableEmailUniqueness and model is "user" with an email change,
 * additionally buffers email-lookup Delete + Put actions via
 * buildEmailUniquenessActions.
 *
 * Returns the merged preState + update, or null if no item found.
 */

import { getKeySchema } from "../helpers/key-builder";
import { buildExpressionNames } from "../helpers/expression-names";
import { assertTransactionCapacity } from "../helpers/assert-capacity";
import { buildEmailUniquenessActions } from "../email-uniqueness";
import { buildTxKey } from "./tx-key-builder";
import type { TransactionContext } from "./tx-types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Where = any;

export async function txUpdate(
  ctx: TransactionContext,
  args: {
    model: string;
    where: Where[];
    update: Record<string, any>;
  },
): Promise<Record<string, any> | null> {
  const { model, where, update: unsafeUpdate } = args;
  const helpers = ctx.getHelpers();
  const defaultModelName = helpers.getDefaultModelName(model);

  // Run the patch through transformInput so onUpdate fields
  // (e.g. `updatedAt`), field-name mapping, and Date → ISO
  // conversion happen exactly like the non-tx update path.
  const update = (await helpers.transformInput(
    unsafeUpdate,
    defaultModelName,
    "update",
  )) as Record<string, any>;

  const tableName = ctx.getTable(model);
  const schema = getKeySchema(model, ctx.config);

  assertTransactionCapacity(ctx.writeBuffer, 1);

  // Eagerly read pre-state for honest return value
  const preState = await ctx.nativeAdapter.findOne({ model, where });

  // Handle email change with uniqueness
  if (
    ctx.config.enableEmailUniqueness &&
    model === "user" &&
    update.email !== undefined &&
    preState
  ) {
    ctx.hasEmailUniqueness.value = true;

    // Build user Update
    const { names, toRef } = buildExpressionNames(
      Object.keys(update).filter((k) => k !== "email"),
    );

    const setClauses: string[] = [];
    const values: Record<string, any> = {};

    let vi = 0;
    for (const [field, value] of Object.entries(update)) {
      if (field === "email") continue;
      const vk = `:v${vi}`;
      values[vk] = value;
      setClauses.push(`${toRef(field)} = ${vk}`);
      vi++;
    }
    // Always set email
    const emailVk = `:v${vi}`;
    values[emailVk] = update.email;
    setClauses.push(`${toRef("email")} = ${emailVk}`);

    const key = buildTxKey(where, schema, model);

    ctx.writeBuffer.push({
      Update: {
        TableName: tableName,
        Key: key,
        UpdateExpression: `SET ${setClauses.join(", ")}`,
        ExpressionAttributeNames: { ...names, "#pk": schema.pkField },
        ExpressionAttributeValues: values,
        ConditionExpression: "attribute_exists(#pk)",
      },
    });

    // Email-lookup actions via buildEmailUniquenessActions
    const emailActions = buildEmailUniquenessActions("updateEmail", ctx.config, {
      user: preState,
      oldEmail: preState.email as string,
      newEmail: update.email,
    });
    for (const action of emailActions) {
      ctx.writeBuffer.push(action);
    }

    return preState ? { ...preState, ...update } : { ...update };
  }

  // Standard update
  const { names, toRef } = buildExpressionNames(Object.keys(update));

  const setClauses: string[] = [];
  const values: Record<string, any> = {};

  let vi = 0;
  for (const [field, value] of Object.entries(update)) {
    const vk = `:v${vi}`;
    values[vk] = value;
    setClauses.push(`${toRef(field)} = ${vk}`);
    vi++;
  }

  const key = buildTxKey(where, schema, model);

  ctx.writeBuffer.push({
    Update: {
      TableName: tableName,
      Key: key,
      UpdateExpression: `SET ${setClauses.join(", ")}`,
      ExpressionAttributeNames: { ...names, "#pk": schema.pkField },
      ExpressionAttributeValues: values,
      ConditionExpression: "attribute_exists(#pk)",
    },
  });

  return preState ? { ...preState, ...update } : { ...update };
}
