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
  QueryCommand,
  ScanCommand,
  BatchWriteCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBAdapterConfig } from "../../types";
import { getKeySchema } from "../../helpers/key-builder";
import { buildExpressionNames, compactExpr } from "../../helpers/expression-names";
import { resolveFilter } from "../../helpers/query-planner";

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
 * Finds all items matching the where clause.
 * Tier 2: GSI Query when an eq operator matches a declared GSI hash key.
 * Tier 3: Scan with FilterExpression via resolveFilter.
 */
async function _findItems(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  where: Where[],
  model: string,
  schema: { pkField: string; skField?: string },
  config: DynamoDBAdapterConfig,
): Promise<Record<string, any>[]> {
  // No where clause → full table Scan
  if (!where || where.length === 0) {
    return _scanAll(docClient, tableName);
  }

  // ── Tier 2: GSI check ────────────────────────────────────
  const nonOr = where.filter(
    (w: Where) => !w.connector || w.connector !== "OR",
  );
  const modelIndexes = config.indexes?.[model];

  if (modelIndexes && nonOr.length > 0) {
    for (const w of nonOr) {
      const gsiDecl = modelIndexes[w.field];
      if (gsiDecl && (!w.operator || w.operator === "eq")) {
        // Build the GSI Query plan
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

        // Remaining clauses become FilterExpression via resolveFilter
        const rest = nonOr.filter(
          (rw: Where) => rw !== w && rw.field !== gsiDecl.rangeKey,
        );
        const ors = where.filter((rw: Where) => rw.connector === "OR");
        const extra = [...rest, ...ors];

        let filterExpr: string | undefined;
        if (extra.length > 0) {
          const f = resolveFilter(extra, model, config);
          if (f) {
            Object.assign(names, f.expressionAttributeNames);
            Object.assign(values, f.expressionAttributeValues);
            filterExpr = f.expression;
          }
        }

        const items = await _queryAll(docClient, tableName, {
          indexName: gsiDecl.indexName,
          keyCondition: `${fRef} = ${vRef}${sortCondition}`,
          filterExpression: filterExpr,
          expressionAttributeNames: names,
          expressionAttributeValues: values,
        });

        // KEYS_ONLY follow-up
        if (gsiDecl.projection === "KEYS_ONLY" && items.length > 0) {
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
    }
  }

  // ── Tier 3: Scan ─────────────────────────────────────────
  if (config.debugLogs) {
    console.warn(
      `[dynamodb-adapter] updateMany on ${model} using Scan (Tier 3). ` +
        `Consider adding a GSI for the queried field(s).`,
    );
  }

  const filter = resolveFilter(where, model, config);
  return _scanAll(
    docClient,
    tableName,
    filter?.expression,
    filter?.expressionAttributeNames,
    filter?.expressionAttributeValues,
  );
}

// ── Paginated helpers ───────────────────────────────────────────

async function _queryAll(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  params: {
    indexName: string;
    keyCondition: string;
    filterExpression?: string;
    expressionAttributeNames: Record<string, string>;
    expressionAttributeValues: Record<string, any>;
  },
): Promise<Record<string, any>[]> {
  const items: Record<string, any>[] = [];
  let lastKey: Record<string, any> | undefined;

  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: params.indexName,
        KeyConditionExpression: params.keyCondition,
        FilterExpression: params.filterExpression || undefined,
        ...compactExpr(params.expressionAttributeNames, params.expressionAttributeValues),
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

// ── Item update ─────────────────────────────────────────────────

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

// ── Batch Put (unsafeBatchUpdate) ───────────────────────────────

async function _batchPutUpdate(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  items: Record<string, any>[],
  update: Record<string, any>,
  config: DynamoDBAdapterConfig,
): Promise<number> {
  if (config.debugLogs) {
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
