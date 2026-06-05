/**
 * count method — per DESIGN.md §5 (count method).
 *
 * Paginated ScanCommand with Select: "COUNT".
 * Uses the centralized resolveFilter to build DynamoDB expressions,
 * which correctly handles all operators (not_in, between, contains, etc.)
 * and AND/OR grouping.
 *
 * Emits a debugLogs warning when ScannedCount > config.warnOnLargeCount.
 */

import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBAdapterConfig, WhereClause } from "../../types";
import { resolveFilter } from "../../helpers/query-planner";
import { getTableName } from "../client";
import { shouldLog } from "../../helpers/debug-log";

export function countMethod(
  docClient: DynamoDBDocumentClient,
  config: DynamoDBAdapterConfig,
) {
  return async (args: {
    model: string;
    where?: WhereClause[];
  }): Promise<number> => {
    const tableName = getTableName(args.model, config);

    const threshold = config.warnOnLargeCount ?? 10_000;
    let totalCount = 0;
    let totalScanned = 0;
    let lastEvaluatedKey: Record<string, any> | undefined;

    // ── Build filter via centralized converter ──────────────────
    // resolveFilter handles: not_in, between, contains, starts_with,
    // AND/OR grouping, IN chunking (>100 values), UnsupportedOperatorError.
    const filter = resolveFilter(args.where ?? [], args.model, config);

    do {
      const result = await docClient.send(
        new ScanCommand({
          TableName: tableName,
          Select: "COUNT",
          ...(filter
            ? {
                FilterExpression: filter.expression,
                ExpressionAttributeNames: filter.expressionAttributeNames,
                ExpressionAttributeValues: filter.expressionAttributeValues,
              }
            : {}),
          ExclusiveStartKey: lastEvaluatedKey,
        }),
      );

      totalCount += result.Count ?? 0;
      totalScanned += result.ScannedCount ?? 0;
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    // Warn on large scans
    if (threshold > 0 && totalScanned > threshold && shouldLog(config, "count")) {
      console.warn(
        `[dynamodb-adapter] count() scanned ${totalScanned} items on ${tableName} ` +
        `(threshold: ${threshold}). Consider adding a counter pattern for large tables.`,
      );
    }

    return totalCount;
  };
}
