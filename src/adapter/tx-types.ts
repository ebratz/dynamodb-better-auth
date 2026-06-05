/**
 * Transaction context — shared state passed to all tx handler functions.
 *
 * Extracted from createTransactionWrapper to keep handler files self-contained.
 */

import type { DynamoDBAdapterConfig, WhereClause } from "../types";

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

export interface TransactionContext {
  /** Accumulated TransactWriteItems. Handlers push actions here. */
  writeBuffer: any[];
  /** Native (non-transactional) adapter methods for reads. */
  nativeAdapter: {
    findOne: (args: { model: string; where: WhereClause[] }) => Promise<Record<string, any> | null>;
    findMany: (args: { model: string; where: WhereClause[]; limit?: number; sortBy?: any; offset?: number }) => Promise<Record<string, any>[]>;
    count: (args: { model: string; where?: WhereClause[] }) => Promise<number>;
    [key: string]: any;
  };
  /** Adapter configuration (tables, indexes, email uniqueness, etc.) */
  config: DynamoDBAdapterConfig;
  /** Resolve a table name from a model name. */
  getTable: (model: string) => string;
  /** Resolve the late-bound factory helpers (transformInput/Output). */
  getHelpers: () => TransactionFactoryHelpers;
  /** Mutable flag set when any handler buffers an email-lookup action. */
  hasEmailUniqueness: { value: boolean };
}
