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
import { buildUpdateExpression } from "../helpers/update-item";
import { assertTransactionCapacity } from "../helpers/assert-capacity";
import { buildEmailUniquenessActions } from "../email-uniqueness";
import { buildTxKey } from "./tx-key-builder";
import type { TransactionContext } from "./tx-types";
import type { WhereClause } from "../types";

export async function txUpdate(
  ctx: TransactionContext,
  args: {
    model: string;
    where: WhereClause[];
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

    // Build user Update using shared helper (strips PK/SK, Date→ISO).
    // Exclude email from the shared builder — we add it manually below.
    const updateWithoutEmail = { ...update };
    delete updateWithoutEmail.email;

    const {
      setClauses,
      attrNames,
      attrValues,
    } = buildUpdateExpression(updateWithoutEmail, schema.pkField, schema.skField);

    // Append email clause manually using the next available indices
    const emailNameKey = `#n${Object.keys(attrNames).length}`;
    const emailValueKey = `:v${Object.keys(attrValues).length}`;
    attrNames[emailNameKey] = "email";
    attrValues[emailValueKey] = update.email;
    setClauses.push(`${emailNameKey} = ${emailValueKey}`);

    const key = buildTxKey(where, schema, model);

    ctx.writeBuffer.push({
      Update: {
        TableName: tableName,
        Key: key,
        UpdateExpression: `SET ${setClauses.join(", ")}`,
        ExpressionAttributeNames: { ...attrNames, "#pk": schema.pkField },
        ExpressionAttributeValues: attrValues,
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
  const { setClauses, attrNames, attrValues } = buildUpdateExpression(
    update,
    schema.pkField,
    schema.skField,
  );

  const key = buildTxKey(where, schema, model);

  ctx.writeBuffer.push({
    Update: {
      TableName: tableName,
      Key: key,
      UpdateExpression: `SET ${setClauses.join(", ")}`,
      ExpressionAttributeNames: { ...attrNames, "#pk": schema.pkField },
      ExpressionAttributeValues: attrValues,
      ConditionExpression: "attribute_exists(#pk)",
    },
  });

  return preState ? { ...preState, ...update } : { ...update };
}
