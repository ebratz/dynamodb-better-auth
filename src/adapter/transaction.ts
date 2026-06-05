/**
 * Transaction wrapper — per DESIGN.md §6 + accepted R3, R4.
 *
 * Hybrid buffer pattern: reads go directly to DynamoDB (non-transactional),
 * writes are buffered and flushed as a single TransactWriteItems at commit.
 *
 * - update eagerly reads pre-state via findOne, then buffers Update.
 * - consumeOne eagerly captures the item, then buffers conditional Delete.
 * - >100 buffered actions throws before sending.
 * - TransactionCanceledException → parsed CancellationReasons → error.
 * - When enableEmailUniqueness: tx.create("user") buffers email-lookup Put too.
 *
 * Exposes only reads the callback needs:
 *   findOne, findMany, count → native adapter (non-transactional).
 *   create, update, updateMany, delete, deleteMany, consumeOne → buffered.
 */

import {
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBAdapterConfig, KeySchema } from "../types";
import { getKeySchema } from "../helpers/key-builder";
import { buildExpressionNames } from "../helpers/expression-names";
import { generateToken } from "../helpers/uuid";
import { DynamoAdapterError } from "../errors";
import { resolveDocClient } from "./client";
import { buildEmailUniquenessActions } from "../email-uniqueness";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Where = any;

/**
 * Helpers exposed by better-auth's `createAdapterFactory` to the
 * `adapter` callback. We need `transformInput`/`transformOutput`/
 * `getDefaultModelName` here so that writes buffered inside a
 * transaction get the same id-generation, default-value, and
 * field-name mapping treatment the framework applies on the
 * non-transactional path.
 */
export interface TransactionFactoryHelpers {
  transformInput: (
    data: Record<string, unknown>,
    defaultModelName: string,
    action: "create" | "update",
    forceAllowId?: boolean,
  ) => Promise<Record<string, unknown>>;
  transformOutput: (
    data: Record<string, unknown>,
    defaultModelName: string,
    select?: string[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    join?: any,
  ) => Promise<Record<string, unknown>>;
  getDefaultModelName: (model: string) => string;
}

/**
 * Late-bound holder for factory helpers. `createTransactionWrapper`
 * is constructed before the framework invokes the `adapter` callback,
 * so we hand it a ref that the factory populates synchronously inside
 * that callback. By the time any transaction runs, `current` is set.
 */
export interface TransactionHelpersRef {
  current: TransactionFactoryHelpers | null;
}

/**
 * Creates a transaction wrapper that buffers writes and flushes
 * atomically via TransactWriteItems.
 *
 * @param nativeAdapter — the adapter methods object (findOne, findMany, count)
 * @param config — adapter config
 * @param getTable — resolve a table name from model name
 * @param helpersRef — late-bound factory helpers (transformInput, ...)
 */
export function createTransactionWrapper(
  nativeAdapter: {
    findOne: (args: { model: string; where: Where[] }) => Promise<Record<string, any> | null>;
    findMany: (args: { model: string; where: Where[]; limit?: number; sortBy?: any; offset?: number }) => Promise<Record<string, any>[]>;
    count: (args: { model: string; where?: Where[] }) => Promise<number>;
    [key: string]: any;
  },
  config: DynamoDBAdapterConfig,
  getTable: (model: string) => string,
  helpersRef?: TransactionHelpersRef,
): (cb: (txAdapter: any) => Promise<unknown>) => Promise<unknown> {
  // Identity fallback: when the wrapper is constructed outside the factory
  // (e.g. low-level unit tests), no framework helpers are available. We
  // pass data through unchanged so the buffered Put/Update mirrors the
  // exact bytes the caller supplied — preserving the original primitive
  // contract this module had before transformInput integration.
  const identityHelpers: TransactionFactoryHelpers = {
    transformInput: async (data) => data,
    transformOutput: async (data) => data,
    getDefaultModelName: (model) => model,
  };
  const requireHelpers = (): TransactionFactoryHelpers =>
    helpersRef?.current ?? identityHelpers;
  return async (cb: (txAdapter: any) => Promise<unknown>): Promise<unknown> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const writeBuffer: any[] = [];
    let hasEmailUniqueness = false;
    const docClient = resolveDocClient(config.client);

    // ── txAdapter ────────────────────────────────────────────
    const txAdapter: Record<string, any> = {
      // ── Reads (non-transactional, go directly to DDB) ────
      findOne: nativeAdapter.findOne,
      findMany: nativeAdapter.findMany,
      count: nativeAdapter.count,

      // ── create ───────────────────────────────────────────
      create: async (args: {
        model: string;
        data: Record<string, any>;
        select?: string[];
        forceAllowId?: boolean;
      }) => {
        const { model, data: unsafeData, select, forceAllowId } = args;
        const helpers = requireHelpers();
        const defaultModelName = helpers.getDefaultModelName(model);

        // Mirror the framework's non-transactional `create` path: run
        // input through `transformInput` so the adapter sees the same
        // shape it would outside a transaction (id generated, defaults
        // applied, fieldName mapping, Date → ISO via customTransformInput).
        // better-auth's `createWithHooks` always passes forceAllowId: true,
        // so the framework only respects a caller-supplied id when one
        // is present.
        const item = (await helpers.transformInput(
          unsafeData,
          defaultModelName,
          "create",
          forceAllowId ?? true,
        )) as Record<string, any>;

        const tableName = getTable(model);
        const schema = getKeySchema(model, config);
        const pkField = schema.pkField;

        // Block >100 actions
        if (writeBuffer.length >= 100) {
          throw new DynamoAdapterError(
            "TRANSACTION_FAILED",
            "Cannot buffer more than 100 actions in a single transaction",
          );
        }

        // If enableEmailUniqueness and model is "user", buffer email-lookup too
        if (config.enableEmailUniqueness && model === "user" && item.email) {
          hasEmailUniqueness = true;

          // User put
          writeBuffer.push({
            Put: {
              TableName: tableName,
              Item: item,
              ConditionExpression: "attribute_not_exists(#pk)",
              ExpressionAttributeNames: { "#pk": pkField },
            },
          });

          // Email-lookup actions via buildEmailUniquenessActions
          const emailActions = buildEmailUniquenessActions("create", config, { data: item });
          for (const action of emailActions) {
            writeBuffer.push(action);
          }
        } else {
          writeBuffer.push({
            Put: {
              TableName: tableName,
              Item: item,
              ConditionExpression: "attribute_not_exists(#pk)",
              ExpressionAttributeNames: { "#pk": pkField },
            },
          });
        }

        return helpers.transformOutput(item, defaultModelName, select);
      },

      // ── update ───────────────────────────────────────────
      update: async (args: {
        model: string;
        where: Where[];
        update: Record<string, any>;
      }) => {
        const { model, where, update: unsafeUpdate } = args;
        const helpers = requireHelpers();
        const defaultModelName = helpers.getDefaultModelName(model);

        // Run the patch through transformInput so onUpdate fields
        // (e.g. `updatedAt`), field-name mapping, and Date → ISO
        // conversion happen exactly like the non-tx update path.
        const update = (await helpers.transformInput(
          unsafeUpdate,
          defaultModelName,
          "update",
        )) as Record<string, any>;

        const tableName = getTable(model);
        const schema = getKeySchema(model, config);

        // Block >100 actions
        if (writeBuffer.length >= 100) {
          throw new DynamoAdapterError(
            "TRANSACTION_FAILED",
            "Cannot buffer more than 100 actions in a single transaction",
          );
        }

        // Eagerly read pre-state for honest return value
        const preState = await nativeAdapter.findOne({ model, where });

        // Handle email change with uniqueness
        if (
          config.enableEmailUniqueness &&
          model === "user" &&
          update.email !== undefined &&
          preState
        ) {
          hasEmailUniqueness = true;

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

          writeBuffer.push({
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
          const emailActions = buildEmailUniquenessActions("updateEmail", config, {
            user: preState,
            oldEmail: preState.email as string,
            newEmail: update.email,
          });
          for (const action of emailActions) {
            writeBuffer.push(action);
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

        writeBuffer.push({
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
      },

      // ── updateMany ───────────────────────────────────────
      updateMany: async (args: {
        model: string;
        where: Where[];
        update: Record<string, any>;
      }) => {
        const { model, where, update: unsafeUpdate } = args;
        const helpers = requireHelpers();
        const defaultModelName = helpers.getDefaultModelName(model);
        const update = (await helpers.transformInput(
          unsafeUpdate,
          defaultModelName,
          "update",
        )) as Record<string, any>;

        const tableName = getTable(model);
        const schema = getKeySchema(model, config);

        // Find all matching items
        const items = await nativeAdapter.findMany({ model, where });

        if (items.length === 0) {
          return 0;
        }

        // Block >100 actions
        if (writeBuffer.length + items.length > 100) {
          throw new DynamoAdapterError(
            "TRANSACTION_FAILED",
            "Cannot buffer more than 100 actions in a single transaction",
          );
        }

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

          writeBuffer.push({
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
      },

      // ── delete ───────────────────────────────────────────
      delete: async (args: { model: string; where: Where[] }) => {
        const { model, where } = args;
        const tableName = getTable(model);
        const schema = getKeySchema(model, config);

        // Block >100 actions
        if (writeBuffer.length >= 100) {
          throw new DynamoAdapterError(
            "TRANSACTION_FAILED",
            "Cannot buffer more than 100 actions in a single transaction",
          );
        }

        const key = buildTxKey(where, schema, model);

        writeBuffer.push({
          Delete: {
            TableName: tableName,
            Key: key,
          },
        });

        // If enableEmailUniqueness and model is "user", release email too
        if (config.enableEmailUniqueness && model === "user") {
          hasEmailUniqueness = true;
          // We need to read the user to get the email
          const user = await nativeAdapter.findOne({ model, where });
          const emailActions = buildEmailUniquenessActions("delete", config, { user: user ?? undefined });
          for (const action of emailActions) {
            writeBuffer.push(action);
          }
        }
      },

      // ── deleteMany ───────────────────────────────────────
      deleteMany: async (args: { model: string; where: Where[] }) => {
        const { model, where } = args;
        if (!where || where.length === 0) return 0;

        const tableName = getTable(model);
        const schema = getKeySchema(model, config);

        // Find all matching items
        const items = await nativeAdapter.findMany({ model, where });

        if (items.length === 0) {
          return 0;
        }

        // Block >100 actions
        if (writeBuffer.length + items.length > 100) {
          throw new DynamoAdapterError(
            "TRANSACTION_FAILED",
            "Cannot buffer more than 100 actions in a single transaction",
          );
        }

        for (const item of items) {
          const key: Record<string, any> = { [schema.pkField]: item[schema.pkField] };
          if (schema.skField && item[schema.skField] !== undefined) {
            key[schema.skField] = item[schema.skField];
          }

          writeBuffer.push({
            Delete: {
              TableName: tableName,
              Key: key,
            },
          });
        }

        return items.length;
      },

      // ── consumeOne ───────────────────────────────────────
      consumeOne: async (args: { model: string; where: Where[] }) => {
        const { model, where } = args;
        const tableName = getTable(model);
        const schema = getKeySchema(model, config);

        // Block >100 actions
        if (writeBuffer.length >= 100) {
          throw new DynamoAdapterError(
            "TRANSACTION_FAILED",
            "Cannot buffer more than 100 actions in a single transaction",
          );
        }

        // Eagerly capture the item (outside transaction — acceptable for
        // short-lived tokens where capture→commit is ~ms)
        const item = await nativeAdapter.findOne({ model, where });
        if (!item) return null;

        // Build key from the captured item
        const key: Record<string, any> = { [schema.pkField]: item[schema.pkField] };
        if (schema.skField && item[schema.skField] !== undefined) {
          key[schema.skField] = item[schema.skField];
        }

        // Release email-lookup on consumeOne
        if (config.enableEmailUniqueness && model === "user") {
          hasEmailUniqueness = true;
          const emailActions = buildEmailUniquenessActions("delete", config, { user: item ?? undefined });
          for (const action of emailActions) {
            writeBuffer.push(action);
          }
        }

        // Buffer conditional Delete — ensures item still exists at commit
        writeBuffer.push({
          Delete: {
            TableName: tableName,
            Key: key,
            ConditionExpression: "attribute_exists(#pk)",
            ExpressionAttributeNames: { "#pk": schema.pkField },
            ReturnValuesOnConditionCheckFailure: "ALL_OLD" as const,
          },
        });

        return item;
      },
    };

    // ── Execute callback ──────────────────────────────────────
    const result = await cb(txAdapter);

    // ── Flush buffered writes ─────────────────────────────────
    if (writeBuffer.length > 0) {
      try {
        await docClient.send(
          new TransactWriteCommand({
            TransactItems: writeBuffer,
            ClientRequestToken: generateToken(),
          }),
        );
      } catch (err: any) {
        if (err.name === "TransactionCanceledException") {
          const reasons = err.CancellationReasons ?? [];

          // Check for email uniqueness violations
          if (hasEmailUniqueness) {
            // Look through cancellation reasons for email-lookup ConditionalCheckFailed
            for (let i = 0; i < reasons.length; i++) {
              if (reasons[i]?.Code === "ConditionalCheckFailed") {
                // Try to determine if it's an email collision by checking table
                // The email-lookup puts have "#pk": "email" pattern
                const wi = writeBuffer[i];
                if (
                  wi?.Put?.ExpressionAttributeNames?.["#pk"] === "email" ||
                  (wi?.Put?.TableName && wi.Put.TableName === config.tables.emailLookups)
                ) {
                  throw new DynamoAdapterError(
                    "EMAIL_EXISTS",
                    "Email is already registered",
                    err,
                  );
                }
              }
            }
          }

          // Parse all reasons
          const parsedReasons = reasons.map((r: any, i: number) => ({
            Code: r.Code,
            Message: r.Message,
            index: i,
          }));

          throw new DynamoAdapterError(
            "TRANSACTION_FAILED",
            `Transaction cancelled: ${JSON.stringify(parsedReasons)}`,
            err,
          );
        }
        throw err;
      }
    }

    return result;
  };
}

// ── Key builder for transaction operations ───────────────────

function buildTxKey(
  where: Where[],
  schema: KeySchema,
  model: string,
): Record<string, any> {
  const pkEq = where.find(
    (w: Where) => w.field === schema.pkField && (!w.operator || w.operator === "eq"),
  );
  if (!pkEq) {
    throw new DynamoAdapterError(
      "INVALID_WHERE",
      `Transaction operation requires PK field "${schema.pkField}" in where clause for model "${model}"`,
    );
  }

  const key: Record<string, any> = { [schema.pkField]: pkEq.value };

  if (schema.skField) {
    const skEq = where.find(
      (w: Where) => w.field === schema.skField && (!w.operator || w.operator === "eq"),
    );
    if (!skEq) {
      throw new DynamoAdapterError(
        "INVALID_WHERE",
        `Transaction operation requires SK field "${schema.skField}" in where clause for model "${model}"`,
      );
    }
    key[schema.skField] = skEq.value;
  }

  return key;
}


