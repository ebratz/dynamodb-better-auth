// Type-only references to peer dependencies. These resolve at install time
// when the consumer has @aws-sdk/client-dynamodb and @aws-sdk/lib-dynamodb.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DynamoDBClientLike = any;
type DynamoDBDocumentClientLike = any;

// ── Public API ──────────────────────────────────────────────────

export interface GsiDeclaration {
  /** GSI name in DynamoDB */
  indexName: string;
  /** Attribute used as the GSI partition key */
  hashKey: string;
  /** Attribute used as the GSI sort key (omit for simple-PK GSIs) */
  rangeKey?: string;
  /**
   * GSI projection type.
   * - "ALL": all base-table attributes projected (default for lookup GSIs)
   * - "KEYS_ONLY": only key attributes (use for id→PK resolver GSIs)
   * - { include: string[] }: specific non-key attributes to project
   */
  projection?: "ALL" | "KEYS_ONLY" | { include: string[] };
}

export interface KeySchemaOverride {
  pkField: string;
  skField?: string;
}

export interface DynamoDBAdapterConfig {
  /**
   * DynamoDBClient (recommended) or pre-configured DynamoDBDocumentClient.
   * If a raw DynamoDBClient is passed, the adapter wraps it internally with
   * `marshallOptions: { removeUndefinedValues: true }`.
   */
  client: DynamoDBClientLike | DynamoDBDocumentClientLike;

  /**
   * Table name mapping: model → DynamoDB table name.
   * Core models are required; plugin models added via the Record extension.
   */
  tables: {
    user: string;
    session: string;
    account: string;
    verification: string;
    emailLookups?: string;
  } & Record<string, string>;

  /**
   * Optional GSI declarations.
   * Key: model name → { fieldName → GsiDeclaration }
   */
  indexes?: Record<string, Record<string, GsiDeclaration>>;

  /**
   * Override default key schemas per model.
   * Core models are hardcoded; plugin models default to { pkField: "id" }.
   */
  keySchemas?: Record<string, KeySchemaOverride>;

  /**
   * Declares, per model, the expiry field whose value drives a store-level
   * DynamoDB TTL. Keyed by default model name (e.g. `{ verification: "expiresAt" }`).
   *
   * When set for a model, the adapter:
   *   1. writes a numeric TTL attribute (epoch seconds + grace) on create/update
   *      whenever the source field is present, and
   *   2. answers Better Auth's keyless expiry sweep
   *      (`deleteMany(<field> lt <now>)`) with an empty result instead of
   *      scanning the table — DynamoDB TTL performs the actual cleanup.
   *
   * Only declare a field here if DynamoDB TTL is enabled on `ttlAttribute`
   * (see README). Without the store-level TTL, skipped rows never expire.
   */
  ttlFields?: Record<string, string>;

  /**
   * Name of the DynamoDB TTL attribute written by the adapter.
   * Must be a Number attribute with DynamoDB TTL enabled.
   * Default: "ttl".
   */
  ttlAttribute?: string;

  /**
   * Emit a debugLogs warning when count() scans more than N items.
   * Default: 10_000. Set to 0 to disable.
   */
  warnOnLargeCount?: number;

  /**
   * Enable atomic email-uniqueness enforcement via an EmailLookups sidecar table.
   * Requires tables.emailLookups to be set.
   */
  enableEmailUniqueness?: boolean;

  /**
   * Use BatchWriteItem+PutItem for updateMany instead of parallel UpdateItem.
   * Faster but full-item overwrite (lost-update hazard). Default: false.
   */
  unsafeBatchUpdate?: boolean;

  /** Max concurrent UpdateItem calls in updateMany. Default: 10. */
  updateManyConcurrency?: number;

  /**
   * Maximum items allowed in a single updateMany operation.
   * Throws DynamoAdapterError("TOO_MANY_ITEMS") if exceeded.
   * Default: 1000. Set to 0 to disable the limit.
   */
  maxUpdateManyItems?: number;

  /**
   * Maximum items allowed in a single deleteMany operation.
   * Throws DynamoAdapterError("TOO_MANY_ITEMS") if exceeded.
   * Default: 1000. Set to 0 to disable the limit.
   */
  maxDeleteManyItems?: number;

  /** Forwarded to adapter factory (plural table names). Default: false. */
  usePlural?: boolean;

  /** Enable per-operation debug logging. */
  debugLogs?: boolean | Record<string, boolean>;

  /**
   * Custom logger for adapter warnings and debug messages.
   * Defaults to console.warn / console.debug when not provided.
   */
  logger?: AdapterLogger;

  /**
   * Maximum evaluated items per findMany or bulk discovery operation.
   * Checked after each page before further pages are requested; throws
   * DynamoAdapterError("SCAN_LIMIT_EXCEEDED").
   * Default: 10_000. Set to 0 to disable the limit.
   */
  maxScanItems?: number;

  /**
   * Hook for latency / error metrics.
   * Called after every adapter operation with operation name, model,
   * duration in milliseconds, and optional error.
   */
  metrics?: AdapterMetrics;

  /**
   * Middleware extensions for audit logging, soft-delete, multi-tenancy, etc.
   * Each extension implements optional hooks that fire before/after adapter
   * operations. Hooks run sequentially in array order.
   */
  extensions?: DynamoAdapterMiddleware[];
}

// ── Logger ─────────────────────────────────────────────────────

/**
 * Pluggable logger interface for adapter warnings and debug output.
 * Pass a custom implementation via config.logger to capture structured
 * log data instead of relying on console.warn / console.debug.
 */
export interface AdapterLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
  debug?(message: string, meta?: Record<string, unknown>): void;
}

// ── Middleware ──────────────────────────────────────────────────

/**
 * Extension point for adapter operations.
 *
 * Each hook is optional — implement only what you need. Before-hooks may
 * return a partial args object to modify the operation (e.g., adding a
 * tenantId to create data). After-hooks receive the final modified args plus
 * the result for audit logging.
 */
export interface DynamoAdapterMiddleware {
  /** Unique name for debugging / error attribution. */
  name: string;

  /** Called before create — may return modified data to replace args.data. */
  onBeforeCreate?(args: { model: string; data: Record<string, unknown> }):
    | Promise<Record<string, unknown> | void>
    | Record<string, unknown>
    | void;
  onAfterCreate?(args: {
    model: string;
    data: Record<string, unknown>;
    result: Record<string, unknown>;
  }): Promise<void> | void;

  /** Called before update — may return { update } to modify the update payload. */
  onBeforeUpdate?(args: {
    model: string;
    where: WhereClause[];
    update: Record<string, unknown>;
  }):
    | Promise<Record<string, unknown> | void>
    | Record<string, unknown>
    | void;
  onAfterUpdate?(args: {
    model: string;
    where: WhereClause[];
    update: Record<string, unknown>;
    result: Record<string, unknown> | null;
  }): Promise<void> | void;

  /** Called before delete. */
  onBeforeDelete?(args: {
    model: string;
    where: WhereClause[];
  }): Promise<void> | void;
  onAfterDelete?(args: {
    model: string;
    where: WhereClause[];
    result: Record<string, unknown> | null;
  }): Promise<void> | void;

  /** Called after findOne — useful for read-audit logging. */
  onAfterFindOne?(args: {
    model: string;
    where: WhereClause[];
    result: Record<string, unknown> | null;
  }): Promise<void> | void;

  /** Called after findMany. */
  onAfterFindMany?(args: {
    model: string;
    where?: WhereClause[];
    limit?: number;
    result: Record<string, unknown>[];
  }): Promise<void> | void;

  /** Called after count. */
  onAfterCount?(args: {
    model: string;
    where?: WhereClause[];
    result: number;
  }): Promise<void> | void;

  /** Called before the TransactWriteCommand flush in a transaction. */
  onBeforeTransaction?(args: { operations: number }): Promise<void> | void;
  /** Called after the TransactWriteCommand flush. */
  onAfterTransaction?(args: {
    operations: number;
    result: unknown;
  }): Promise<void> | void;
}

// ── Metrics ─────────────────────────────────────────────────────

/** Callback for operational latency / error metrics. Exceptions are ignored. */
export interface AdapterMetrics {
  (event: {
    operation: string;
    model: string;
    durationMs: number;
    error?: Error;
  }): void;
}

// ── Where clause shape ──────────────────────────────────────────

/**
 * Single element of a Better Auth where clause.
 * Shared across all adapter method and transaction handler signatures.
 */
export interface WhereClause {
  field: string;
  value: string | number | boolean | string[] | number[] | Date | null;
  operator?: string;
  connector?: "AND" | "OR";
  mode?: "sensitive" | "insensitive";
}

// ── Internal Types ──────────────────────────────────────────────

export interface KeySchema {
  pkField: string;
  skField?: string;
}

export interface QueryPlan {
  tier: 1 | 2 | 3;
  operation: "getItem" | "query" | "scan";
  tableName: string;
  indexName?: string;
  key?: Record<string, any>;
  keyCondition?: string;
  filterExpression?: string;
  expressionAttributeNames: Record<string, string>;
  expressionAttributeValues: Record<string, any>;
  needsClientSideSort?: boolean;
  needsClientSideFilter?: boolean;
  needsFollowUpGetItem?: boolean;
  followUpKeyFields?: { pkField: string; skField?: string };
  clientSideFilters?: Array<{ field: string; operator: string; value: any }>;
  /**
   * The where clause is vacuously false (e.g. `in: []`) — the query can
   * never match. Consumers short-circuit to an empty result without a
   * DynamoDB call.
   */
  alwaysFalse?: boolean;
  /**
   * Client-side filters DynamoDB cannot express server-side (ends_with).
   * Applied to fetched items AND-connected; page fetch helpers apply them
   * before limit accounting.
   */
  postFilters?: Array<{ field: string; operator: string; value: any }>;
  /**
   * The where clause is a model's expiry sweep
   * (`<ttlField> lt|lte <cutoff>` as the sole clause) on a model that
   * declares `ttlFields`. DynamoDB TTL owns the cleanup, so consumers
   * short-circuit to an empty result rather than scanning the table.
   */
  ttlPrune?: boolean;
}

export interface ConvertedWhere {
  expression: string;
  expressionAttributeNames: Record<string, string>;
  expressionAttributeValues: Record<string, any>;
  involvedFields: string[];
  needsClientSideFilter: boolean;
  clientSideFilters?: Array<{ field: string; operator: string; value: any }>;
  /** When IN clauses exceeded 100 values, the expression is split into
   *  chunks joined with OR. Each chunk is bounded by ≤100 values. */
  chunked?: boolean;
  /** The whole clause folds to constant false (e.g. `in: []`) — nothing
   *  can match; callers short-circuit to empty results. */
  alwaysFalse?: boolean;
  /** Client-side post-filters for operators DynamoDB cannot express
   *  (ends_with). AND-applied to fetched items. */
  postFilters?: Array<{ field: string; operator: string; value: any }>;
}

export interface ExpressionNamesResult {
  /** Map of placeholder → real field name, e.g. `{ "#n0": "email" }`. */
  names: Record<string, string>;
  /** Map a field name to its `#n` placeholder, e.g. `"email" → "#n0"`. */
  toRef: (field: string) => string;
  /**
   * Generate a value placeholder. When `index` is omitted the implementation
   * auto-increments; when provided it honours the explicit index.
   */
  toValueRef: (index?: number) => string;
  /** Current value index (for manual management) */
  nextValueIndex: number;
}

export interface ConversionOptions {
  model: string;
  getFieldName: (opts: { model: string; field: string }) => string;
  getFieldAttributes: (opts: { model: string; field: string }) => any;
}
