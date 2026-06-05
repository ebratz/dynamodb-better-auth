/**
 * Shared paginated fetch helper for DynamoDB Query and Scan operations.
 *
 * All `do { send(QueryCommand/ScanCommand); push(items); lastKey = LastEvaluatedKey }
 * while (lastKey)` loops across the adapter are replaced by this single function.
 *
 * Callers pass a lightweight plan object with operation type and expression fields.
 * The helper handles pagination, limit enforcement, and expression-attribute safety
 * via compactExpr from expression-names.ts.
 */

import { QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { compactExpr } from "./expression-names";

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
}

/**
 * Paginated fetch for Query or Scan operations.
 *
 * - Query: uses KeyConditionExpression + optional FilterExpression on the given index.
 * - Scan: uses optional FilterExpression.
 * - Handles ExclusiveStartKey pagination automatically.
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
  const items: AnyRecord[] = [];
  let lastKey: AnyRecord | undefined;
  const remaining = plan.limit;

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
      if (result.Items) items.push(...(result.Items as AnyRecord[]));
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
      if (result.Items) items.push(...(result.Items as AnyRecord[]));
      lastKey = result.LastEvaluatedKey;
    } while (lastKey && (remaining === undefined || items.length < remaining));
  }

  return items;
}
