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

import { writeCondition, snapshotWhere } from "../helpers/write-condition";
import { matchesClientFilters } from "../helpers/resolve-item";
import { getKeySchema } from "../helpers/key-builder";
import { buildUpdateExpression, sanitizeForWrite } from "../helpers/update-item";
import { withTtlAttribute } from "../helpers/ttl";
import { assertTransactionCapacity } from "../helpers/assert-capacity";
import { toDefaultModelName } from "../helpers/model-name";
import { buildEmailUniquenessActions } from "../email-uniqueness";
import { tryBuildTxKey } from "./tx-key-builder";
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
  const update = withTtlAttribute(
    ctx.config,
    model,
    (await helpers.transformInput(
      unsafeUpdate,
      defaultModelName,
      "update",
    )) as Record<string, any>,
  );

  const tableName = ctx.getTable(model);
  const schema = getKeySchema(model, ctx.config);
  // Return values must reflect only assignments accepted by DynamoDB.
  delete update[schema.pkField];
  if (schema.skField) delete update[schema.skField];

  // Non-PK where (e.g. oauth-provider updating oauthClient by clientId +
  // clientDiscoveryId inside a transaction): pre-resolve the row through the
  // planner and take the key from the item. Missing row keeps the update
  // contract — return null, buffer nothing.
  let resolvedPreState: Record<string, any> | null | undefined;
  let key = tryBuildTxKey(where, schema);
  if (!key) {
    resolvedPreState = await ctx.nativeAdapter.findOne({ model: mappedModel, where });
    if (!resolvedPreState) return null;
    key = { [schema.pkField]: resolvedPreState[schema.pkField] };
    if (schema.skField) key[schema.skField] = resolvedPreState[schema.skField];
  }

  // ── Read-your-writes: patch a buffered Put from this same tx ──
  const bufferedPut = ctx.writeBuffer.find(
    (a: any) =>
      a.Put &&
      a.Put.TableName === tableName &&
      Object.entries(key).every(([k, v]) => a.Put.Item?.[k] === v),
  );
  if (bufferedPut) {
    if (!matchesClientFilters(bufferedPut.Put.Item, where.map(w => ({ field: w.field, operator: w.operator ?? "eq", value: w.value })))) return null;
    if (ctx.config.enableEmailUniqueness && defaultModelName === "user" && update.email !== undefined) {
      const oldEmail = String(bufferedPut.Put.Item.email).toLowerCase();
      const claim = ctx.writeBuffer.find(action => action.Put?.TableName === ctx.config.tables.emailLookups && action.Put.Item.email === oldEmail && action.Put.Item.userId === bufferedPut.Put.Item.id);
      if (claim) claim.Put.Item.email = String(update.email).toLowerCase();
    }
    Object.assign(bufferedPut.Put.Item, sanitizeForWrite(update));
    return helpers.transformOutput(
      { ...bufferedPut.Put.Item },
      defaultModelName,
    );
  }

  // Eagerly read pre-state for honest return value
  const preState =
    resolvedPreState ??
    (await ctx.nativeAdapter.findOne({ model: mappedModel, where }));

  // Contract: update on a missing record returns null. Buffering the
  // conditional Update anyway would fail the WHOLE transaction at commit.
  if (!preState) return null;

  const condition = writeCondition(snapshotWhere(preState), schema.pkField, preState);

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
        ...condition,
        ExpressionAttributeNames: { ...attrNames, ...condition.ExpressionAttributeNames },
        ExpressionAttributeValues: { ...attrValues, ...condition.ExpressionAttributeValues },
      },
    });
    for (const action of emailActions) {
      ctx.writeBuffer.push(action);
    }

    return helpers.transformOutput({ ...preState, ...update }, defaultModelName);
  }

  // Standard update
  assertTransactionCapacity(ctx.writeBuffer, 1);

  const { setClauses, attrNames, attrValues } = buildUpdateExpression(
    update,
    schema.pkField,
    schema.skField,
  );

  if (!setClauses.length) return helpers.transformOutput(preState, defaultModelName);
  ctx.writeBuffer.push({
    Update: {
      TableName: tableName,
      Key: key,
      UpdateExpression: `SET ${setClauses.join(", ")}`,
      ...condition,
      ExpressionAttributeNames: { ...attrNames, ...condition.ExpressionAttributeNames },
      ExpressionAttributeValues: { ...attrValues, ...condition.ExpressionAttributeValues },
    },
  });

  return helpers.transformOutput({ ...preState, ...update }, defaultModelName);
}
