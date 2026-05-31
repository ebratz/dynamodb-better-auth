/**
 * count method — per DESIGN.md §5 (count method).
 *
 * Paginated ScanCommand with Select: "COUNT".
 * Emits a debugLogs warning when ScannedCount > config.warnOnLargeCount.
 */

import {
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBAdapterConfig } from "../../types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Where = any;

export function countMethod(
  docClient: DynamoDBDocumentClient,
  config: DynamoDBAdapterConfig
) {
  return async (args: {
    model: string;
    where?: Where[];
  }): Promise<number> => {
    const tableName = config.tables[args.model];
    if (!tableName) {
      throw new Error(`No table configured for model "${args.model}"`);
    }

    const threshold = config.warnOnLargeCount ?? 10_000;
    let totalCount = 0;
    let totalScanned = 0;
    let lastEvaluatedKey: Record<string, any> | undefined;

    // Build FilterExpression from where clause (placeholder — real impl from H3)
    const filterExpr = args.where?.length
      ? buildSimpleFilter(args.where)
      : undefined;

    do {
      const result = await docClient.send(
        new ScanCommand({
          TableName: tableName,
          Select: "COUNT",
          ...(filterExpr?.expression
            ? {
                FilterExpression: filterExpr.expression,
                ExpressionAttributeNames: filterExpr.names,
                ExpressionAttributeValues: filterExpr.values,
              }
            : {}),
          ExclusiveStartKey: lastEvaluatedKey,
        })
      );

      totalCount += result.Count ?? 0;
      totalScanned += result.ScannedCount ?? 0;
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    // Warn on large scans
    if (threshold > 0 && totalScanned > threshold && config.debugLogs) {
      const debug = typeof config.debugLogs === "object" ? config.debugLogs : {};
      const logCount = debug.count !== false;
      if (logCount) {
        console.warn(
          `[dynamodb-adapter] count() scanned ${totalScanned} items on ${tableName} ` +
          `(threshold: ${threshold}). Consider adding a counter pattern for large tables.`
        );
      }
    }

    return totalCount;
  };
}

/** Minimal filter builder — will be replaced by H3's convertWhereClause */
function buildSimpleFilter(where: Where[]): {
  expression: string;
  names: Record<string, string>;
  values: Record<string, any>;
} | undefined {
  if (!where.length) return undefined;

  const names: Record<string, string> = {};
  const values: Record<string, any> = {};
  const parts: string[] = [];

  let vi = 0;
  for (let i = 0; i < where.length; i++) {
    const w = where[i]!;
    const nk = `#n${i}`;
    names[nk] = w.field;

    const vRef = `:v${vi++}`;
    values[vRef] = w.value;

    if (w.operator === "gt")      parts.push(`${nk} > ${vRef}`);
    else if (w.operator === "gte") parts.push(`${nk} >= ${vRef}`);
    else if (w.operator === "lt")  parts.push(`${nk} < ${vRef}`);
    else if (w.operator === "lte") parts.push(`${nk} <= ${vRef}`);
    else if (w.operator === "ne")  parts.push(`${nk} <> ${vRef}`);
    else if (w.operator === "in") {
      // Simple IN — real impl (H3) handles chunking
      const vals = Array.isArray(w.value) ? w.value : [w.value];
      const inRefs = vals.map((_v: any, j: number) => {
        const ref = `:v${vi + j}`;
        values[ref] = vals[j];
        return ref;
      });
      vi += vals.length;
      parts.push(`${nk} IN (${inRefs.join(", ")})`);
    } else if (w.operator === "starts_with") {
      parts.push(`begins_with(${nk}, ${vRef})`);
    } else if (w.operator === "contains") {
      parts.push(`contains(${nk}, ${vRef})`);
    } else {
      parts.push(`${nk} = ${vRef}`);
    }
  }

  return {
    expression: parts.join(" AND "),
    names,
    values,
  };
}
