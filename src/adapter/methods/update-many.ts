/**
 * updateMany method — per DESIGN.md §5 (updateMany method) + accepted R6.
 *
 * Returns the count of successfully updated items.
 *
 * Standard path: find matching items → parallel UpdateItem calls
 *   (concurrency-limited, default 10). Field-level SET #f = :v semantics
 *   preserve concurrent writes to different fields (no lost-update hazard).
 *
 * unsafeBatchUpdate path: BatchWriteCommand+Put (full-item overwrite, LWW).
 *
 * On partial failure: throw AggregateError with per-item errors.
 * Successful updates remain committed (non-transactional by design).
 */

import {
  UpdateCommand,
  QueryCommand,
  ScanCommand,
  BatchWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBAdapterConfig } from "../../types";
import { getKeySchema } from "../../helpers/key-builder";
import { buildExpressionNames } from "../../helpers/expression-names";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Where = any;

export function updateManyMethod(
  docClient: DynamoDBDocumentClient,
  config: DynamoDBAdapterConfig,
) {
  return async (args: {
    model: string;
    where: Where[];
    update: Record<string, any>;
  }): Promise<number> => {
    const { model, where, update } = args;
    const tableName = config.tables[model];
    if (!tableName) {
      throw new Error(`No table configured for model "${model}"`);
    }
    const schema = getKeySchema(model, config);

    if (Object.keys(update).length === 0) return 0;

    // ── Find matching items ───────────────────────────────────
    const items = await _findItems(docClient, tableName, where, model, schema, config);

    if (items.length === 0) return 0;

    // ── unsafeBatchUpdate path ────────────────────────────────
    if (config.unsafeBatchUpdate) {
      return _batchPutUpdate(docClient, tableName, items, update, schema, config);
    }

    // ── Standard path: parallel UpdateItem ────────────────────
    const concurrency = config.updateManyConcurrency ?? 10;
    const { results, errors } = await _parallelLimit(
      items,
      concurrency,
      (item) => _updateOne(docClient, tableName, item, update, schema),
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

// ── Internal helpers ───────────────────────────────────────────

interface FindPlan {
  operation: "query" | "scan";
  indexName?: string;
  keyCondition?: string;
  filterExpression?: string;
  expressionAttributeNames: Record<string, string>;
  expressionAttributeValues: Record<string, any>;
  needsFollowUpGetItem?: boolean;
  followUpKeyFields?: { pkField: string; skField?: string };
}

function buildSimpleFilter(
  where: Where[],
  fieldName: (f: string, i: number) => string,
  valRef: (v: any, i: number) => string,
  names: Record<string, string>,
  values: Record<string, any>,
): string {
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

async function _findItems(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  where: Where[],
  model: string,
  schema: { pkField: string; skField?: string },
  config: DynamoDBAdapterConfig,
): Promise<Record<string, any>[]> {
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

  // No where clause → Scan all
  if (!where || where.length === 0) {
    return _scanAll(docClient, tableName);
  }

  // Tier 2: Check for GSI
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
        const filter = rest.length
          ? buildSimpleFilter(rest, fieldName, valRef, names, values)
          : undefined;

        return _queryAll(docClient, tableName, {
          operation: "query",
          indexName: gsiDecl.indexName,
          keyCondition: `${fRef} = ${vRef}${sortCondition}`,
          ...(filter ? { filterExpression: filter } : {}),
          expressionAttributeNames: names,
          expressionAttributeValues: values,
          needsFollowUpGetItem: gsiDecl.projection === "KEYS_ONLY",
          followUpKeyFields:
            gsiDecl.projection === "KEYS_ONLY"
              ? { pkField: schema.pkField, skField: schema.skField }
              : undefined,
        });
      }
    }
  }

  // Tier 3: Scan
  const filter = buildSimpleFilter(where, fieldName, valRef, names, values);
  if (config.debugLogs) {
    console.warn(
      `[dynamodb-adapter] updateMany on ${model} using Scan (Tier 3). ` +
        `Consider adding a GSI for the queried field(s).`,
    );
  }
  return _scanAll(docClient, tableName, filter, names, values);
}

async function _queryAll(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  plan: FindPlan,
): Promise<Record<string, any>[]> {
  const items: Record<string, any>[] = [];
  let lastKey: Record<string, any> | undefined;

  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: plan.indexName!,
        KeyConditionExpression: plan.keyCondition!,
        FilterExpression: plan.filterExpression || undefined,
        ExpressionAttributeNames: plan.expressionAttributeNames,
        ExpressionAttributeValues: plan.expressionAttributeValues,
        ExclusiveStartKey: lastKey,
      } as any),
    );
    if (result.Items) items.push(...(result.Items as any[]));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return items;
}

async function _scanAll(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  filterExpression?: string,
  names?: Record<string, string>,
  values?: Record<string, any>,
): Promise<Record<string, any>[]> {
  const items: Record<string, any>[] = [];
  let lastKey: Record<string, any> | undefined;

  do {
    const result = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        ...(filterExpression
          ? { FilterExpression: filterExpression }
          : {}),
        ...(names ? { ExpressionAttributeNames: names } : {}),
        ...(values ? { ExpressionAttributeValues: values } : {}),
        ExclusiveStartKey: lastKey,
      } as any),
    );
    if (result.Items) items.push(...(result.Items as any[]));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return items;
}

async function _updateOne(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  item: Record<string, any>,
  update: Record<string, any>,
  schema: { pkField: string; skField?: string },
): Promise<boolean> {
  const key: Record<string, any> = { [schema.pkField]: item[schema.pkField] };
  if (schema.skField) key[schema.skField] = item[schema.skField!];

  const { names: attrNames, toRef, toValueRef } = buildExpressionNames(
    Object.keys(update),
  );
  const attrValues: Record<string, any> = {};
  const setClauses: string[] = [];

  for (const field of Object.keys(update)) {
    const ref = toRef(field);
    const valRef = toValueRef();
    setClauses.push(`${ref} = ${valRef}`);
    attrValues[valRef] = update[field];
  }

  await docClient.send(
    new UpdateCommand({
      TableName: tableName,
      Key: key,
      UpdateExpression: `SET ${setClauses.join(", ")}`,
      ExpressionAttributeNames: attrNames,
      ExpressionAttributeValues: attrValues,
    }),
  );

  return true;
}

async function _batchPutUpdate(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  items: Record<string, any>[],
  update: Record<string, any>,
  schema: { pkField: string; skField?: string },
  config: DynamoDBAdapterConfig,
): Promise<number> {
  if (config.debugLogs) {
    console.warn(
      `[dynamodb-adapter] updateMany using unsafeBatchUpdate — ` +
        `full-item overwrite (last-write-wins).`,
    );
  }

  let updated = 0;

  // Chunk into batches of 25
  for (let i = 0; i < items.length; i += 25) {
    const chunk = items.slice(i, i + 25);
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

    // Retry UnprocessedItems up to 3 times
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

    updated += chunk.length;
  }

  return updated;
}

// ── Concurrency limiter ───────────────────────────────────────

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
