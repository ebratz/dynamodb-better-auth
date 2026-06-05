/**
 * update method — per DESIGN.md §5 (update method) + accepted R3.
 *
 * Returns the full updated row (ReturnValues: "ALL_NEW").
 *
 * Uses centralized resolveQueryPlan for Tier 1–3 key resolution.
 * Tier 1: UpdateCommand on resolved PK (+SK) with ConditionExpression
 *         (attribute_exists) to prevent upsert on missing items.
 * Tier 2/3: Query/Scan + Limit:1 to find the row, extract key,
 *           then UpdateCommand. No PutItem fallback.
 *
 * PK/SK fields are stripped from the update payload to prevent
 * DynamoDB ValidationException on key-attribute mutation.
 */

import {
  UpdateCommand,
  GetCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBAdapterConfig } from "../../types";
import { getKeySchema } from "../../helpers/key-builder";
import { buildExpressionNames, compactExpr } from "../../helpers/expression-names";
import { resolveQueryPlan } from "../../helpers/query-planner";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Where = any;

export function updateMethod(
  docClient: DynamoDBDocumentClient,
  config: DynamoDBAdapterConfig,
) {
  return async (args: {
    model: string;
    where: Where[];
    update: Record<string, any>;
  }): Promise<Record<string, any> | null> => {
    const { model, where, update } = args;
    const tableName = config.tables[model];
    if (!tableName) {
      throw new Error(`No table configured for model "${model}"`);
    }
    const schema = getKeySchema(model, config);

    // ── Resolve plan via centralized planner ───────────────────
    const plan = resolveQueryPlan(where, model, config);

    // ── Strip PK/SK fields from update payload ─────────────────
    // DynamoDB rejects UpdateExpression on key attributes.
    const updateData = { ...update };
    delete updateData[schema.pkField];
    if (schema.skField) {
      delete updateData[schema.skField];
    }

    // ── Resolve key ────────────────────────────────────────────
    let key: Record<string, any>;

    // Tier 1: use pre-resolved key directly, but only when the key
    // is complete (composite tables require SK) and there are no
    // extra where clauses that need client-side filtering.
    const keyIsComplete =
      plan.tier === 1 &&
      plan.key &&
      !plan.needsClientSideFilter &&
      (!schema.skField || plan.key[schema.skField] !== undefined);

    if (keyIsComplete) {
      key = plan.key!;
    } else {
      // Tier 2/3 (or incomplete Tier 1): find the item first
      const item = await _resolveItemByPlan(
        docClient,
        tableName,
        plan,
        config,
        model,
      );
      if (!item) return null;
      key = { [schema.pkField]: item[schema.pkField] };
      if (schema.skField && item[schema.skField] !== undefined) {
        key[schema.skField] = item[schema.skField];
      }
    }

    // ── Build UpdateExpression ─────────────────────────────────
    const { names: attrNames, toRef, toValueRef } = buildExpressionNames(
      Object.keys(updateData),
    );
    const attrValues: Record<string, any> = {};
    const setClauses: string[] = [];

    for (const field of Object.keys(updateData)) {
      const ref = toRef(field);
      const valRef = toValueRef();
      setClauses.push(`${ref} = ${valRef}`);
      const rawVal = updateData[field];
      attrValues[valRef] = rawVal instanceof Date ? rawVal.toISOString() : rawVal;
    }

    if (setClauses.length === 0) {
      // Nothing to update — return the item as-is
      const result = await docClient.send(
        new GetCommand({ TableName: tableName, Key: key }),
      );
      return (result.Item as any) ?? null;
    }

    // ── Execute UpdateItem ─────────────────────────────────────
    // ConditionExpression (#pk) guards against upsert on missing
    // items. #pk is distinct from buildExpressionNames' #nX
    // placeholders since we stripped PK/SK from updateData above.
    try {
      const result = await docClient.send(
        new UpdateCommand({
          TableName: tableName,
          Key: key,
          UpdateExpression: `SET ${setClauses.join(", ")}`,
          ExpressionAttributeNames: { ...attrNames, "#pk": schema.pkField },
          ExpressionAttributeValues: attrValues,
          ConditionExpression: "attribute_exists(#pk)",
          ReturnValues: "ALL_NEW",
        }),
      );
      return (result.Attributes as any) ?? null;
    } catch (err: any) {
      // ConditionalCheckFailedException → item didn't exist.
      // Return null so callers can handle missing items gracefully.
      if (err.name === "ConditionalCheckFailedException") {
        return null;
      }
      throw err;
    }
  };
}

// ── Internal helpers ───────────────────────────────────────────

/**
 * Finds a single item using the plan returned by resolveQueryPlan.
 * Handles Tier 2 (GSI Query) and Tier 3 (Scan), plus KEYS_ONLY
 * follow-up GetItem for sparse GSI projections.
 */
async function _resolveItemByPlan(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  plan: ReturnType<typeof resolveQueryPlan>,
  config: DynamoDBAdapterConfig,
  model: string,
): Promise<Record<string, any> | null> {
  // ── Tier 2: GSI Query ─────────────────────────────────────
  if (plan.tier === 2 && plan.operation === "query") {
    const result = await docClient.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: plan.indexName!,
        KeyConditionExpression: plan.keyCondition!,
        FilterExpression: plan.filterExpression || undefined,
        ...compactExpr(plan.expressionAttributeNames, plan.expressionAttributeValues),
        Limit: 1,
      } as any),
    );

    const items = (result.Items ?? []) as Record<string, any>[];

    if (plan.needsFollowUpGetItem && items.length > 0) {
      const gsiItem = items[0]!;
      const fk = plan.followUpKeyFields!;
      const key: Record<string, any> = { [fk.pkField]: gsiItem[fk.pkField] };
      if (fk.skField && gsiItem[fk.skField] !== undefined) {
        key[fk.skField] = gsiItem[fk.skField];
      }
      const fuResult = await docClient.send(
        new GetCommand({ TableName: tableName, Key: key }),
      );
      return (fuResult.Item as any) ?? null;
    }

    return items[0] ?? null;
  }

  // ── Tier 3: Scan ──────────────────────────────────────────
  if (config.debugLogs) {
    const debug =
      typeof config.debugLogs === "object" ? config.debugLogs : {};
    if (debug.update !== false) {
      console.warn(
        `[dynamodb-adapter] update on ${model} using Scan (Tier 3). ` +
          `Consider adding a GSI for the queried field(s).`,
      );
    }
  }

  const result = await docClient.send(
    new ScanCommand({
      TableName: tableName,
      FilterExpression: plan.filterExpression || undefined,
      ...compactExpr(plan.expressionAttributeNames, plan.expressionAttributeValues),
      Limit: 1,
    } as any),
  );

  return ((result.Items as any)?.[0] as any) ?? null;
}
