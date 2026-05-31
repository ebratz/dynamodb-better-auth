/**
 * findMany method — per DESIGN.md §5 (findMany method) + review-gap fix D.
 *
 * Tier 2: Query on GSI, paginate with ExclusiveStartKey.
 *   - offset > 0 throws UnsupportedOptionError.
 *   - sortBy matches sort key → native ScanIndexForward.
 *   - KEYS_ONLY GSI → BatchGetCommand for full rows.
 *
 * Tier 3: Scan + FilterExpression.
 *   - If sortBy is set: fetch ALL pages, sort client-side, slice to limit.
 *     Emits "full-table sort+limit" warning (gap D fix).
 *   - If no sortBy: apply Limit during scan, stop early.
 *   - Client-side offset via discard (logged warning).
 */

import {
  QueryCommand,
  ScanCommand,
  BatchGetCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBAdapterConfig } from "../../types";
import { getKeySchema } from "../../helpers/key-builder";
import { UnsupportedOptionError } from "../../errors";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Where = any;

export function findManyMethod(
  docClient: DynamoDBDocumentClient,
  config: DynamoDBAdapterConfig
) {
  return async (args: {
    model: string;
    where?: Where[];
    limit?: number;
    offset?: number;
    sortBy?: { field: string; direction: "asc" | "desc" };
    select?: string[];
    join?: any;
  }): Promise<Record<string, any>[]> => {
    const tableName = config.tables[args.model];
    if (!tableName) {
      throw new Error(`No table configured for model "${args.model}"`);
    }

    const schema = getKeySchema(args.model, config);
    const plan = resolveFindManyPlan(args, args.model, schema, config, tableName);

    // ── Tier 2: Query on GSI ─────────────────────────────────
    if (plan.operation === "query") {
      if ((args.offset ?? 0) > 0) {
        throw new UnsupportedOptionError(
          "offset",
          "Tier 2 (GSI Query) does not support offset. Use ExclusiveStartKey for cursor-based pagination."
        );
      }

      let items: Record<string, any>[] = [];
      let lastEvaluatedKey: Record<string, any> | undefined;
      const limit = args.limit ?? 100;

      do {
        const result = await docClient.send(
          new QueryCommand({
            TableName: tableName,
            IndexName: plan.indexName!,
            KeyConditionExpression: plan.keyCondition!,
            FilterExpression: plan.filterExpression || undefined,
            ExpressionAttributeNames: plan.expressionAttributeNames,
            ExpressionAttributeValues: plan.expressionAttributeValues,
            Limit: limit + (args.offset ?? 0),
            ScanIndexForward: args.sortBy?.direction !== "desc",
            ExclusiveStartKey: lastEvaluatedKey,
          } as any)
        );

        if (result.Items) items.push(...(result.Items as any[]));
        lastEvaluatedKey = result.LastEvaluatedKey;
      } while (lastEvaluatedKey && items.length < limit);

      // Client-side sort if sort field doesn't match GSI sort key
      if (args.sortBy && plan.needsClientSideSort) {
        if (config.debugLogs) {
          console.warn(
            `[dynamodb-adapter] findMany on ${args.model}: sortBy field ` +
            `"${args.sortBy.field}" does not match sort key — sorting client-side.`
          );
        }
        const dir = args.sortBy.direction === "desc" ? -1 : 1;
        items.sort((a, b) => {
          const av = a[args.sortBy!.field];
          const bv = b[args.sortBy!.field];
          if (av < bv) return -1 * dir;
          if (av > bv) return 1 * dir;
          return 0;
        });
      }

      items = items.slice(0, limit);

      // Follow-up BatchGetItem for KEYS_ONLY GSIs
      if (plan.needsFollowUpGetItem && items.length > 0) {
        return resolveKEYS_ONLY(docClient, tableName, plan, items);
      }

      return items;
    }

    // ── Tier 3: Scan + Filter ────────────────────────────────
    let items: Record<string, any>[] = [];
    let lastEvaluatedKey: Record<string, any> | undefined;
    const limit = args.limit ?? 100;

    // Gap D fix: if sortBy is set, fetch ALL pages first
    if (args.sortBy) {
      if (config.debugLogs) {
        console.warn(
          `[dynamodb-adapter] findMany on ${args.model} using Scan with sortBy — ` +
          `fetching all matching items for client-side sort. Add a GSI to avoid this.`
        );
      }

      do {
        const result = await docClient.send(
          new ScanCommand({
            TableName: tableName,
            FilterExpression: plan.filterExpression || undefined,
            ExpressionAttributeNames: plan.expressionAttributeNames,
            ExpressionAttributeValues: plan.expressionAttributeValues,
            ExclusiveStartKey: lastEvaluatedKey,
          } as any)
        );
        if (result.Items) items.push(...(result.Items as any[]));
        lastEvaluatedKey = result.LastEvaluatedKey;
      } while (lastEvaluatedKey);

      // Client-side sort
      const dir = args.sortBy.direction === "desc" ? -1 : 1;
      items.sort((a, b) => {
        const av = a[args.sortBy!.field];
        const bv = b[args.sortBy!.field];
        if (av < bv) return -1 * dir;
        if (av > bv) return 1 * dir;
        return 0;
      });

      // Client-side offset
      if (args.offset && args.offset > 0) {
        if (config.debugLogs) {
          console.warn(
            `[dynamodb-adapter] findMany client-side offset ${args.offset} on ${args.model} — ` +
            `skipped items still consumed RCU.`
          );
        }
        items = items.slice(args.offset);
      }

      return items.slice(0, limit);
    }

    // No sortBy — apply Limit during Scan, stop early
    do {
      const scanLimit = limit + (args.offset ?? 0) - items.length;
      if (scanLimit <= 0) break;

      const result = await docClient.send(
        new ScanCommand({
          TableName: tableName,
          FilterExpression: plan.filterExpression || undefined,
          ExpressionAttributeNames: plan.expressionAttributeNames,
          ExpressionAttributeValues: plan.expressionAttributeValues,
          Limit: scanLimit,
          ExclusiveStartKey: lastEvaluatedKey,
        } as any)
      );
      if (result.Items) items.push(...(result.Items as any[]));
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey && items.length < limit + (args.offset ?? 0));

    // Client-side offset via discard
    if (args.offset && args.offset > 0) {
      if (config.debugLogs) {
        console.warn(
          `[dynamodb-adapter] findMany client-side offset ${args.offset} on ${args.model} — ` +
          `discarded items still consumed RCU.`
        );
      }
      items = items.slice(args.offset);
    }

    return items.slice(0, limit);
  };
}

// ── Internal helpers ───────────────────────────────────────────

interface FindManyPlan {
  operation: "query" | "scan";
  indexName?: string;
  keyCondition?: string;
  filterExpression?: string;
  expressionAttributeNames: Record<string, string>;
  expressionAttributeValues: Record<string, any>;
  needsClientSideSort?: boolean;
  needsFollowUpGetItem?: boolean;
  followUpKeyFields?: { pkField: string; skField?: string };
}

function resolveFindManyPlan(
  args: { where?: Where[]; sortBy?: { field: string; direction: string } },
  model: string,
  schema: { pkField: string; skField?: string },
  config: DynamoDBAdapterConfig,
  tableName: string
): FindManyPlan {
  const names: Record<string, string> = {};
  const values: Record<string, any> = {};
  const where = args.where ?? [];

  const fieldName = (f: string, i: number) => { const nk = `#n${i}`; names[nk] = f; return nk; };
  const valRef = (v: any, i: number) => { const vk = `:v${i}`; values[vk] = v; return vk; };

  // Tier 2: Check for GSI match
  const nonOr = where.filter(w => !w.connector || w.connector !== "OR");
  const modelIndexes = config.indexes?.[model];

  if (modelIndexes && nonOr.length > 0) {
    for (const w of nonOr) {
      const gsiDecl = modelIndexes[w.field];
      if (gsiDecl && (!w.operator || w.operator === "eq")) {
        const fRef = fieldName(w.field, Object.keys(names).length);
        const vRef = valRef(w.value, Object.keys(values).length);

        let sortCondition = "";
        let nativeSort = false;
        if (gsiDecl.rangeKey) {
          const skW = nonOr.find(rw => rw.field === gsiDecl.rangeKey && rw !== w);
          if (skW) {
            const skRef = fieldName(gsiDecl.rangeKey, Object.keys(names).length);
            const skValRef = valRef(skW.value, Object.keys(values).length);
            if (skW.operator === "lt")        { sortCondition = ` AND ${skRef} < ${skValRef}`; nativeSort = true; }
            else if (skW.operator === "lte")  { sortCondition = ` AND ${skRef} <= ${skValRef}`; nativeSort = true; }
            else if (skW.operator === "gt")   { sortCondition = ` AND ${skRef} > ${skValRef}`; nativeSort = true; }
            else if (skW.operator === "gte")  { sortCondition = ` AND ${skRef} >= ${skValRef}`; nativeSort = true; }
            else if (skW.operator === "starts_with") { sortCondition = ` AND begins_with(${skRef}, ${skValRef})`; }
            else sortCondition = ` AND ${skRef} = ${skValRef}`;
          }
        }

        const rest = nonOr.filter(rw => rw !== w && rw.field !== gsiDecl.rangeKey);
        const ors = where.filter(rw => rw.connector === "OR");
        const extra = [...rest, ...ors];

        return {
          operation: "query",
          indexName: gsiDecl.indexName,
          keyCondition: `${fRef} = ${vRef}${sortCondition}`,
          ...(extra.length ? {
            filterExpression: buildSimpleFilter(extra, fieldName, valRef, names, values),
          } : {}),
          expressionAttributeNames: names,
          expressionAttributeValues: values,
          needsClientSideSort: args.sortBy
            ? args.sortBy.field !== gsiDecl.rangeKey
            : false,
          needsFollowUpGetItem: gsiDecl.projection === "KEYS_ONLY",
          followUpKeyFields: gsiDecl.projection === "KEYS_ONLY"
            ? { pkField: schema.pkField, skField: schema.skField }
            : undefined,
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

function buildSimpleFilter(
  where: Where[],
  fieldName: (f: string, i: number) => string,
  valRef: (v: any, i: number) => string,
  names: Record<string, string>,
  values: Record<string, any>
): string {
  const parts: string[] = [];

  for (const w of where) {
    const fRef = fieldName(w.field, Object.keys(names).length);
    if (w.operator === "in" && Array.isArray(w.value)) {
      const refs = w.value.map((v: any) => valRef(v, Object.keys(values).length));
      parts.push(`${fRef} IN (${refs.join(", ")})`);
    } else if (w.operator === "gt")           parts.push(`${fRef} > ${valRef(w.value, Object.keys(values).length)}`);
    else if (w.operator === "gte")            parts.push(`${fRef} >= ${valRef(w.value, Object.keys(values).length)}`);
    else if (w.operator === "lt")             parts.push(`${fRef} < ${valRef(w.value, Object.keys(values).length)}`);
    else if (w.operator === "lte")            parts.push(`${fRef} <= ${valRef(w.value, Object.keys(values).length)}`);
    else if (w.operator === "ne")             parts.push(`${fRef} <> ${valRef(w.value, Object.keys(values).length)}`);
    else if (w.operator === "starts_with")    parts.push(`begins_with(${fRef}, ${valRef(w.value, Object.keys(values).length)})`);
    else if (w.operator === "contains")       parts.push(`contains(${fRef}, ${valRef(w.value, Object.keys(values).length)})`);
    else parts.push(`${fRef} = ${valRef(w.value, Object.keys(values).length)}`);
  }

  const andW = where.filter(w => !w.connector || w.connector !== "OR");
  const orW = where.filter(w => w.connector === "OR");

  if (andW.length && orW.length) {
    const andPart = parts.slice(0, andW.length).join(" AND ");
    const orPart = parts.slice(andW.length).join(" OR ");
    return `(${andPart}) AND (${orPart})`;
  }
  if (orW.length) return parts.join(" OR ");
  return parts.join(" AND ");
}

async function resolveKEYS_ONLY(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  plan: FindManyPlan,
  items: Record<string, any>[]
): Promise<Record<string, any>[]> {
  // Build BatchGetCommand keys
  const keys = items.map(item => {
    const k: Record<string, any> = { [plan.followUpKeyFields!.pkField]: item[plan.followUpKeyFields!.pkField] };
    if (plan.followUpKeyFields?.skField && item[plan.followUpKeyFields.skField] !== undefined) {
      k[plan.followUpKeyFields.skField] = item[plan.followUpKeyFields.skField];
    }
    return k;
  });

  // BatchGetItem in chunks of 100
  const results: Record<string, any>[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const result = await docClient.send(
      new BatchGetCommand({
        RequestItems: {
          [tableName]: {
            Keys: chunk,
          },
        },
      })
    );
    const responses = (result.Responses as any)?.[tableName];
    if (responses) results.push(...responses);
  }

  return results;
}
