/**
 * count method — per DESIGN.md §5 (count method).
 *
 * GSI-optimized: if config.indexes has a GSI whose hashKey matches an
 * eq where clause, uses QueryCommand with Select: "COUNT" instead of
 * ScanCommand. Falls back to ScanCommand when no GSI matches.
 *
 * Emits a debugLogs warning when ScannedCount > config.warnOnLargeCount.
 */

import { ScanCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBAdapterConfig, WhereClause } from "../../types";
import { resolveFilter } from "../../helpers/query-planner";
import { getTableName } from "../client";
import { shouldLog } from "../../helpers/debug-log";
import { getLogger } from "../../helpers/logger";

export function countMethod(
  docClient: DynamoDBDocumentClient,
  config: DynamoDBAdapterConfig,
) {
  return async (args: {
    model: string;
    where?: WhereClause[];
  }): Promise<number> => {
    const { model } = args;
    const tableName = getTableName(model, config);
    const threshold = config.warnOnLargeCount ?? 10_000;
    const where = args.where ?? [];

    // ── GSI-optimised path: use QueryCommand when an eq where
    //     clause matches a GSI hash key ─────────────────────────
    const modelIndexes = config.indexes?.[args.model];
    if (modelIndexes && where.length > 0) {
      for (const w of where) {
        const op = (w.operator ?? "eq").toLowerCase();
        if (op !== "eq") continue;
        const gsiDecl = modelIndexes[w.field];
        if (!gsiDecl) continue;

        // Build KeyConditionExpression: #hk = :hv
        // Extra where clauses (everything except the GSI hash key)
        // become a FilterExpression.
        const extraWhere = where.filter((rw) => rw !== w);
        const hkName = `#hk`;
        const hkVal = `:hv`;
        const keyCondition = `${hkName} = ${hkVal}`;
        const exprNames: Record<string, string> = { [hkName]: gsiDecl.hashKey };
        const exprValues: Record<string, any> = { [hkVal]: w.value };

        const filter =
          extraWhere.length > 0
            ? resolveFilter(extraWhere, args.model, config)
            : null;

        let totalCount = 0;
        let totalScanned = 0;
        let lastEvaluatedKey: Record<string, any> | undefined;

        do {
          const result = await docClient.send(
            new QueryCommand({
              TableName: tableName,
              IndexName: gsiDecl.indexName,
              KeyConditionExpression: keyCondition,
              Select: "COUNT",
              ExpressionAttributeNames: {
                ...exprNames,
                ...(filter?.expressionAttributeNames ?? {}),
              },
              ExpressionAttributeValues: {
                ...exprValues,
                ...(filter?.expressionAttributeValues ?? {}),
              },
              ...(filter?.expression
                ? { FilterExpression: filter.expression }
                : {}),
              ExclusiveStartKey: lastEvaluatedKey,
            }),
          );

          totalCount += result.Count ?? 0;
          totalScanned += result.ScannedCount ?? 0;
          lastEvaluatedKey = result.LastEvaluatedKey;
        } while (lastEvaluatedKey);

        // Warn on large queries
        if (
          threshold > 0 &&
          totalScanned > threshold &&
          shouldLog(config, "count")
        ) {
          getLogger(config).warn(
            `[dynamodb-adapter] count() queried ${totalScanned} items on ${tableName} ` +
              `(threshold: ${threshold}). Consider adding a counter pattern for large tables.`,
            { tableName, model, totalScanned, threshold },
          );
        }

        return totalCount;
      }
    }

    // ── Scan fallback ───────────────────────────────────────────
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
      getLogger(config).warn(
        `[dynamodb-adapter] count() scanned ${totalScanned} items on ${tableName} ` +
        `(threshold: ${threshold}). Consider adding a counter pattern for large tables.`,
        { tableName, model, totalScanned, threshold },
      );
    }

    return totalCount;
  };
}
