/**
 * findMany method — per DESIGN.md §5 (findMany method) + review-gap fix D.
 *
 * Resolves query plan via centralized resolveQueryPlan:
 *   Tier 1: GetItem on PK — return single-item array (or empty if filtered
 *     out; empty when offset > 0 — one row cannot survive an offset).
 *   Tier 2: Query on GSI, paginate via fetchAllByPlan.
 *     - sortBy matches the GSI sort key → native ScanIndexForward, limit
 *       pushed down (+offset over-fetch, discarded client-side).
 *     - sortBy does NOT match the sort key → fetch ALL matching rows
 *       (capped by maxScanItems), sort client-side, then slice — slicing
 *       before sorting returns the wrong rows.
 *     - KEYS_ONLY / INCLUDE GSI → BatchGetCommand for full rows.
 *
 *   Tier 3: Scan + FilterExpression via fetchAllByPlan.
 *     - If sortBy is set: fetch ALL pages, sort client-side, slice.
 *     - If no sortBy: apply Limit during fetch, stop early.
 *     - Client-side offset via discard (logged warning).
 */

import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBAdapterConfig, WhereClause } from "../../types";
import { resolveQueryPlan } from "../../helpers/query-planner";
import { matchesClientFilters } from "../../helpers/resolve-item";
import { resolveKEYS_ONLY } from "../../helpers/batch-get";
import { findGsiByIndexName } from "../../helpers/gsi-resolver";
import { fetchAllByPlan, type FetchAllPlan } from "../../helpers/fetch-all";
import { shouldLog } from "../../helpers/debug-log";
import { getLogger } from "../../helpers/logger";
import { getTableName } from "../client";
import { DEFAULT_FIND_MANY_LIMIT } from "../../helpers/constants";
import { DynamoAdapterError } from "../../errors";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

export function findManyMethod(
  docClient: DynamoDBDocumentClient,
  config: DynamoDBAdapterConfig
) {
  return async (args: {
    model: string;
    where?: WhereClause[];
    limit?: number;
    offset?: number;
    sortBy?: { field: string; direction: "asc" | "desc" };
    select?: string[];
    join?: any;
  }): Promise<AnyRecord[]> => {
    const model = args.model;
    const tableName = getTableName(model, config);

    // Guard: limit 0 → empty array (avoid unnecessary DDB calls)
    const limit = args.limit ?? DEFAULT_FIND_MANY_LIMIT;
    if (limit <= 0) return [];
    const offset = args.offset ?? 0;

    const plan = resolveQueryPlan(args.where ?? [], model, config);

    // Vacuously-false where clause (e.g. `in: []`) — nothing can match.
    if (plan.alwaysFalse) return [];

    // ── Tier 1: GetItem on PK ───────────────────────────────
    if (plan.operation === "getItem") {
      // A single row can never survive a positive offset.
      if (offset > 0) return [];

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
      // Native ordering is only valid when sortBy targets the GSI range
      // key; otherwise the whole matching set must be fetched and sorted
      // client-side BEFORE limit/offset are applied.
      const gsiRangeKey = findGsiByIndexName(model, plan.indexName!, config)?.rangeKey;
      const nativeSort = !args.sortBy || args.sortBy.field === gsiRangeKey;

      let items: AnyRecord[];

      if (nativeSort) {
        items = await fetchAllByPlan(docClient, tableName, {
          operation: "query",
          indexName: plan.indexName,
          keyCondition: plan.keyCondition,
          filterExpression: plan.filterExpression,
          expressionAttributeNames: plan.expressionAttributeNames,
          expressionAttributeValues: plan.expressionAttributeValues,
          postFilters: plan.postFilters,
          // Over-fetch to absorb the offset discard below.
          limit: limit + offset,
          ...(args.sortBy
            ? { scanIndexForward: args.sortBy.direction !== "desc" }
            : {}),
        });
      } else {
        if (shouldLog(config, "findMany")) {
          getLogger(config).warn(
            `[dynamodb-adapter] findMany on ${model}: sortBy field ` +
            `"${args.sortBy!.field}" does not match the GSI sort key — ` +
            `fetching all matching items for client-side sort.`,
            { model, sortByField: args.sortBy!.field },
          );
        }

        // Fetch ALL matching rows (no limit — slicing first would return
        // the wrong rows), capped for safety.
        items = await fetchAllByPlan(docClient, tableName, {
          operation: "query",
          indexName: plan.indexName,
          keyCondition: plan.keyCondition,
          filterExpression: plan.filterExpression,
          expressionAttributeNames: plan.expressionAttributeNames,
          expressionAttributeValues: plan.expressionAttributeValues,
          postFilters: plan.postFilters,
        });

        const maxScanItems = config.maxScanItems ?? 10_000;
        if (maxScanItems > 0 && items.length > maxScanItems) {
          throw new DynamoAdapterError(
            "SCAN_LIMIT_EXCEEDED",
            `findMany with sortBy fetched ${items.length} items (max: ${maxScanItems}). ` +
              `Add a GSI with sort key "${args.sortBy!.field}" or increase maxScanItems.`,
          );
        }

        sortItems(items, args.sortBy!);
      }

      // Client-side offset via discard (native path over-fetched by offset)
      if (offset > 0) {
        warnOffsetDiscard(config, model, offset);
        items = items.slice(offset);
      }

      items = items.slice(0, limit);

      // Follow-up BatchGetItem for sparse (KEYS_ONLY / INCLUDE) GSIs
      if (plan.needsFollowUpGetItem && items.length > 0) {
        return resolveKEYS_ONLY(docClient, tableName, plan.followUpKeyFields!, items);
      }

      return items;
    }

    // ── Tier 3: Scan + Filter ────────────────────────────────

    // Gap D fix: if sortBy is set, fetch ALL pages first.
    // Guard: throttle the scan to prevent unbounded table reads.
    if (args.sortBy) {
      const maxScanItems = config.maxScanItems ?? 10_000;

      if (shouldLog(config, "findMany")) {
        getLogger(config).warn(
          `[dynamodb-adapter] findMany on ${model} using Scan with sortBy — ` +
          `fetching all matching items for client-side sort. Add a GSI to avoid this.`,
          { model },
        );
      }

      let items = await fetchAllByPlan(docClient, tableName, plan as FetchAllPlan);

      // Cap: prevent unbounded full-table scans for a small limit
      if (maxScanItems > 0 && items.length > maxScanItems) {
        throw new DynamoAdapterError(
          "SCAN_LIMIT_EXCEEDED",
          `findMany with sortBy scanned ${items.length} items (max: ${maxScanItems}). ` +
            `Add a GSI for the sort field ("${args.sortBy.field}") or increase maxScanItems.`,
        );
      }

      sortItems(items, args.sortBy);

      // Client-side offset
      if (offset > 0) {
        warnOffsetDiscard(config, model, offset);
        items = items.slice(offset);
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
      postFilters: plan.postFilters,
      limit: limit + offset,
    });

    // Client-side offset via discard
    if (offset > 0) {
      warnOffsetDiscard(config, model, offset);
      items = items.slice(offset);
    }

    return items.slice(0, limit);
  };
}

// ── Internal helpers ───────────────────────────────────────────

function sortItems(
  items: AnyRecord[],
  sortBy: { field: string; direction: "asc" | "desc" },
): void {
  const dir = sortBy.direction === "desc" ? -1 : 1;
  items.sort((a, b) => {
    const av = a[sortBy.field];
    const bv = b[sortBy.field];
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
}

function warnOffsetDiscard(
  config: DynamoDBAdapterConfig,
  model: string,
  offset: number,
): void {
  if (shouldLog(config, "findMany")) {
    getLogger(config).warn(
      `[dynamodb-adapter] findMany client-side offset ${offset} on ${model} — ` +
      `skipped items still consumed RCU.`,
      { model, offset },
    );
  }
}
