/**
 * deleteMany method — per DESIGN.md §5 (deleteMany method) + §10 batching.
 *
 * Deletes all items matching the where clause.
 *
 * 1. Resolve plan across three tiers:
 *    - Tier 1: PK equality → GetItem → single-item BatchWrite.
 *    - Tier 2: GSI Query → paginated fetch → extract keys → BatchWrite.
 *      KEYS_ONLY GSIs: follow-up GetItem per item to resolve full key.
 *    - Tier 3: Scan → paginated fetch → extract keys → BatchWrite.
 * 2. Chunk keys into batches of 25 → BatchWriteCommand with DeleteRequest entries.
 * 3. Retry UnprocessedItems with exponential backoff (max 3 attempts).
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
import { getTableName } from "../client";

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
    const tableName = getTableName(model, config);
    const schema = getKeySchema(model, config);

    // ── Resolve plan ──────────────────────────────────────────
    const plan = resolveDeleteManyPlan(where ?? [], model, schema, config);

    // ── Find all matching items ───────────────────────────────
    const items = await _findItems(docClient, tableName, plan, config, model, schema);

    if (items.length === 0) {
      return 0;
    }

    // ── Extract keys ──────────────────────────────────────────
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

interface DeleteManyPlan {
  operation: "getItem" | "query" | "scan";
  key?: Record<string, any>;
  indexName?: string;
  keyCondition?: string;
  filterExpression?: string;
  expressionAttributeNames: Record<string, string>;
  expressionAttributeValues: Record<string, any>;
  needsFollowUpGetItem?: boolean;
}

function resolveDeleteManyPlan(
  where: Where[],
  model: string,
  schema: { pkField: string; skField?: string },
  config: DynamoDBAdapterConfig,
): DeleteManyPlan {
  const names: Record<string, string> = {};
  const values: Record<string, any> = {};

  const fieldName = (f: string, i: number) => {
    const nk = `#n${i}`;
    names[nk] = f;
    return nk;
  };
  const valRef = (v: any, i: number) => {
    const vk = `:v${i}`;
    values[vk] = v;
    return vk;
  };

  // Tier 1: PK equality (and optional SK for composite)
  const pkEq = where.filter(
    (w: Where) =>
      (!w.operator || w.operator === "eq") &&
      (!w.connector || w.connector !== "OR"),
  );
  const pkMatch = pkEq.find((w: Where) => w.field === schema.pkField);
  const skMatch = schema.skField
    ? pkEq.find((w: Where) => w.field === schema.skField)
    : undefined;

  if (pkMatch && (schema.skField ? skMatch : true)) {
    const key: Record<string, any> = { [schema.pkField]: pkMatch.value };
    if (schema.skField && skMatch) {
      key[schema.skField] = skMatch.value;
    }
    return {
      operation: "getItem",
      key,
      expressionAttributeNames: {},
      expressionAttributeValues: {},
    };
  }

  // Tier 2: Check for GSI match
  const nonOr = where.filter(
    (w: Where) => !w.connector || w.connector !== "OR",
  );
  const modelIndexes = config.indexes?.[model];

  if (modelIndexes && nonOr.length > 0) {
    for (const w of nonOr) {
      const gsiDecl = modelIndexes[w.field];
      if (gsiDecl && (!w.operator || w.operator === "eq")) {
        const fRef = fieldName(w.field, Object.keys(names).length);
        const vRef = valRef(w.value, Object.keys(values).length);

        let sortCondition = "";
        if (gsiDecl.rangeKey) {
          const skW = nonOr.find(
            (rw: Where) => rw.field === gsiDecl.rangeKey && rw !== w,
          );
          if (skW) {
            const skRef = fieldName(gsiDecl.rangeKey, Object.keys(names).length);
            const skValRef = valRef(skW.value, Object.keys(values).length);
            sortCondition = ` AND ${skRef} = ${skValRef}`;
          }
        }

        const rest = nonOr.filter(
          (rw: Where) => rw !== w && rw.field !== gsiDecl.rangeKey,
        );
        const ors = where.filter((rw: Where) => rw.connector === "OR");
        const extra = [...rest, ...ors];
        const filter = buildSimpleFilter(extra, fieldName, valRef, names, values);

        return {
          operation: "query",
          indexName: gsiDecl.indexName,
          keyCondition: `${fRef} = ${vRef}${sortCondition}`,
          ...(filter ? { filterExpression: filter } : {}),
          expressionAttributeNames: names,
          expressionAttributeValues: values,
          needsFollowUpGetItem: gsiDecl.projection === "KEYS_ONLY",
        };
      }
    }
  }

  // Tier 3: Scan
  const filter = where.length
    ? buildSimpleFilter(where, fieldName, valRef, names, values)
    : undefined;

  return {
    operation: "scan",
    ...(filter ? { filterExpression: filter } : {}),
    expressionAttributeNames: names,
    expressionAttributeValues: values,
  };
}

async function _findItems(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  plan: DeleteManyPlan,
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
          ExpressionAttributeNames: plan.expressionAttributeNames,
          ExpressionAttributeValues: plan.expressionAttributeValues,
          ExclusiveStartKey: lastEvaluatedKey,
        } as any),
      );
      if (result.Items) items.push(...(result.Items as any[]));
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    // Follow-up GetItem for KEYS_ONLY GSIs
    if (plan.needsFollowUpGetItem && items.length > 0) {
      const fullItems: Record<string, any>[] = [];
      for (const gsiItem of items) {
        const key: Record<string, any> = { [schema.pkField]: gsiItem[schema.pkField] };
        if (schema.skField && gsiItem[schema.skField] !== undefined) {
          key[schema.skField] = gsiItem[schema.skField];
        }
        const fuResult = await docClient.send(
          new GetCommand({ TableName: tableName, Key: key }),
        );
        if (fuResult.Item) {
          fullItems.push(fuResult.Item as any);
        }
      }
      return fullItems;
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
        ExpressionAttributeNames: plan.expressionAttributeNames,
        ExpressionAttributeValues: plan.expressionAttributeValues,
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
    // Exponential backoff: 100ms, 200ms, 400ms
    await new Promise((resolve) =>
      setTimeout(resolve, Math.pow(2, attempt - 1) * 100),
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

function buildSimpleFilter(
  where: Where[],
  fieldName: (f: string, i: number) => string,
  valRef: (v: any, i: number) => string,
  names: Record<string, string>,
  values: Record<string, any>,
): string {
  if (where.length === 0) return "";

  const parts: string[] = [];

  for (const w of where) {
    const fRef = fieldName(w.field, Object.keys(names).length);
    if (w.operator === "in" && Array.isArray(w.value)) {
      const refs = w.value.map((v: any) => valRef(v, Object.keys(values).length));
      parts.push(`${fRef} IN (${refs.join(", ")})`);
    } else if (w.operator === "gt")
      parts.push(`${fRef} > ${valRef(w.value, Object.keys(values).length)}`);
    else if (w.operator === "gte")
      parts.push(`${fRef} >= ${valRef(w.value, Object.keys(values).length)}`);
    else if (w.operator === "lt")
      parts.push(`${fRef} < ${valRef(w.value, Object.keys(values).length)}`);
    else if (w.operator === "lte")
      parts.push(`${fRef} <= ${valRef(w.value, Object.keys(values).length)}`);
    else if (w.operator === "ne")
      parts.push(`${fRef} <> ${valRef(w.value, Object.keys(values).length)}`);
    else if (w.operator === "starts_with")
      parts.push(`begins_with(${fRef}, ${valRef(w.value, Object.keys(values).length)})`);
    else if (w.operator === "contains")
      parts.push(`contains(${fRef}, ${valRef(w.value, Object.keys(values).length)})`);
    else
      parts.push(`${fRef} = ${valRef(w.value, Object.keys(values).length)}`);
  }

  const andW = where.filter((w: Where) => !w.connector || w.connector !== "OR");
  const orW = where.filter((w: Where) => w.connector === "OR");

  if (andW.length && orW.length) {
    const andPart = parts.slice(0, andW.length).join(" AND ");
    const orPart = parts.slice(andW.length).join(" OR ");
    return `(${andPart}) AND (${orPart})`;
  }
  if (orW.length) return parts.join(" OR ");
  return parts.join(" AND ");
}
