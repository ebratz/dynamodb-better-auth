/**
 * Shared constants for the DynamoDB adapter.
 *
 * Single source of truth for batch sizes, retry limits, backoff timing,
 * and default values used across method files.
 */

/** DynamoDB BatchWriteCommand limit: max 25 items per request. */
export const BATCH_WRITE_SIZE = 25;

/** DynamoDB BatchGetCommand limit: max 100 keys per request. */
export const BATCH_GET_SIZE = 100;

/** Maximum retry attempts for UnprocessedItems/UnprocessedKeys. */
export const MAX_RETRY_ATTEMPTS = 3;

/** Base delay (ms) for exponential backoff: Math.pow(2, attempt - 1) * BASE. */
export const RETRY_BACKOFF_BASE_MS = 100;

/** Jitter range (ms) added to backoff: Math.random() * JITTER_MS. */
export const RETRY_JITTER_MS = 50;

/** Default limit for findMany when none specified. */
export const DEFAULT_FIND_MANY_LIMIT = 100;
