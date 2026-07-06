/**
 * Shared item-resolution helper for single-item lookups from a QueryPlan.
 *
 * Used by update, delete, and consumeOne to find a single item when
 * the planner returns Tier 2 (GSI Query) or Tier 3 (Scan), including
 * KEYS_ONLY GSI follow-up via GetCommand.
 *
 * DynamoDB applies `Limit` BEFORE the FilterExpression (it caps items
 * *evaluated*, not items *returned*), so a single `Limit: 1` request with a
 * filter routinely returns an empty page plus a LastEvaluatedKey even though
 * later pages contain matches. This helper therefore paginates until an item
 * passes (server filter + client post-filters) or pages are exhausted, capped
 * by config.maxScanItems.
 *
 * Tier-1 plans must never reach this helper: they carry `key` +
 * `clientSideFilters` instead of expression fields, and routing them through
 * the Scan branch would issue an UNFILTERED scan (arbitrary-row results).
 * Callers handle Tier 1 with GetCommand + matchesClientFilters.
 */

import { QueryCommand, ScanCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBAdapterConfig } from "../types";
import { compactExpr } from "./expression-names";
import { shouldLog } from "./debug-log";
import { getLogger } from "./logger";
import {
  SINGLE_ITEM_PAGE_SIZE,
  DEFAULT_MAX_SCAN_ITEMS,
} from "./constants";
import { DynamoAdapterError, UnsupportedOperatorError } from "../errors";
import type { resolveQueryPlan } from "./query-planner";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

type ClientFilter = { field: string; operator: string; value: any };

/**
 * Finds a single item using the plan returned by resolveQueryPlan.
 * Handles Tier 2 (GSI Query) and Tier 3 (Scan), plus KEYS_ONLY
 * follow-up GetCommand for sparse GSI projections.
 *
 * Returns null when no item matches. Throws INVALID_PLAN for Tier-1 plans
 * and SCAN_LIMIT_EXCEEDED when more than config.maxScanItems rows were
 * examined without a match.
 */
export async function resolveItemByPlan(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  plan: ReturnType<typeof resolveQueryPlan>,
  config: DynamoDBAdapterConfig,
  model: string,
): Promise<AnyRecord | null> {
  if (plan.tier === 1 || plan.operation === "getItem") {
    throw new DynamoAdapterError(
      "INVALID_PLAN",
      "resolveItemByPlan received a Tier-1 (GetItem) plan. Tier-1 plans " +
        "carry no filter expression — callers must resolve them via " +
        "GetCommand + matchesClientFilters.",
    );
  }

  const isQuery = plan.tier === 2 && plan.operation === "query";
  const maxScanItems = config.maxScanItems ?? DEFAULT_MAX_SCAN_ITEMS;

  if (!isQuery && shouldLog(config, model)) {
    getLogger(config).warn(
      `[dynamodb-adapter] ${model} using Scan (Tier 3). ` +
        `Consider adding a GSI for the queried field(s).`,
      { model },
    );
  }

  let lastKey: AnyRecord | undefined;
  let examined = 0;

  do {
    const base: AnyRecord = {
      TableName: tableName,
      ...compactExpr(plan.expressionAttributeNames, plan.expressionAttributeValues),
      Limit: SINGLE_ITEM_PAGE_SIZE,
      ExclusiveStartKey: lastKey,
    };
    if (plan.filterExpression) {
      base.FilterExpression = plan.filterExpression;
    }

    let result;
    if (isQuery) {
      result = await docClient.send(
        new QueryCommand({
          ...base,
          IndexName: plan.indexName!,
          KeyConditionExpression: plan.keyCondition!,
        } as any),
      );
    } else {
      result = await docClient.send(new ScanCommand(base as any));
    }

    examined += result.ScannedCount ?? result.Items?.length ?? 0;
    lastKey = result.LastEvaluatedKey;

    for (const raw of (result.Items ?? []) as AnyRecord[]) {
      const item = await resolveCandidate(docClient, tableName, plan, raw);
      if (item) return item;
    }

    if (maxScanItems > 0 && examined > maxScanItems) {
      throw new DynamoAdapterError(
        "SCAN_LIMIT_EXCEEDED",
        `Single-item lookup on ${model} examined ${examined} rows without a ` +
          `match (max: ${maxScanItems}). Add a GSI for the queried field(s) ` +
          `or increase maxScanItems.`,
      );
    }
  } while (lastKey);

  return null;
}

/**
 * Resolves one page candidate: performs the KEYS_ONLY follow-up GetCommand
 * when the plan requires it, then applies client-side post-filters (e.g.
 * ends_with) against the FULL item. Returns null when the candidate does
 * not survive.
 */
async function resolveCandidate(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  plan: ReturnType<typeof resolveQueryPlan>,
  raw: AnyRecord,
): Promise<AnyRecord | null> {
  let item: AnyRecord | null = raw;

  if (plan.needsFollowUpGetItem) {
    const fk = plan.followUpKeyFields!;
    const key: AnyRecord = { [fk.pkField]: raw[fk.pkField] };
    if (fk.skField && raw[fk.skField] !== undefined) {
      key[fk.skField] = raw[fk.skField];
    }
    const fuResult = await docClient.send(
      new GetCommand({ TableName: tableName, Key: key }),
    );
    item = (fuResult.Item as AnyRecord) ?? null;
  }

  if (!item) return null;
  if (plan.postFilters && plan.postFilters.length > 0) {
    if (!matchesClientFilters(item, plan.postFilters)) return null;
  }
  return item;
}

// ── Client-side filter ─────────────────────────────────────────

/**
 * Evaluates client-side filters against an item, AND-connected.
 * Used for Tier-1 extra where clauses (GetItem has no FilterExpression)
 * and for post-filters DynamoDB cannot express server-side (ends_with).
 *
 * OR connectors never reach this function: the planner routes any
 * OR-connected where clause to Tier 3, where the full expression is
 * rendered server-side.
 */
export function matchesClientFilters(
  item: AnyRecord,
  filters: ClientFilter[],
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
      case "between": {
        const arr = Array.isArray(f.value) ? f.value : [];
        if (arr.length !== 2) return false;
        if (!(itemVal >= arr[0] && itemVal <= arr[1])) return false;
        break;
      }
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
        // Match native DynamoDB contains(): strings AND lists/sets.
        if (Array.isArray(itemVal)) {
          if (!itemVal.includes(f.value)) return false;
        } else if (typeof itemVal !== "string" || !itemVal.includes(String(f.value))) {
          return false;
        }
        break;
      }
      case "starts_with": {
        if (typeof itemVal !== "string" || !itemVal.startsWith(String(f.value))) return false;
        break;
      }
      case "ends_with": {
        if (typeof itemVal !== "string" || !itemVal.endsWith(String(f.value))) return false;
        break;
      }
      default:
        // Failing closed silently would turn an unsupported operator into
        // a wrong result; make it loud instead.
        throw new UnsupportedOperatorError(
          f.operator,
          "Operator not supported by client-side filtering.",
        );
    }
  }
  return true;
}
