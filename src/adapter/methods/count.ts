/**
 * count method — per DESIGN.md §5 (count method).
 *
 * GSI-optimized: if config.indexes has a GSI whose hashKey matches an
 * eq where clause, uses QueryCommand with Select: "COUNT" instead of
 * ScanCommand. Falls back to ScanCommand when no GSI matches.
 *
 * GSI resolution matches on the declaration's hashKey via the shared
 * gsi-resolver (the config map key is a label, not a field name).
 *
 * Where clauses containing OR connectors skip the GSI path — a
 * KeyConditionExpression is implicitly ANDed with the filter, which
 * would silently change OR semantics.
 *
 * Post-filters (ends_with) cannot be counted with Select: "COUNT";
 * those queries fetch pages and count client-side-filtered items.
 *
 * Emits a debugLogs warning when ScannedCount > config.warnOnLargeCount.
 */

import { ScanCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBAdapterConfig, WhereClause } from "../../types";
import { resolveFilter } from "../../helpers/query-planner";
import { findGsiForField } from "../../helpers/gsi-resolver";
import { fetchAllByPlan } from "../../helpers/fetch-all";
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

    const hasOrConnector = where.some((w, i) => i > 0 && w.connector === "OR");

    // ── GSI-optimised path: use QueryCommand when an eq where
    //     clause matches a GSI hash key ─────────────────────────
    if (!hasOrConnector && where.length > 0) {
      for (const w of where) {
        const op = (w.operator ?? "eq").toLowerCase();
        if (op !== "eq") continue;
        const gsiDecl = findGsiForField(model, w.field, config);
        if (!gsiDecl) continue;

        // Build KeyConditionExpression: #hk = :hv
        // Extra where clauses (everything except the consumed clause)
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

        // Vacuously-false extra clauses (e.g. `in: []`) — count is 0.
        if (filter?.alwaysFalse) return 0;

        // Post-filters (ends_with) can't be counted server-side —
        // fetch and count client-side instead.
        if (filter?.postFilters && filter.postFilters.length > 0) {
          const items = await fetchAllByPlan(docClient, tableName, {
            operation: "query",
            indexName: gsiDecl.indexName,
            keyCondition,
            filterExpression: filter.expression || undefined,
            expressionAttributeNames: { ...exprNames, ...filter.expressionAttributeNames },
            expressionAttributeValues: { ...exprValues, ...filter.expressionAttributeValues },
            postFilters: filter.postFilters,
          });
          return items.length;
        }

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
    // resolveFilter handles: not_in, between, contains, starts_with,
    // ends_with (post-filter), AND/OR fold, IN chunking, empty-IN folding.
    const filter = resolveFilter(where, args.model, config);

    if (filter?.alwaysFalse) return 0;

    // Post-filters can't be counted with Select: "COUNT" — fetch + count.
    if (filter?.postFilters && filter.postFilters.length > 0) {
      const items = await fetchAllByPlan(docClient, tableName, {
        operation: "scan",
        filterExpression: filter.expression || undefined,
        expressionAttributeNames: filter.expressionAttributeNames,
        expressionAttributeValues: filter.expressionAttributeValues,
        postFilters: filter.postFilters,
      });
      return items.length;
    }

    let totalCount = 0;
    let totalScanned = 0;
    let lastEvaluatedKey: Record<string, any> | undefined;

    do {
      const result = await docClient.send(
        new ScanCommand({
          TableName: tableName,
          Select: "COUNT",
          ...(filter && filter.expression
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
