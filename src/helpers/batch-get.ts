/**
 * Shared BatchGet helper for KEYS_ONLY GSI follow-up resolution.
 *
 * Used by findMany and deleteMany to resolve full items from a KEYS_ONLY
 * GSI result set. Items are chunked into batches of 100 (DynamoDB limit)
 * and UnprocessedKeys are retried with exponential backoff + jitter
 * (max 3 attempts).
 */

import { BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoAdapterError } from "../errors";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

import {
  BATCH_GET_SIZE,
  MAX_RETRY_ATTEMPTS,
  RETRY_BACKOFF_BASE_MS,
  RETRY_JITTER_MS,
} from "./constants";

const BATCH_SIZE = BATCH_GET_SIZE;

/**
 * Resolves full items from KEYS_ONLY GSI results via BatchGetCommand.
 *
 * @param docClient - DynamoDB DocumentClient
 * @param tableName - DDB table name
 * @param followUpKeyFields - PK (and optional SK) to extract from GSI items
 * @param gsiItems - items returned from a KEYS_ONLY GSI Query
 * @returns full items (best-effort; UnprocessedKeys after max retries are dropped)
 */
export async function resolveKEYS_ONLY(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  followUpKeyFields: { pkField: string; skField?: string },
  gsiItems: AnyRecord[],
): Promise<AnyRecord[]> {
  // Build keys from GSI items
  const keys = gsiItems.map((item) => {
    const key: AnyRecord = { [followUpKeyFields.pkField]: item[followUpKeyFields.pkField] };
    if (followUpKeyFields.skField && item[followUpKeyFields.skField] !== undefined) {
      key[followUpKeyFields.skField] = item[followUpKeyFields.skField];
    }
    return key;
  });

  const results: AnyRecord[] = [];

  for (let i = 0; i < keys.length; i += BATCH_SIZE) {
    const chunk = keys.slice(i, i + BATCH_SIZE);
    const resolved = await _batchGetWithRetry(docClient, tableName, chunk);
    results.push(...resolved);
  }

  return results;
}

async function _batchGetWithRetry(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  keys: AnyRecord[],
  attempt: number = 1,
): Promise<AnyRecord[]> {
  const result = await docClient.send(
    new BatchGetCommand({
      RequestItems: {
        [tableName]: { Keys: keys },
      },
    }),
  );

  const responses: AnyRecord[] = (result.Responses as any)?.[tableName] ?? [];

  const unprocessed = (result.UnprocessedKeys as any)?.[tableName]?.Keys;
  if (unprocessed && unprocessed.length > 0 && attempt < MAX_RETRY_ATTEMPTS) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.pow(2, attempt - 1) * RETRY_BACKOFF_BASE_MS + Math.random() * RETRY_JITTER_MS),
    );
    const retryResults = await _batchGetWithRetry(
      docClient,
      tableName,
      unprocessed,
      attempt + 1,
    );
    responses.push(...retryResults);
  } else if (unprocessed && unprocessed.length > 0) {
    // Silently dropping rows would make findMany on a sparse-projection
    // GSI return fewer rows than actually matched.
    throw new DynamoAdapterError(
      "PARTIAL_FAILURE",
      `BatchGet: ${unprocessed.length} of ${keys.length} keys remained ` +
        `unprocessed after ${MAX_RETRY_ATTEMPTS} attempts (throttling).`,
    );
  }

  return responses;
}
