/**
 * Shared item-resolution helper for single-item lookups from a QueryPlan.
 *
 * Used by update, delete, and consumeOne to find a single item when
 * the planner returns Tier 2 (GSI Query) or Tier 3 (Scan), including
 * KEYS_ONLY GSI follow-up via GetCommand (single item → 1 round trip).
 */

import { QueryCommand, ScanCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBAdapterConfig } from "../types";
import { compactExpr } from "./expression-names";
import type { resolveQueryPlan } from "./query-planner";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

/**
 * Finds a single item using the plan returned by resolveQueryPlan.
 * Handles Tier 2 (GSI Query) and Tier 3 (Scan), plus KEYS_ONLY
 * follow-up GetCommand for sparse GSI projections.
 *
 * Returns null when no item matches.
 */
export async function resolveItemByPlan(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  plan: ReturnType<typeof resolveQueryPlan>,
  config: DynamoDBAdapterConfig,
  model: string,
): Promise<AnyRecord | null> {
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

    const items = (result.Items ?? []) as AnyRecord[];

    if (plan.needsFollowUpGetItem && items.length > 0) {
      const gsiItem = items[0]!;
      const fk = plan.followUpKeyFields!;
      const key: AnyRecord = { [fk.pkField]: gsiItem[fk.pkField] };
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
    if (debug[model] !== false) {
      console.warn(
        `[dynamodb-adapter] ${model} using Scan (Tier 3). ` +
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

// ── Client-side filter ─────────────────────────────────────────

/**
 * Evaluates client-side filters against a GetItem result.
 * Used when Tier 1 has extra where-clause fields beyond PK/SK
 * that DynamoDB's GetCommand cannot enforce server-side.
 */
export function matchesClientFilters(
  item: AnyRecord,
  filters: Array<{ field: string; operator: string; value: any }>,
): boolean {
  for (const f of filters) {
    const itemVal = item[f.field];
    switch (f.operator) {
      case "eq":          if (itemVal !== f.value) return false; break;
      case "ne":          if (itemVal === f.value) return false; break;
      case "gt":          if (!(itemVal > f.value)) return false; break;
      case "gte":         if (!(itemVal >= f.value)) return false; break;
      case "lt":          if (!(itemVal < f.value)) return false; break;
      case "lte":         if (!(itemVal <= f.value)) return false; break;
      case "in": {
        const arr = Array.isArray(f.value) ? f.value : [f.value];
        if (!arr.includes(itemVal)) return false;
        break;
      }
      case "not_in": {
        const arr = Array.isArray(f.value) ? f.value : [f.value];
        if (arr.includes(itemVal)) return false;
        break;
      }
      case "contains": {
        if (typeof itemVal !== "string" || !itemVal.includes(String(f.value))) return false;
        break;
      }
      case "starts_with": {
        if (typeof itemVal !== "string" || !itemVal.startsWith(String(f.value))) return false;
        break;
      }
      default: return false;
    }
  }
  return true;
}
