/**
 * Shared paginated fetch helper for DynamoDB Query and Scan operations.
 *
 * All `do { send(QueryCommand/ScanCommand); push(items); lastKey = LastEvaluatedKey }
 * while (lastKey)` loops across the adapter are replaced by this single function.
 *
 * Callers pass a lightweight plan object with operation type and expression fields.
 * The helper handles pagination, limit enforcement, client-side post-filters
 * (e.g. ends_with — applied BEFORE limit accounting so limits count real
 * matches), and expression-attribute safety via compactExpr.
 *
 * Only "query" and "scan" plans are accepted: a Tier-1 (getItem) plan has no
 * filter expression, and treating it as a scan silently becomes an UNFILTERED
 * full-table read — the helper throws instead.
 */

import { QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { compactExpr } from "./expression-names";
import { matchesClientFilters } from "./resolve-item";
import { DynamoAdapterError } from "../errors";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

/**
 * Plan shape accepted by fetchAllByPlan — a subset of the full QueryPlan.
 * Only the fields needed for paginated fetch are required.
 */
export interface FetchAllPlan {
  operation: "query" | "scan";
  indexName?: string;
  keyCondition?: string;
  filterExpression?: string;
  expressionAttributeNames: Record<string, string>;
  expressionAttributeValues: Record<string, any>;
  /** Stop early after collecting this many items. Omit to fetch all pages. */
  limit?: number;
  /** Sort direction for Query operations. false = descending. */
  scanIndexForward?: boolean;
  /** Client-side post-filters (ends_with) applied to each page's items. */
  postFilters?: Array<{ field: string; operator: string; value: any }>;
}

/**
 * Paginated fetch for Query or Scan operations.
 *
 * - Query: uses KeyConditionExpression + optional FilterExpression on the given index.
 * - Scan: uses optional FilterExpression.
 * - Handles ExclusiveStartKey pagination automatically.
 * - Applies plan.postFilters to each page before counting toward the limit.
 * - Stops early when `plan.limit` items have been collected.
 * - Uses compactExpr to avoid DynamoDB ValidationException on empty expression maps.
 *
 * @returns All matching items (up to limit if specified).
 */
export async function fetchAllByPlan(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  plan: FetchAllPlan,
): Promise<AnyRecord[]> {
  if (plan.operation !== "query" && plan.operation !== "scan") {
    throw new DynamoAdapterError(
      "INVALID_PLAN",
      `fetchAllByPlan only accepts query/scan plans, got "${(plan as any).operation}". ` +
        "Tier-1 (getItem) plans have no filter expression and must be " +
        "resolved via GetCommand.",
    );
  }

  const items: AnyRecord[] = [];
  let lastKey: AnyRecord | undefined;
  const remaining = plan.limit;

  const collect = (pageItems: AnyRecord[] | undefined) => {
    if (!pageItems) return;
    const matched =
      plan.postFilters && plan.postFilters.length > 0
        ? pageItems.filter((it) => matchesClientFilters(it, plan.postFilters!))
        : pageItems;
    items.push(...matched);
  };

  if (plan.operation === "query") {
    do {
      const cmd: any = {
        TableName: tableName,
        IndexName: plan.indexName!,
        KeyConditionExpression: plan.keyCondition!,
        ...compactExpr(plan.expressionAttributeNames, plan.expressionAttributeValues),
        ExclusiveStartKey: lastKey,
      };

      if (plan.filterExpression) {
        cmd.FilterExpression = plan.filterExpression;
      }
      if (remaining !== undefined) {
        cmd.Limit = remaining - items.length;
      }
      if (plan.scanIndexForward !== undefined) {
        cmd.ScanIndexForward = plan.scanIndexForward;
      }

      const result = await docClient.send(new QueryCommand(cmd));
      collect(result.Items as AnyRecord[] | undefined);
      lastKey = result.LastEvaluatedKey;
    } while (lastKey && (remaining === undefined || items.length < remaining));
  } else {
    // operation === "scan"
    do {
      const cmd: any = {
        TableName: tableName,
        ...compactExpr(plan.expressionAttributeNames, plan.expressionAttributeValues),
        ExclusiveStartKey: lastKey,
      };

      if (plan.filterExpression) {
        cmd.FilterExpression = plan.filterExpression;
      }
      if (remaining !== undefined) {
        cmd.Limit = remaining - items.length;
      }

      const result = await docClient.send(new ScanCommand(cmd));
      collect(result.Items as AnyRecord[] | undefined);
      lastKey = result.LastEvaluatedKey;
    } while (lastKey && (remaining === undefined || items.length < remaining));
  }

  return remaining !== undefined ? items.slice(0, remaining) : items;
}
