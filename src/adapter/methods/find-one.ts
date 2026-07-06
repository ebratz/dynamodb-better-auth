/**
 * findOne method — per DESIGN.md §5 (findOne method).
 *
 * Resolves query plan via centralized resolveQueryPlan:
 *   Tier 1: GetItem on PK (or composite PK+SK) with client-side filter
 *   Tier 2/3: delegated to resolveItemByPlan (Query/Scan + KEYS_ONLY follow-up)
 *
 * Joins are ignored (supportsJoin: false).
 */

import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBAdapterConfig, WhereClause } from "../../types";
import { resolveQueryPlan } from "../../helpers/query-planner";
import { resolveItemByPlan, matchesClientFilters } from "../../helpers/resolve-item";
import { getTableName } from "../client";

export function findOneMethod(
  docClient: DynamoDBDocumentClient,
  config: DynamoDBAdapterConfig
) {
  return async (args: {
    model: string;
    where: WhereClause[];
    select?: string[];
    join?: any;
  }): Promise<Record<string, any> | null> => {
    const tableName = getTableName(args.model, config);

    const plan = resolveQueryPlan(args.where, args.model, config);

    // Vacuously-false where clause (e.g. `in: []`) — nothing can match.
    if (plan.alwaysFalse) return null;

    // ── Tier 1: GetItem ──────────────────────────────────────
    if (plan.operation === "getItem") {
      const result = await docClient.send(
        new GetCommand({
          TableName: tableName,
          Key: plan.key!,
        })
      );
      let item = (result.Item as any) ?? null;

      // Apply client-side filters for extra clauses that GetItem can't enforce.
      if (item && plan.needsClientSideFilter && plan.clientSideFilters) {
        if (!matchesClientFilters(item, plan.clientSideFilters)) {
          return null;
        }
      }

      return item;
    }

    // ── Tier 2/3: delegate to shared item resolver ────────────
    return resolveItemByPlan(docClient, tableName, plan, config, args.model);
  };
}
