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
 *
 * All buffered handlers are extracted to tx-*.ts for independent testability.
 */

import {
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBAdapterConfig } from "../types";
import { generateToken } from "../helpers/uuid";
import { DynamoAdapterError } from "../errors";
import { resolveDocClient } from "./client";

import { txCreate } from "./tx-create";
import { txUpdate } from "./tx-update";
import { txUpdateMany } from "./tx-update-many";
import { txDelete } from "./tx-delete";
import { txDeleteMany } from "./tx-delete-many";
import { txConsumeOne } from "./tx-consume-one";

import {
  type TransactionFactoryHelpers,
  type TransactionContext,
} from "./tx-types";

// Re-exported for factory.ts
export { type TransactionFactoryHelpers, type TransactionHelpersRef } from "./tx-types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Where = any;

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
  helpersRef?: { current: TransactionFactoryHelpers | null },
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
  const getHelpers = (): TransactionFactoryHelpers =>
    helpersRef?.current ?? identityHelpers;

  return async (cb: (txAdapter: any) => Promise<unknown>): Promise<unknown> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const writeBuffer: any[] = [];
    const hasEmailUniqueness = { value: false };
    const docClient = resolveDocClient(config.client);

    // ── Shared context for all extracted handlers ────────────
    const ctx: TransactionContext = {
      writeBuffer,
      nativeAdapter,
      config,
      getTable,
      getHelpers,
      hasEmailUniqueness,
    };

    // ── txAdapter ────────────────────────────────────────────
    const txAdapter: Record<string, any> = {
      // ── Reads (non-transactional, go directly to DDB) ────
      findOne: nativeAdapter.findOne,
      findMany: nativeAdapter.findMany,
      count: nativeAdapter.count,

      // ── Buffered writes (extracted handlers) ──────────────
      create:     (args: any) => txCreate(ctx, args),
      update:     (args: any) => txUpdate(ctx, args),
      updateMany: (args: any) => txUpdateMany(ctx, args),
      delete:     (args: any) => txDelete(ctx, args),
      deleteMany: (args: any) => txDeleteMany(ctx, args),
      consumeOne: (args: any) => txConsumeOne(ctx, args),
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
          if (hasEmailUniqueness.value) {
            // Look through cancellation reasons for email-lookup ConditionalCheckFailed
            for (let i = 0; i < reasons.length; i++) {
              if (reasons[i]?.Code === "ConditionalCheckFailed") {
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
