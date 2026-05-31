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
import { DynamoAdapterError } from "../errors";
import { resolveDocClient } from "./client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Where = any;

/**
 * Creates a transaction wrapper that buffers writes and flushes
 * atomically via TransactWriteItems.
 *
 * @param nativeAdapter — the adapter methods object (findOne, findMany, count)
 * @param config — adapter config
 * @param getTable — resolve a table name from model name
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
): (cb: (txAdapter: any) => Promise<unknown>) => Promise<unknown> {
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
      create: async (args: { model: string; data: Record<string, any>; select?: string[] }) => {
        const { model, data } = args;
        const tableName = getTable(model);
        const schema = getKeySchema(model, config);
        const pkField = schema.pkField;

        // Convert Date → ISO for DocumentClient marshalling
        const item: Record<string, any> = {};
        for (const [k, v] of Object.entries(data)) {
          item[k] = v instanceof Date ? v.toISOString() : v;
        }

        // Block >100 actions
        if (writeBuffer.length >= 100) {
          throw new DynamoAdapterError(
            "TRANSACTION_FAILED",
            "Cannot buffer more than 100 actions in a single transaction",
          );
        }

        // If enableEmailUniqueness and model is "user", buffer email-lookup too
        if (config.enableEmailUniqueness && model === "user" && data.email) {
          hasEmailUniqueness = true;
          const emailLower = (data.email as string).toLowerCase();

          // User put
          writeBuffer.push({
            Put: {
              TableName: tableName,
              Item: item,
              ConditionExpression: "attribute_not_exists(#pk)",
              ExpressionAttributeNames: { "#pk": pkField },
            },
          });

          // Email-lookup put
          const emailTable = config.tables.emailLookups;
          if (!emailTable) {
            throw new DynamoAdapterError(
              "MISSING_TABLE",
              "enableEmailUniqueness requires tables.emailLookups to be configured",
            );
          }
          writeBuffer.push({
            Put: {
              TableName: emailTable,
              Item: {
                email: emailLower,
                userId: data.id,
              },
              ConditionExpression: "attribute_not_exists(#pk)",
              ExpressionAttributeNames: { "#pk": "email" },
            },
          });
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

        return data;
      },

      // ── update ───────────────────────────────────────────
      update: async (args: {
        model: string;
        where: Where[];
        update: Record<string, any>;
      }) => {
        const { model, where, update } = args;
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
          const oldEmailLower = (preState.email as string)?.toLowerCase();
          const newEmailLower = (update.email as string).toLowerCase();
          const userId = preState.id as string;
          const emailTable = config.tables.emailLookups;

          if (!emailTable) {
            throw new DynamoAdapterError(
              "MISSING_TABLE",
              "enableEmailUniqueness requires tables.emailLookups to be configured",
            );
          }

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
              ExpressionAttributeNames: names,
              ExpressionAttributeValues: values,
            },
          });

          // Delete old email-lookup
          if (oldEmailLower) {
            writeBuffer.push({
              Delete: {
                TableName: emailTable,
                Key: { email: oldEmailLower },
              },
            });
          }

          // Put new email-lookup
          writeBuffer.push({
            Put: {
              TableName: emailTable,
              Item: {
                email: newEmailLower,
                userId,
              },
              ConditionExpression: "attribute_not_exists(#pk)",
              ExpressionAttributeNames: { "#pk": "email" },
            },
          });

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
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
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
        const { model, where, update } = args;
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

        const setClauses: string[] = [];
        const values: Record<string, any>[] = [];

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
          if (user?.email) {
            const emailTable = config.tables.emailLookups;
            if (!emailTable) {
              throw new DynamoAdapterError(
                "MISSING_TABLE",
                "enableEmailUniqueness requires tables.emailLookups to be configured",
              );
            }
            const emailLower = (user.email as string).toLowerCase();
            writeBuffer.push({
              Delete: {
                TableName: emailTable,
                Key: { email: emailLower },
              },
            });
          }
        }
      },

      // ── deleteMany ───────────────────────────────────────
      deleteMany: async (args: { model: string; where: Where[] }) => {
        const { model, where } = args;
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

// ── Token generator for idempotency ───────────────────────────

let _crypto: any;
function generateToken(): string {
  if (!_crypto) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      _crypto = require("crypto");
    } catch {
      _crypto = {
        randomUUID() {
          return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
            /[xy]/g,
            (c: string) => {
              const r = (Math.random() * 16) | 0;
              const v = c === "x" ? r : (r & 0x3) | 0x8;
              return v.toString(16);
            },
          );
        },
      };
    }
  }
  return _crypto.randomUUID();
}
