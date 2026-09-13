import { QueryCommand, ScanCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBAdapterConfig, WhereClause } from "../../types";
import { resolveQueryPlan, resolveFilter } from "../../helpers/query-planner";
import { fetchAllByPlan } from "../../helpers/fetch-all";
import { compactExpr } from "../../helpers/expression-names";
import { shouldLog } from "../../helpers/debug-log";
import { getLogger } from "../../helpers/logger";

/** Count shares the same legal index predicates and hydration rules as reads. */
export function countMethod(client: DynamoDBDocumentClient, config: DynamoDBAdapterConfig) {
  return async ({ model, where = [] }: { model: string; where?: WhereClause[] }): Promise<number> => {
    const plan = resolveQueryPlan(where, model, config);
    if (plan.alwaysFalse) return 0;
    if (plan.operation !== "getItem" && (plan.postFilters?.length || plan.needsFollowUpGetItem)) {
      return (await fetchAllByPlan(client, plan.tableName, { ...plan, operation: plan.operation })).length;
    }
    const filter = plan.operation === "getItem" ? resolveFilter(where, model, config) : undefined;
    if (filter?.alwaysFalse) return 0;
    let count = 0;
    let scanned = 0;
    let cursor: Record<string, unknown> | undefined;
    do {
      const input = {
        TableName: plan.tableName,
        ...compactExpr(filter?.expressionAttributeNames ?? plan.expressionAttributeNames, filter?.expressionAttributeValues ?? plan.expressionAttributeValues),
        ...(filter?.expression || plan.filterExpression ? { FilterExpression: filter?.expression || plan.filterExpression } : {}),
        Select: "COUNT" as const,
        ExclusiveStartKey: cursor,
      };
      const result = plan.operation === "query"
        ? await client.send(new QueryCommand({ ...input, IndexName: plan.indexName, KeyConditionExpression: plan.keyCondition }))
        : await client.send(new ScanCommand(input));
      count += result.Count ?? 0;
      scanned += result.ScannedCount ?? 0;
      cursor = result.LastEvaluatedKey;
    } while (cursor);
    const threshold = config.warnOnLargeCount ?? 10_000;
    if (threshold > 0 && scanned > threshold && shouldLog(config, "count")) {
      getLogger(config).warn(`[dynamodb-adapter] count() scanned ${scanned} items on ${plan.tableName} (threshold: ${threshold}).`, { model, totalScanned: scanned });
    }
    return count;
  };
}
