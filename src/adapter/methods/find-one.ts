/**
 * findOne method — per DESIGN.md §5 (findOne method).
 *
 * Resolves query plan via three-tier strategy:
 *   Tier 1: GetItem on PK (or composite PK+SK)
 *   Tier 2: Query on GSI with Limit:1
 *   Tier 3: Scan + FilterExpression with Limit:1
 *
 * KEYS_ONLY GSIs: follow-up GetItem on base table for full item.
 * Joins are ignored (supportsJoin: false).
 */

import {
  GetCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBAdapterConfig } from "../../types";
import { getKeySchema } from "../../helpers/key-builder";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Where = any;

export function findOneMethod(
  docClient: DynamoDBDocumentClient,
  config: DynamoDBAdapterConfig
) {
  return async (args: {
    model: string;
    where: Where[];
    select?: string[];
    join?: any;
  }): Promise<Record<string, any> | null> => {
    const tableName = config.tables[args.model];
    if (!tableName) {
      throw new Error(`No table configured for model "${args.model}"`);
    }

    const schema = getKeySchema(args.model, config);
    const plan = resolveFindOnePlan(args.where, args.model, schema, config);

    if (config.debugLogs && plan.tier === 3) {
      const debug = typeof config.debugLogs === "object" ? config.debugLogs : {};
      if (debug.findOne !== false) {
        console.warn(
          `[dynamodb-adapter] findOne on ${args.model} using Scan (Tier 3). ` +
          `Consider adding a GSI for the queried field(s).`
        );
      }
    }

    // ── Tier 1: GetItem ──────────────────────────────────────
    if (plan.operation === "getItem") {
      const result = await docClient.send(
        new GetCommand({
          TableName: tableName,
          Key: plan.key!,
        })
      );
      return (result.Item as any) ?? null;
    }

    // ── Tier 2: Query on GSI ─────────────────────────────────
    if (plan.operation === "query") {
      const result = await docClient.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: plan.indexName,
          KeyConditionExpression: plan.keyCondition,
          FilterExpression: plan.filterExpression || undefined,
          ExpressionAttributeNames: plan.expressionAttributeNames,
          ExpressionAttributeValues: plan.expressionAttributeValues,
          Limit: 1,
        } as any)
      );

      const items = result.Items ?? [];

      // Follow-up GetItem for KEYS_ONLY GSIs
      if (plan.needsFollowUpGetItem && items.length > 0) {
        const item = items[0]! as Record<string, any>;
        const fk = plan.followUpKeyFields!;
        const key: Record<string, any> = { [fk.pkField]: item[fk.pkField] };
        if (fk.skField && item[fk.skField] !== undefined) {
          key[fk.skField] = item[fk.skField];
        }
        const fuResult = await docClient.send(
          new GetCommand({
            TableName: tableName,
            Key: key,
          })
        );
        return (fuResult.Item as any) ?? null;
      }

      return (items[0] as any) ?? null;
    }

    // ── Tier 3: Scan + Filter ────────────────────────────────
    const result = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: plan.filterExpression,
        ExpressionAttributeNames: plan.expressionAttributeNames,
        ExpressionAttributeValues: plan.expressionAttributeValues,
        Limit: 1,
      } as any)
    );

    return (result.Items?.[0] as any) ?? null;
  };
}

// ── Internal query planner (simplified; full impl in H4) ──────

interface FindOnePlan {
  tier: 1 | 2 | 3;
  operation: "getItem" | "query" | "scan";
  indexName?: string;
  key?: Record<string, any>;
  keyCondition?: string;
  filterExpression?: string;
  expressionAttributeNames: Record<string, string>;
  expressionAttributeValues: Record<string, any>;
  needsFollowUpGetItem?: boolean;
  followUpKeyFields?: { pkField: string; skField?: string };
}

function resolveFindOnePlan(
  where: Where[],
  model: string,
  schema: { pkField: string; skField?: string },
  config: DynamoDBAdapterConfig
): FindOnePlan {
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

  // Tier 1: PK equality
  const pkEq = where.filter(w => (!w.operator || w.operator === "eq") && (!w.connector || w.connector !== "OR"));
  const pkMatch = pkEq.find(w => w.field === schema.pkField);
  const skMatch = schema.skField ? pkEq.find(w => w.field === schema.skField) : undefined;

  if (pkMatch && (schema.skField ? skMatch : true)) {
    const key: Record<string, any> = {
      [schema.pkField]: pkMatch.value,
    };
    if (schema.skField && skMatch) {
      key[schema.skField] = skMatch.value;
    }
    const rest = pkEq.filter(w => w !== pkMatch && w !== skMatch);
    const ors = where.filter(w => w.connector === "OR");
    const extra = [...rest, ...ors];
    return {
      tier: 1,
      operation: "getItem",
      key,
      ...(extra.length ? {
        filterExpression: buildSimpleFilterExpr(extra, fieldName, valRef, names, values),
      } : {}),
      expressionAttributeNames: names,
      expressionAttributeValues: values,
    };
  }

  // Tier 2: Check for GSI match
  const modelIndexes = config.indexes?.[model];
  if (modelIndexes) {
    for (const w of pkEq) {
      const gsiDecl = modelIndexes[w.field];
      if (gsiDecl) {
        // Check for sort key condition
        let sortCondition = "";
        if (gsiDecl.rangeKey) {
          const skW = pkEq.find(rw => rw.field === gsiDecl.rangeKey && rw !== w);
          if (skW) {
            const skRef = fieldName(gsiDecl.rangeKey, Object.keys(names).length);
            if (skW.operator === "lt")      sortCondition = ` AND ${skRef} < ${valRef(skW.value, Object.keys(values).length)}`;
            else if (skW.operator === "lte") sortCondition = ` AND ${skRef} <= ${valRef(skW.value, Object.keys(values).length)}`;
            else if (skW.operator === "gt")  sortCondition = ` AND ${skRef} > ${valRef(skW.value, Object.keys(values).length)}`;
            else if (skW.operator === "gte") sortCondition = ` AND ${skRef} >= ${valRef(skW.value, Object.keys(values).length)}`;
            else if (skW.operator === "starts_with") sortCondition = ` AND begins_with(${skRef}, ${valRef(skW.value, Object.keys(values).length)})`;
            else sortCondition = ` AND ${skRef} = ${valRef(skW.value, Object.keys(values).length)}`;
          }
        }

        const fRef = fieldName(w.field, Object.keys(names).length);
        const vRef = valRef(w.value, Object.keys(values).length);
        const keyCond = `${fRef} = ${vRef}${sortCondition}`;

        const rest = pkEq.filter(rw => rw !== w && rw.field !== gsiDecl.rangeKey);
        const ors = where.filter(rw => rw.connector === "OR");

        return {
          tier: 2,
          operation: "query",
          indexName: gsiDecl.indexName,
          keyCondition: keyCond,
          ...([...rest, ...ors].length ? {
            filterExpression: buildSimpleFilterExpr([...rest, ...ors], fieldName, valRef, names, values),
          } : {}),
          expressionAttributeNames: names,
          expressionAttributeValues: values,
          needsFollowUpGetItem: gsiDecl.projection === "KEYS_ONLY",
          followUpKeyFields: gsiDecl.projection === "KEYS_ONLY"
            ? { pkField: schema.pkField, skField: schema.skField }
            : undefined,
        };
      }
    }
  }

  // Tier 3: Scan
  const filter = buildSimpleFilterExpr(where, fieldName, valRef, names, values);
  return {
    tier: 3,
    operation: "scan",
    ...(filter ? { filterExpression: filter } : {}),
    expressionAttributeNames: names,
    expressionAttributeValues: values,
  };
}

function buildSimpleFilterExpr(
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
    } else if (w.operator === "gt")      parts.push(`${fRef} > ${valRef(w.value, Object.keys(values).length)}`);
    else if (w.operator === "gte")        parts.push(`${fRef} >= ${valRef(w.value, Object.keys(values).length)}`);
    else if (w.operator === "lt")         parts.push(`${fRef} < ${valRef(w.value, Object.keys(values).length)}`);
    else if (w.operator === "lte")        parts.push(`${fRef} <= ${valRef(w.value, Object.keys(values).length)}`);
    else if (w.operator === "ne")         parts.push(`${fRef} <> ${valRef(w.value, Object.keys(values).length)}`);
    else if (w.operator === "starts_with") parts.push(`begins_with(${fRef}, ${valRef(w.value, Object.keys(values).length)})`);
    else if (w.operator === "contains")   parts.push(`contains(${fRef}, ${valRef(w.value, Object.keys(values).length)})`);
    else parts.push(`${fRef} = ${valRef(w.value, Object.keys(values).length)}`);
  }

  // Separate AND/OR
  const andW = where.filter(w => !w.connector || w.connector !== "OR");
  const orW = where.filter(w => w.connector === "OR");

  const andPart = parts.slice(0, andW.length).join(" AND ");
  const orPart = parts.slice(andW.length).join(" OR ");

  if (andW.length && orW.length) return `(${andPart}) AND (${orPart})`;
  if (orW.length) return orPart;
  return andPart;
}
