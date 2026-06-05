/**
 * delete method — per DESIGN.md §5 (delete method).
 *
 * Deletes a single item identified by the where clause.
 *
 * Uses centralized resolveQueryPlan for Tier 1–3 key resolution.
 * Tier 1: DeleteCommand on resolved PK (+SK).
 * Tier 2/3: Query/Scan + Limit:1 to find the row, extract key,
 *           then DeleteCommand.
 * Missing item → silently OK (no-op).
 */

import { DeleteCommand, QueryCommand, ScanCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBAdapterConfig } from "../../types";
import { getKeySchema } from "../../helpers/key-builder";
import { compactExpr } from "../../helpers/expression-names";
import { resolveQueryPlan } from "../../helpers/query-planner";
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

    // ── Resolve plan via centralized planner ───────────────────
    const plan = resolveQueryPlan(where, model, config);

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
      if (!item) return; // silently OK — nothing to delete
      key = { [schema.pkField]: item[schema.pkField] };
      if (schema.skField && item[schema.skField] !== undefined) {
        key[schema.skField] = item[schema.skField];
      }
    }

    // ── Execute DeleteItem ─────────────────────────────────────
    await docClient.send(
      new DeleteCommand({
        TableName: tableName,
        Key: key,
      }),
    );
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
      ...compactExpr(plan.expressionAttributeNames, plan.expressionAttributeValues),
      Limit: 1,
    } as any),
  );

  return ((result.Items as any)?.[0] as any) ?? null;
}
