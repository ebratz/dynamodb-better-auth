/**
 * deleteMany method — per DESIGN.md §5 (deleteMany method) + §10 batching.
 *
 * Deletes all items matching the where clause.
 *
 * 1. Find all matching items via shared findAllItems helper (Tier 1/2/3).
 * 2. Extract keys; chunk into batches of 25 → BatchWriteCommand.
 * 3. Retry UnprocessedItems with exponential backoff + jitter (max 3 attempts).
 * 4. Return total deletedCount.
 */

import {
  BatchWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBAdapterConfig, WhereClause } from "../../types";
import { getKeySchema } from "../../helpers/key-builder";
import { getTableName } from "../client";
import { findAllItems } from "../../helpers/find-items";
import { DynamoAdapterError } from "../../errors";

export function deleteManyMethod(
  docClient: DynamoDBDocumentClient,
  config: DynamoDBAdapterConfig,
) {
  return async (args: {
    model: string;
    where?: WhereClause[];
  }): Promise<number> => {
    const { model, where } = args;

    // ── Guard against accidental full-table deletion ─────────
    if (!where || where.length === 0) {
      throw new DynamoAdapterError(
        "INVALID_WHERE",
        "deleteMany requires a non-empty where clause to prevent accidental full-table deletion.",
      );
    }

    const tableName = getTableName(model, config);
    const schema = getKeySchema(model, config);

    // ── Find all matching items via shared helper ──────────────
    const items = await findAllItems(docClient, tableName, where, model, schema, config, {
      debugKey: "deleteMany",
      includeTier1: true,
    });

    if (items.length === 0) {
      return 0;
    }

    // ── Safety limit ──────────────────────────────────────────
    const maxItems = config.maxDeleteManyItems ?? 1000;
    if (maxItems > 0 && items.length > maxItems) {
      throw new DynamoAdapterError(
        "TOO_MANY_ITEMS",
        `deleteMany matched ${items.length} items but the safety limit is ${maxItems}. ` +
          `Refine your where clause or increase maxDeleteManyItems in config.`,
      );
    }

    // ── Extract keys from items ───────────────────────────────
    const keys = items.map((item: Record<string, any>) => {
      const key: Record<string, any> = { [schema.pkField]: item[schema.pkField] };
      if (schema.skField && item[schema.skField] !== undefined) {
        key[schema.skField] = item[schema.skField];
      }
      return key;
    });

    // ── Batch delete in chunks of 25 ──────────────────────────
    let deletedCount = 0;
    const BATCH_SIZE = 25;

    for (let i = 0; i < keys.length; i += BATCH_SIZE) {
      const chunk = keys.slice(i, i + BATCH_SIZE);
      const deleted = await _batchDeleteWithRetry(docClient, tableName, chunk);
      deletedCount += deleted;
    }

    return deletedCount;
  };
}

async function _batchDeleteWithRetry(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  keys: Record<string, any>[],
  attempt = 1,
): Promise<number> {
  const MAX_ATTEMPTS = 3;

  const result = await docClient.send(
    new BatchWriteCommand({
      RequestItems: {
        [tableName]: keys.map((key) => ({
          DeleteRequest: { Key: key },
        })),
      },
    }),
  );

  let deletedCount = keys.length;

  const unprocessed = (result.UnprocessedItems as any)?.[tableName];
  if (unprocessed && unprocessed.length > 0 && attempt < MAX_ATTEMPTS) {
    const unprocessedKeys = unprocessed.map(
      (u: any) => u.DeleteRequest!.Key,
    );
    // Exponential backoff with jitter: 100ms / 200ms / 400ms + random 0-50ms
    await new Promise((resolve) =>
      setTimeout(resolve, Math.pow(2, attempt - 1) * 100 + Math.random() * 50),
    );
    const retryDeleted = await _batchDeleteWithRetry(
      docClient,
      tableName,
      unprocessedKeys,
      attempt + 1,
    );
    deletedCount = deletedCount - unprocessedKeys.length + retryDeleted;
  } else if (unprocessed && unprocessed.length > 0) {
    // Max attempts reached — some items not deleted
    deletedCount -= unprocessed.length;
  }

  return deletedCount;
}
