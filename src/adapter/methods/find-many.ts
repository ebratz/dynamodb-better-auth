/**
 * findMany method — per DESIGN.md §5 (findMany method) + review-gap fix D.
 *
 * Resolves query plan via centralized resolveQueryPlan:
 *   Tier 1: GetItem on PK — return single-item array (or empty if filtered out).
 *   Tier 2: Query on GSI, paginate via fetchAllByPlan.
 *     - offset > 0 throws UnsupportedOptionError.
 *     - sortBy matches GSI sort key → native ScanIndexForward.
 *     - KEYS_ONLY GSI → BatchGetCommand for full rows.
 *
 *   Tier 3: Scan + FilterExpression via fetchAllByPlan.
 *     - If sortBy is set: fetch ALL pages (no limit), sort client-side, slice to limit.
 *       Emits "full-table sort+limit" warning (gap D fix).
 *     - If no sortBy: apply Limit during fetch, stop early.
 *     - Client-side offset via discard (logged warning).
 */

import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBAdapterConfig } from "../../types";
import { compactExpr } from "../../helpers/expression-names";
import { resolveQueryPlan } from "../../helpers/query-planner";
import { matchesClientFilters } from "../../helpers/resolve-item";
import { resolveKEYS_ONLY } from "../../helpers/batch-get";
import { fetchAllByPlan } from "../../helpers/fetch-all";
import { shouldLog } from "../../helpers/debug-log";
import { getTableName } from "../client";
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
    const model = args.model;
    const tableName = getTableName(model, config);

    // Guard: limit 0 → empty array (avoid unnecessary DDB calls)
    const limit = args.limit ?? 100;
    if (limit <= 0) return [];

    const plan = resolveQueryPlan(args.where ?? [], model, config);

    // ── Tier 1: GetItem on PK ───────────────────────────────
    if (plan.operation === "getItem") {
      const result = await docClient.send(
        new GetCommand({
          TableName: tableName,
          Key: plan.key!,
        })
      );
      const item = (result.Item as any) ?? null;
      if (!item) return [];

      // Client-side filter for extra where clauses
      if (plan.needsClientSideFilter && plan.clientSideFilters) {
        if (!matchesClientFilters(item, plan.clientSideFilters)) return [];
      }

      return [item];
    }

    // ── Tier 2: Query on GSI ─────────────────────────────────
    if (plan.operation === "query") {
      if ((args.offset ?? 0) > 0) {
        throw new UnsupportedOptionError(
          "offset",
          "Tier 2 (GSI Query) does not support offset. Use ExclusiveStartKey for cursor-based pagination."
        );
      }

      // Determine client-side sort: check if sortBy matches GSI range key
      let needsClientSort = false;
      if (args.sortBy) {
        const gsiRangeKey = findGsiRangeKey(model, plan.indexName!, config);
        needsClientSort = args.sortBy.field !== gsiRangeKey;
      }

      let items = await fetchAllByPlan(docClient, tableName, {
        operation: "query",
        indexName: plan.indexName,
        keyCondition: plan.keyCondition,
        filterExpression: plan.filterExpression,
        expressionAttributeNames: plan.expressionAttributeNames,
        expressionAttributeValues: plan.expressionAttributeValues,
        limit,
        scanIndexForward: args.sortBy?.direction !== "desc",
      });

      // Client-side sort when sortBy doesn't match GSI range key
      if (args.sortBy && needsClientSort) {
        if (shouldLog(config, "findMany")) {
          console.warn(
            `[dynamodb-adapter] findMany on ${model}: sortBy field ` +
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
        return resolveKEYS_ONLY(docClient, tableName, plan.followUpKeyFields!, items);
      }

      return items;
    }

    // ── Tier 3: Scan + Filter ────────────────────────────────

    // Gap D fix: if sortBy is set, fetch ALL pages first
    if (args.sortBy) {
      if (shouldLog(config, "findMany")) {
        console.warn(
          `[dynamodb-adapter] findMany on ${model} using Scan with sortBy — ` +
          `fetching all matching items for client-side sort. Add a GSI to avoid this.`
        );
      }

      let items = await fetchAllByPlan(docClient, tableName, plan as any);

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
        if (shouldLog(config, "findMany")) {
          console.warn(
            `[dynamodb-adapter] findMany client-side offset ${args.offset} on ${model} — ` +
            `skipped items still consumed RCU.`
          );
        }
        items = items.slice(args.offset);
      }

      return items.slice(0, limit);
    }

    // No sortBy — apply Limit during Scan, stop early
    // Fetch limit + offset items to accommodate offset discard
    let items = await fetchAllByPlan(docClient, tableName, {
      operation: "scan",
      filterExpression: plan.filterExpression,
      expressionAttributeNames: plan.expressionAttributeNames,
      expressionAttributeValues: plan.expressionAttributeValues,
      limit: limit + (args.offset ?? 0),
    });

    // Client-side offset via discard
    if (args.offset && args.offset > 0) {
      if (shouldLog(config, "findMany")) {
        console.warn(
          `[dynamodb-adapter] findMany client-side offset ${args.offset} on ${model} — ` +
          `discarded items still consumed RCU.`
        );
      }
      items = items.slice(args.offset);
    }

    return items.slice(0, limit);
  };
}

// ── Internal helpers ───────────────────────────────────────────

/**
 * Look up the GSI range key for a given model + indexName.
 * Used to determine whether sortBy can use native ScanIndexForward.
 */
function findGsiRangeKey(
  model: string,
  indexName: string,
  config: DynamoDBAdapterConfig,
): string | undefined {
  const modelIndexes = config.indexes?.[model];
  if (!modelIndexes) return undefined;
  for (const [, fieldIndexes] of Object.entries(modelIndexes)) {
    for (const gsi of Object.values(fieldIndexes)) {
      if ((gsi as any).indexName === indexName) return (gsi as any).rangeKey;
    }
  }
  return undefined;
}
