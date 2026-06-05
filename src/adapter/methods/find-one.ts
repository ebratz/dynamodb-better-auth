/**
 * findOne method — per DESIGN.md §5 (findOne method).
 *
 * Resolves query plan via centralized resolveQueryPlan:
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
import { compactExpr } from "../../helpers/expression-names";
import { resolveQueryPlan } from "../../helpers/query-planner";

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

    const plan = resolveQueryPlan(args.where, args.model, config);

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
      let item = (result.Item as any) ?? null;

      // Apply client-side filters for extra clauses that GetItem can't enforce.
      // The planner returns needsClientSideFilter when where-clause fields
      // beyond PK/SK must be checked (DynamoDB GetItem has no FilterExpression).
      if (item && plan.needsClientSideFilter && plan.clientSideFilters) {
        if (!matchesClientFilters(item, plan.clientSideFilters)) {
          return null;
        }
      }

      return item;
    }

    // ── Tier 2: Query on GSI ─────────────────────────────────
    if (plan.operation === "query") {
      const result = await docClient.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: plan.indexName,
          KeyConditionExpression: plan.keyCondition,
          FilterExpression: plan.filterExpression || undefined,
          ...compactExpr(plan.expressionAttributeNames, plan.expressionAttributeValues),
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
        ...compactExpr(plan.expressionAttributeNames, plan.expressionAttributeValues),
        Limit: 1,
      } as any)
    );

    return (result.Items?.[0] as any) ?? null;
  };
}

// ── Client-side filter applier ─────────────────────────────────

/**
 * Evaluates client-side filters against a GetItem result.
 * Used when Tier 1 has extra where-clause fields beyond PK/SK
 * that DynamoDB's GetCommand cannot enforce server-side.
 */
function matchesClientFilters(
  item: Record<string, any>,
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
