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
import { resolveQueryPlan } from "../../helpers/query-planner";
import { resolveKEYS_ONLY } from "../../helpers/batch-get";
import { fetchAllByPlan } from "../../helpers/fetch-all";
import { buildUpdateExpression } from "../../helpers/update-item";
import { shouldLog } from "../../helpers/debug-log";
import { getTableName } from "../client";

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

    // ── Find matching items ────────────────────────────────────
    const items = await _findItems(docClient, tableName, where, model, schema, config);

    if (items.length === 0) return 0;

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

// ── Item lookup ─────────────────────────────────────────────────

/**
 * Finds all items matching the where clause via centralized resolveQueryPlan.
 * Tier 2: GSI Query with pagination.
 * Tier 3: Scan with FilterExpression.
 * KEYS_ONLY GSI follow-up via resolveKEYS_ONLY (BatchGetCommand, chunked).
 */
async function _findItems(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  where: WhereClause[],
  model: string,
  schema: { pkField: string; skField?: string },
  config: DynamoDBAdapterConfig,
): Promise<Record<string, any>[]> {
  // No where clause → full table Scan
  if (!where || where.length === 0) {
    return fetchAllByPlan(docClient, tableName, {
      operation: "scan",
      expressionAttributeNames: {},
      expressionAttributeValues: {},
    });
  }

  const plan = resolveQueryPlan(where, model, config);

  // ── Tier 2: GSI Query ────────────────────────────────────
  if (plan.tier === 2 && plan.operation === "query") {
    const items = await fetchAllByPlan(docClient, tableName, plan as any);

    // KEYS_ONLY follow-up
    if (plan.needsFollowUpGetItem && plan.followUpKeyFields && items.length > 0) {
      return resolveKEYS_ONLY(
        docClient,
        tableName,
        plan.followUpKeyFields,
        items,
      );
    }

    return items;
  }

  // ── Tier 3: Scan ─────────────────────────────────────────
  if (shouldLog(config, "updateMany")) {
    console.warn(
      `[dynamodb-adapter] updateMany on ${model} using Scan (Tier 3). ` +
        `Consider adding a GSI for the queried field(s).`,
    );
  }

  return fetchAllByPlan(docClient, tableName, plan as any);
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
    throw err;
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
    console.warn(
      `[dynamodb-adapter] updateMany using unsafeBatchUpdate — ` +
        `full-item overwrite (last-write-wins).`,
    );
  }

  let updated = 0;

  // Chunk into batches of 25 (DynamoDB BatchWrite limit)
  const BATCH_SIZE = 25;

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const chunk = items.slice(i, i + BATCH_SIZE);
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
    while (unprocessed && Object.keys(unprocessed).length > 0 && retries < 3) {
      await new Promise((r) => setTimeout(r, Math.pow(2, retries) * 100));
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
