/**
 * tx-update handler — extracted from createTransactionWrapper.
 *
 * Applies the framework where-transform, eagerly reads pre-state via
 * findOne (non-transactional), then buffers an UpdateItem with
 * ConditionExpression attribute_exists.
 *
 * Missing row → returns null and buffers NOTHING (contract: update on a
 * missing record is null; buffering a doomed conditional Update would
 * cancel the entire transaction at commit).
 *
 * Read-your-writes special case: when the target row was created earlier
 * in the SAME transaction (a buffered Put), the update is applied onto the
 * buffered item in place instead of reading DynamoDB.
 *
 * When enableEmailUniqueness and model is "user" with an email change,
 * additionally buffers email-lookup Delete + Put actions via
 * buildEmailUniquenessActions.
 */

import { getKeySchema } from "../helpers/key-builder";
import { buildUpdateExpression, sanitizeForWrite } from "../helpers/update-item";
import { assertTransactionCapacity } from "../helpers/assert-capacity";
import { toDefaultModelName } from "../helpers/model-name";
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
  const { model, update: unsafeUpdate } = args;
  const helpers = ctx.getHelpers();
  const defaultModelName = helpers.getDefaultModelName(model);
  const mappedModel = helpers.getModelName?.(model) ?? model;

  // Framework where-transform: field-name mapping, Date/id coercion —
  // the tx callback hands us raw logical where clauses.
  const where = (helpers.transformWhereClause?.({
    model,
    where: args.where,
    action: "update",
  }) ?? args.where) as WhereClause[];

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

  const key = buildTxKey(where, schema, model);

  // ── Read-your-writes: patch a buffered Put from this same tx ──
  const bufferedPut = ctx.writeBuffer.find(
    (a: any) =>
      a.Put &&
      a.Put.TableName === tableName &&
      Object.entries(key).every(([k, v]) => a.Put.Item?.[k] === v),
  );
  if (bufferedPut) {
    Object.assign(bufferedPut.Put.Item, sanitizeForWrite(update));
    return helpers.transformOutput(
      { ...bufferedPut.Put.Item },
      defaultModelName,
    );
  }

  // Eagerly read pre-state for honest return value
  const preState = await ctx.nativeAdapter.findOne({ model: mappedModel, where });

  // Contract: update on a missing record returns null. Buffering the
  // conditional Update anyway would fail the WHOLE transaction at commit.
  if (!preState) return null;

  // Handle email change with uniqueness
  if (
    ctx.config.enableEmailUniqueness &&
    toDefaultModelName(ctx.config, model) === "user" &&
    update.email !== undefined
  ) {
    ctx.hasEmailUniqueness.value = true;

    // Email-lookup actions resolved FIRST so the capacity guard accounts
    // for the real number of buffered actions.
    const emailActions = buildEmailUniquenessActions("updateEmail", ctx.config, {
      user: preState,
      oldEmail: preState.email as string,
      newEmail: update.email,
    });

    assertTransactionCapacity(ctx.writeBuffer, 1 + emailActions.length);

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
    for (const action of emailActions) {
      ctx.writeBuffer.push(action);
    }

    return { ...preState, ...update };
  }

  // Standard update
  assertTransactionCapacity(ctx.writeBuffer, 1);

  const { setClauses, attrNames, attrValues } = buildUpdateExpression(
    update,
    schema.pkField,
    schema.skField,
  );

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

  return { ...preState, ...update };
}
