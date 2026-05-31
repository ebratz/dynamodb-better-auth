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

  /** Forwarded to adapter factory (plural table names). Default: false. */
  usePlural?: boolean;

  /** Enable per-operation debug logging. */
  debugLogs?: boolean | Record<string, boolean>;
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
