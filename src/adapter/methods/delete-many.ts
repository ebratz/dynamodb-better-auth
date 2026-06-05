/**
 * deleteMany method — per DESIGN.md §5 (deleteMany method) + §10 batching.
 *
 * Deletes all items matching the where clause.
 *
 * 1. Resolve plan via centralized query-planner:
 *    - Tier 1: GetItem (PK equality) → single-item BatchWrite.
 *    - Tier 2: GSI Query → paginated fetch → extract keys → BatchWrite.
 *      KEYS_ONLY GSIs: BatchGetCommand in chunks of 100 (not sequential GetItem).
 *    - Tier 3: Scan → paginated fetch → extract keys → BatchWrite.
 * 2. Chunk keys into batches of 25 → BatchWriteCommand with DeleteRequest entries.
 * 3. Retry UnprocessedItems with exponential backoff + jitter (max 3 attempts).
 * 4. Return total deletedCount.
 */

import {
  BatchWriteCommand,
  GetCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBAdapterConfig } from "../../types";
import { getKeySchema } from "../../helpers/key-builder";
import { compactExpr } from "../../helpers/expression-names";
import { getTableName } from "../client";
import { resolveQueryPlan } from "../../helpers/query-planner";
import { resolveKEYS_ONLY } from "../../helpers/batch-get";
import { DynamoAdapterError } from "../../errors";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Where = any;

export function deleteManyMethod(
  docClient: DynamoDBDocumentClient,
  config: DynamoDBAdapterConfig,
) {
  return async (args: {
    model: string;
    where?: Where[];
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

    // ── Resolve plan via centralized planner ──────────────────
    const plan = resolveQueryPlan(where, model, config);

    // ── Find all matching items ───────────────────────────────
    const items = await _findItems(docClient, tableName, plan, config, model, schema);

    if (items.length === 0) {
      return 0;
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

// ── Internal helpers ───────────────────────────────────────────

async function _findItems(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  plan: {
    tier: number;
    operation: string;
    key?: Record<string, any>;
    indexName?: string;
    keyCondition?: string;
    filterExpression?: string;
    expressionAttributeNames: Record<string, string>;
    expressionAttributeValues: Record<string, any>;
    needsFollowUpGetItem?: boolean;
    followUpKeyFields?: { pkField: string; skField?: string };
  },
  config: DynamoDBAdapterConfig,
  model: string,
  schema: { pkField: string; skField?: string },
): Promise<Record<string, any>[]> {
  // ── Tier 1: GetItem ──────────────────────────────────────
  if (plan.operation === "getItem") {
    const result = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: plan.key!,
      }),
    );
    const item = result.Item as any;
    return item ? [item] : [];
  }

  // ── Tier 2: Query on GSI ─────────────────────────────────
  if (plan.operation === "query") {
    const items: Record<string, any>[] = [];
    let lastEvaluatedKey: Record<string, any> | undefined;

    do {
      const result = await docClient.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: plan.indexName!,
          KeyConditionExpression: plan.keyCondition!,
          FilterExpression: plan.filterExpression || undefined,
          ...compactExpr(plan.expressionAttributeNames, plan.expressionAttributeValues),
          ExclusiveStartKey: lastEvaluatedKey,
        } as any),
      );
      if (result.Items) items.push(...(result.Items as any[]));
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    // Follow-up BatchGetItem for KEYS_ONLY GSIs (chunked by 100)
    if (plan.needsFollowUpGetItem && items.length > 0) {
      return resolveKEYS_ONLY(
        docClient,
        tableName,
        plan.followUpKeyFields ?? { pkField: schema.pkField, skField: schema.skField },
        items,
      );
    }

    return items;
  }

  // ── Tier 3: Scan ─────────────────────────────────────────
  if (config.debugLogs && plan.filterExpression) {
    const debug =
      typeof config.debugLogs === "object" ? config.debugLogs : {};
    if (debug.deleteMany !== false) {
      console.warn(
        `[dynamodb-adapter] deleteMany on ${model} using Scan (Tier 3). ` +
          `Consider adding a GSI for the queried field(s).`,
      );
    }
  }

  const items: Record<string, any>[] = [];
  let lastEvaluatedKey: Record<string, any> | undefined;

  do {
    const result = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: plan.filterExpression || undefined,
        ...compactExpr(plan.expressionAttributeNames, plan.expressionAttributeValues),
        ExclusiveStartKey: lastEvaluatedKey,
      } as any),
    );
    if (result.Items) items.push(...(result.Items as any[]));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return items;
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
