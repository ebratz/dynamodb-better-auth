/**
 * Base error for all DynamoDB adapter errors.
 * Each error has a machine-readable `code` for programmatic handling.
 */
export class DynamoAdapterError extends Error {
  constructor(
    public code: string,
    message: string,
    public cause?: unknown,
  ) {
    super(message);
    this.name = "DynamoAdapterError";
  }
}

/** Thrown when a Better Auth operator has no DynamoDB equivalent. */
export class UnsupportedOperatorError extends DynamoAdapterError {
  constructor(operator: string, detail?: string) {
    super(
      "UNSUPPORTED_OPERATOR",
      `Operator "${operator}" is not supported${detail ? `: ${detail}` : ""}.`,
    );
    this.name = "UnsupportedOperatorError";
  }
}

/**
 * Thrown when an adapter option is not available for the resolved
 * query plan (e.g. `offset` on a GSI Query).
 */
export class UnsupportedOptionError extends DynamoAdapterError {
  constructor(option: string, detail?: string) {
    super(
      "UNSUPPORTED_OPTION",
      `Option "${option}" is not supported${detail ? `: ${detail}` : ""}.`,
    );
    this.name = "UnsupportedOptionError";
  }
}

/**
 * Thrown when a `where` clause cannot be resolved to a valid
 * DynamoDB key or index (e.g. `consumeOne` with Tier-3 Scan).
 */
export class InvalidWhereError extends DynamoAdapterError {
  constructor(detail?: string) {
    super(
      "INVALID_WHERE",
      `Invalid where clause${detail ? `: ${detail}` : ""}.`,
    );
    this.name = "InvalidWhereError";
  }
}

/**
 * Placeholder error used in stub files. Remove all usages before shipping.
 * Every stub function body is `throw new NotImplementedError("functionName")`.
 */
export class NotImplementedError extends DynamoAdapterError {
  constructor(what: string) {
    super("NOT_IMPLEMENTED", `${what} is a stub.`);
    this.name = "NotImplementedError";
  }
}
