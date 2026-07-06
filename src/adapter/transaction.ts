/**
 * Transaction wrapper — per DESIGN.md §6 + accepted R3, R4.
 *
 * Hybrid buffer pattern: reads go directly to DynamoDB (non-transactional),
 * writes are buffered and flushed as a single TransactWriteItems at commit.
 *
 * Contract note (DBTransactionAdapter = Omit<DBAdapter, "transaction">):
 * better-auth hands the tx callback RAW logical model names and where
 * clauses — the same input its framework-level adapter receives — and
 * `runWithTransaction` installs this object as the ambient adapter for
 * entire request flows (e.g. all of sign-up). Every read here therefore
 * applies the framework's transformWhereClause / model-name mapping on the
 * way in and transformOutput on the way out, mirroring the non-tx pipeline.
 *
 * KNOWN LIMITATION — no read-your-writes: reads query DynamoDB directly and
 * cannot see writes still sitting in the buffer. txUpdate compensates for
 * the common create-then-update case by patching a buffered Put in place;
 * everything else sees pre-transaction state until commit.
 *
 * - update eagerly reads pre-state via findOne, then buffers Update.
 * - consumeOne eagerly captures the item, then buffers conditional Delete.
 * - >100 buffered actions throws before sending (assertTransactionCapacity
 *   in each handler).
 * - Two buffered actions on the same item throw at buffer/flush time with a
 *   clear error (TransactWriteItems would reject the request opaquely).
 * - TransactionCanceledException → CancellationReasons mapped to distinct
 *   error codes (CONDITIONAL_CHECK_FAILED / TRANSACTION_CONFLICT /
 *   THROTTLED) with the failing item's table+key in the message.
 * - When enableEmailUniqueness: tx.create("user") buffers email-lookup Put too.
 *
 * All buffered handlers are extracted to tx-*.ts for independent testability.
 */

import {
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBAdapterConfig, WhereClause } from "../types";
import { generateToken } from "../helpers/uuid";
import { runTransactionMiddleware } from "../helpers/apply-middleware";
import { getKeySchema } from "../helpers/key-builder";
import { DynamoAdapterError } from "../errors";
import { resolveDocClient } from "./client";

import { txCreate } from "./tx-create";
import { txUpdate } from "./tx-update";
import { txUpdateMany } from "./tx-update-many";
import { txDelete } from "./tx-delete";
import { txDeleteMany } from "./tx-delete-many";
import { txConsumeOne } from "./tx-consume-one";
import { parseEmailUniquenessError } from "../email-uniqueness";

import {
  type TransactionFactoryHelpers,
  type TransactionContext,
} from "./tx-types";

// Re-exported for factory.ts
export { type TransactionFactoryHelpers, type TransactionHelpersRef } from "./tx-types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

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
    findOne: (args: { model: string; where: WhereClause[] }) => Promise<AnyRecord | null>;
    findMany: (args: { model: string; where: WhereClause[]; limit?: number; sortBy?: any; offset?: number }) => Promise<AnyRecord[]>;
    count: (args: { model: string; where?: WhereClause[] }) => Promise<number>;
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
    transformWhereClause: ({ where }) => where,
    getModelName: (model) => model,
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

    // Applies the framework where-transform (field mapping, Date/id value
    // coercion) exactly like the non-tx pipeline does before adapter calls.
    const cleanWhere = (
      model: string,
      where: WhereClause[] | undefined,
      action: string,
    ): WhereClause[] | undefined => {
      const h = getHelpers();
      if (!where || !h.transformWhereClause) return where;
      return h.transformWhereClause({ model, where, action }) as WhereClause[];
    };
    const mapModel = (model: string): string =>
      getHelpers().getModelName?.(model) ?? model;

    // ── txAdapter ────────────────────────────────────────────
    const txAdapter: Record<string, any> = {
      // ── Reads (non-transactional, go directly to DDB) ────
      // Wrapped for contract parity: transformWhereClause on the way in,
      // transformOutput on the way out — the tx callback must behave like
      // the framework-level adapter.
      findOne: async (args: { model: string; where: WhereClause[]; select?: string[] }) => {
        const h = getHelpers();
        const res = await nativeAdapter.findOne({
          ...args,
          model: mapModel(args.model),
          where: cleanWhere(args.model, args.where, "findOne") ?? [],
        });
        if (!res) return null;
        return h.transformOutput(res, h.getDefaultModelName(args.model), args.select);
      },
      findMany: async (args: {
        model: string;
        where: WhereClause[];
        limit?: number;
        sortBy?: any;
        offset?: number;
        select?: string[];
      }) => {
        const h = getHelpers();
        const rows = await nativeAdapter.findMany({
          ...args,
          model: mapModel(args.model),
          where: cleanWhere(args.model, args.where, "findMany") ?? [],
        });
        const defaultModel = h.getDefaultModelName(args.model);
        return Promise.all(rows.map((r) => h.transformOutput(r, defaultModel)));
      },
      count: async (args: { model: string; where?: WhereClause[] }) => {
        return nativeAdapter.count({
          ...args,
          model: mapModel(args.model),
          where: cleanWhere(args.model, args.where, "count"),
        });
      },

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
      assertNoDuplicateTargets(writeBuffer, config);

      try {
        await runTransactionMiddleware(
          config.extensions ?? [],
          writeBuffer.length,
          () =>
            docClient.send(
              new TransactWriteCommand({
                TransactItems: writeBuffer,
                ClientRequestToken: generateToken(),
              }),
            ),
        );
      } catch (err: any) {
        if (err.name === "TransactionCanceledException") {
          // Check for email uniqueness violations via shared helper
          if (hasEmailUniqueness.value) {
            const emailErr = parseEmailUniquenessError(
              err,
              writeBuffer,
              config.tables.emailLookups ?? "",
            );
            if (emailErr) throw emailErr;
          }

          throw mapCancellationError(err, writeBuffer);
        }
        throw new DynamoAdapterError(
          "DYNAMODB_ERROR",
          err.message || "Unexpected DynamoDB error",
          err,
        );
      }
    }

    return result;
  };
}

// ── Flush-time guards & error mapping ─────────────────────────

/**
 * TransactWriteItems rejects a request containing two operations on one
 * item with an opaque ValidationException. Detect it up front and throw a
 * descriptive error naming the duplicate target instead.
 *
 * Put items are resolved to keys via the config's table → model mapping;
 * targets that can't be resolved (unknown plugin tables) are skipped —
 * this guard is best-effort, DynamoDB remains the backstop.
 */
function assertNoDuplicateTargets(
  writeBuffer: any[],
  config: DynamoDBAdapterConfig,
): void {
  // Reverse map: physical table name → model (for Put key extraction).
  const tableToModel = new Map<string, string>();
  for (const [model, table] of Object.entries(config.tables)) {
    if (typeof table === "string") tableToModel.set(table, model);
  }

  const seen = new Set<string>();
  for (const action of writeBuffer) {
    const op = action.Put ? "Put" : action.Update ? "Update" : action.Delete ? "Delete" : action.ConditionCheck ? "ConditionCheck" : null;
    if (!op) continue;
    const body = action[op];
    const tableName: string | undefined = body?.TableName;
    if (!tableName) continue;

    let key: AnyRecord | undefined = body.Key;
    if (!key && op === "Put" && body.Item) {
      const model = tableToModel.get(tableName);
      if (!model) continue; // unknown table — skip best-effort guard
      const schema = getKeySchema(model, config);
      key = { [schema.pkField]: body.Item[schema.pkField] };
      if (schema.skField && body.Item[schema.skField] !== undefined) {
        key[schema.skField] = body.Item[schema.skField];
      }
    }
    if (!key) continue;

    const target = `${tableName}::${JSON.stringify(key, Object.keys(key).sort())}`;
    if (seen.has(target)) {
      throw new DynamoAdapterError(
        "DUPLICATE_TRANSACTION_ITEM",
        `Transaction contains multiple operations on the same item ` +
          `(${target}). TransactWriteItems allows at most one operation ` +
          `per item — restructure the callback to combine them.`,
      );
    }
    seen.add(target);
  }
}

/**
 * Maps TransactionCanceledException CancellationReasons to distinct,
 * actionable error codes so callers can tell "retry me"
 * (TRANSACTION_CONFLICT / THROTTLED) apart from "this is now invalid"
 * (CONDITIONAL_CHECK_FAILED), and names the failing item.
 */
function mapCancellationError(err: any, writeBuffer: any[]): DynamoAdapterError {
  const reasons: any[] = err.CancellationReasons ?? [];
  const parsedReasons = reasons.map((r: any, i: number) => ({
    Code: r?.Code,
    Message: r?.Message,
    index: i,
    target: describeAction(writeBuffer[i]),
  }));

  const codes = parsedReasons.map((r) => r.Code).filter((c) => c && c !== "None");

  let code = "TRANSACTION_FAILED";
  if (codes.includes("TransactionConflict")) {
    code = "TRANSACTION_CONFLICT";
  } else if (
    codes.includes("ThrottlingError") ||
    codes.includes("ProvisionedThroughputExceeded")
  ) {
    code = "THROTTLED";
  } else if (codes.includes("ConditionalCheckFailed")) {
    code = "CONDITIONAL_CHECK_FAILED";
  }

  return new DynamoAdapterError(
    code,
    `Transaction cancelled: ${JSON.stringify(parsedReasons)}`,
    err,
  );
}

function describeAction(action: any): string | undefined {
  if (!action) return undefined;
  for (const op of ["Put", "Update", "Delete", "ConditionCheck"]) {
    const body = action[op];
    if (body) {
      const keyish = body.Key ?? undefined;
      return `${op} ${body.TableName}${keyish ? ` ${JSON.stringify(keyish)}` : ""}`;
    }
  }
  return undefined;
}
