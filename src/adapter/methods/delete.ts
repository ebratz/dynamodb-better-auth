/**
 * delete method — per DESIGN.md §5 (delete method).
 *
 * Deletes a single item identified by the where clause.
 *
 * Tier 1: DeleteCommand on resolved PK (or composite PK+SK).
 * Tier 2/3: inline _findOneItem to locate the row, extract PK+SK,
 *           then DeleteCommand on the resolved key.
 *           Missing item → silently OK (no-op).
 */

import { DeleteCommand, QueryCommand, ScanCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBAdapterConfig } from "../../types";
import { getKeySchema } from "../../helpers/key-builder";
import { getTableName } from "../client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Where = any;

export function deleteMethod(
  docClient: DynamoDBDocumentClient,
  config: DynamoDBAdapterConfig,
) {
  return async (args: {
    model: string;
    where: Where[];
  }): Promise<void> => {
    const { model, where } = args;
    const tableName = getTableName(model, config);
    const schema = getKeySchema(model, config);

    // ── Resolve key ───────────────────────────────────────────
    const plan = resolveDeletePlan(where, model, schema, config);

    let key: Record<string, any>;
    if (plan.key) {
      key = plan.key;
    } else {
      // Tier 2/3: findOne to extract key
      const item = await _findOneItem(docClient, tableName, plan, config, model);
      if (!item) return; // silently OK
      key = { [schema.pkField]: item[schema.pkField] };
      if (schema.skField && item[schema.skField] !== undefined) {
        key[schema.skField] = item[schema.skField];
      }
    }

    // ── Execute DeleteItem ────────────────────────────────────
    await docClient.send(
      new DeleteCommand({
        TableName: tableName,
        Key: key,
      }),
    );
  };
}

// ── Internal helpers ───────────────────────────────────────────

interface DeletePlan {
  operation: "getItem" | "query" | "scan";
  key?: Record<string, any>;
  indexName?: string;
  keyCondition?: string;
  filterExpression?: string;
  expressionAttributeNames: Record<string, string>;
  expressionAttributeValues: Record<string, any>;
  needsFollowUpGetItem?: boolean;
}

function resolveDeletePlan(
  where: Where[],
  model: string,
  schema: { pkField: string; skField?: string },
  config: DynamoDBAdapterConfig,
): DeletePlan {
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
        const filter = buildSimpleFilter(rest, fieldName, valRef, names, values);

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
  const filter = buildSimpleFilter(where, fieldName, valRef, names, values);
  return {
    operation: "scan",
    ...(filter ? { filterExpression: filter } : {}),
    expressionAttributeNames: names,
    expressionAttributeValues: values,
  };
}

async function _findOneItem(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  plan: DeletePlan,
  config: DynamoDBAdapterConfig,
  model: string,
): Promise<Record<string, any> | null> {
  if (plan.operation === "query") {
    const result = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: plan.indexName!,
        KeyConditionExpression: plan.keyCondition!,
        FilterExpression: plan.filterExpression || undefined,
        ExpressionAttributeNames: plan.expressionAttributeNames,
        ExpressionAttributeValues: plan.expressionAttributeValues,
        Limit: 1,
      } as any),
    );

    const items = result.Items ?? [];

    if (plan.needsFollowUpGetItem && items.length > 0) {
      const item = items[0]! as Record<string, any>;
      const schema = getKeySchema(model, config);
      const key: Record<string, any> = { [schema.pkField]: item[schema.pkField] };
      if (schema.skField && item[schema.skField] !== undefined) {
        key[schema.skField] = item[schema.skField];
      }
      const fuResult = await docClient.send(
        new GetCommand({ TableName: tableName, Key: key }),
      );
      return (fuResult.Item as any) ?? null;
    }

    return (items[0] as any) ?? null;
  }

  // Scan
  if (config.debugLogs) {
    const debug =
      typeof config.debugLogs === "object" ? config.debugLogs : {};
    if (debug.delete !== false) {
      console.warn(
        `[dynamodb-adapter] delete on ${model} using Scan (Tier 3). ` +
          `Consider adding a GSI for the queried field(s).`,
      );
    }
  }

  const result = await docClient.send(
    new ScanCommand({
      TableName: tableName,
      FilterExpression: plan.filterExpression || undefined,
      ExpressionAttributeNames: plan.expressionAttributeNames,
      ExpressionAttributeValues: plan.expressionAttributeValues,
      Limit: 1,
    } as any),
  );

  return (result.Items?.[0] as any) ?? null;
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
