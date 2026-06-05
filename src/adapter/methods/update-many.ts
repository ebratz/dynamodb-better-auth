/**
 * updateMany method — per DESIGN.md §5 (updateMany method) + accepted R6.
 *
 * Returns the count of successfully updated items.
 *
 * Standard path: resolve matching items via GSI Query or Scan → parallel
 *   UpdateItem calls (concurrency-limited, default 10). Field-level
 *   SET #f = :v semantics preserve concurrent writes to different fields.
 *
 * unsafeBatchUpdate path: BatchWriteCommand+Put (full-item overwrite, LWW).
 *
 * On partial failure: throw AggregateError with per-item errors.
 * Successful updates remain committed (non-transactional by design).
 *
 * PK/SK fields are stripped from the update payload to prevent
 * DynamoDB ValidationException on key-attribute mutation.
 */

import {
  UpdateCommand,
  BatchWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBAdapterConfig, WhereClause } from "../../types";
import { getKeySchema } from "../../helpers/key-builder";
import { findAllItems } from "../../helpers/find-items";
import { buildUpdateExpression } from "../../helpers/update-item";
import { BATCH_WRITE_SIZE, MAX_RETRY_ATTEMPTS, RETRY_BACKOFF_BASE_MS, RETRY_JITTER_MS } from "../../helpers/constants";
import { shouldLog } from "../../helpers/debug-log";
import { getLogger } from "../../helpers/logger";
import { getTableName } from "../client";
import { DynamoAdapterError } from "../../errors";

export function updateManyMethod(
  docClient: DynamoDBDocumentClient,
  config: DynamoDBAdapterConfig,
) {
  return async (args: {
    model: string;
    where: WhereClause[];
    update: Record<string, any>;
  }): Promise<number> => {
    const { model, where, update } = args;
    const tableName = getTableName(model, config);
    const schema = getKeySchema(model, config);

    // ── Strip PK/SK fields from update payload ─────────────────
    const updateData = { ...update };
    delete updateData[schema.pkField];
    if (schema.skField) {
      delete updateData[schema.skField];
    }

    if (Object.keys(updateData).length === 0) return 0;

    // ── Find matching items via shared helper ──────────────────
    const items = await findAllItems(docClient, tableName, where, model, schema, config, { debugKey: "updateMany" });

    if (items.length === 0) return 0;

    // ── Safety limit ──────────────────────────────────────────
    const maxItems = config.maxUpdateManyItems ?? 1000;
    if (maxItems > 0 && items.length > maxItems) {
      throw new DynamoAdapterError(
        "TOO_MANY_ITEMS",
        `updateMany matched ${items.length} items but the safety limit is ${maxItems}. ` +
          `Refine your where clause or increase maxUpdateManyItems in config.`,
      );
    }

    // ── unsafeBatchUpdate path ─────────────────────────────────
    if (config.unsafeBatchUpdate) {
      return _batchPutUpdate(docClient, tableName, items, updateData, config);
    }

    // ── Standard path: parallel UpdateItem ─────────────────────
    const concurrency = config.updateManyConcurrency ?? 10;
    const { results, errors } = await _parallelLimit(
      items,
      concurrency,
      (item) => _updateOne(docClient, tableName, item, updateData, schema),
    );

    if (errors.length > 0) {
      const agg = new AggregateError(
        errors,
        `${errors.length} of ${items.length} updateMany operations failed`,
      );
      throw agg;
    }

    return results.filter(Boolean).length;
  };
}

// ── Item update ─────────────────────────────────────────────────

/**
 * Update a single item via UpdateCommand with safety guards.
 *
 * - Strips PK/SK fields from update payload (shared helper).
 * - Converts Date → ISO string (shared helper).
 * - Adds ConditionExpression (attribute_exists) to prevent upsert
 *   on items deleted between the findMany and individual UpdateItem.
 * - ConditionalCheckFailedException → returns false (skip, don't throw).
 */
async function _updateOne(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  item: Record<string, any>,
  update: Record<string, any>,
  schema: { pkField: string; skField?: string },
): Promise<boolean> {
  const key: Record<string, any> = { [schema.pkField]: item[schema.pkField] };
  if (schema.skField) key[schema.skField] = item[schema.skField!];

  const { setClauses, attrNames, attrValues } = buildUpdateExpression(
    update,
    schema.pkField,
    schema.skField,
  );

  if (setClauses.length === 0) return false;

  try {
    await docClient.send(
      new UpdateCommand({
        TableName: tableName,
        Key: key,
        UpdateExpression: `SET ${setClauses.join(", ")}`,
        ExpressionAttributeNames: { ...attrNames, "#pk": schema.pkField },
        ExpressionAttributeValues: attrValues,
        ConditionExpression: "attribute_exists(#pk)",
      }),
    );
    return true;
  } catch (err: any) {
    if (err.name === "ConditionalCheckFailedException") {
      return false;
    }
    throw new DynamoAdapterError(
      "DYNAMODB_ERROR",
      err.message || "Unexpected DynamoDB error",
      err,
    );
  }
}

// ── Batch Put (unsafeBatchUpdate) ───────────────────────────────

async function _batchPutUpdate(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  items: Record<string, any>[],
  update: Record<string, any>,
  config: DynamoDBAdapterConfig,
): Promise<number> {
  if (shouldLog(config, "updateMany")) {
    getLogger(config).warn(
      `[dynamodb-adapter] updateMany using unsafeBatchUpdate — ` +
        `full-item overwrite (last-write-wins).`,
      { tableName },
    );
  }

  let updated = 0;

  // Chunk into batches of BATCH_WRITE_SIZE (25)

  for (let i = 0; i < items.length; i += BATCH_WRITE_SIZE) {
    const chunk = items.slice(i, i + BATCH_WRITE_SIZE);
    const putRequests = chunk.map((item) => {
      const patched = { ...item, ...update };
      return {
        PutRequest: { Item: patched },
      };
    });

    const result = await docClient.send(
      new BatchWriteCommand({
        RequestItems: {
          [tableName]: putRequests,
        },
      }),
    );

    // Retry UnprocessedItems up to 3 times with exponential backoff
    let retries = 0;
    let unprocessed = result.UnprocessedItems;
    while (unprocessed && Object.keys(unprocessed).length > 0 && retries < MAX_RETRY_ATTEMPTS) {
      // Exponential backoff with jitter
      await new Promise((r) => setTimeout(r, Math.pow(2, retries) * RETRY_BACKOFF_BASE_MS + Math.random() * RETRY_JITTER_MS));
      const retryResult = await docClient.send(
        new BatchWriteCommand({
          RequestItems: unprocessed,
        }),
      );
      unprocessed = retryResult.UnprocessedItems;
      retries++;
    }

    // Only count items that were actually processed
    const unprocessedInChunk = (unprocessed as any)?.[tableName]?.length ?? 0;
    updated += chunk.length - unprocessedInChunk;
  }

  return updated;
}

// ── Concurrency limiter ─────────────────────────────────────────

async function _parallelLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<{ results: (R | undefined)[]; errors: Error[] }> {
  const results: (R | undefined)[] = new Array(items.length);
  const errors: Error[] = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      try {
        results[i] = await fn(items[i]!);
      } catch (err: any) {
        errors.push(err);
        results[i] = undefined;
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));

  return { results, errors };
}
