/**
 * Shared item-fetching helper for bulk operations (updateMany, deleteMany).
 *
 * Extracted from update-many.ts and delete-many.ts — both had near-identical
 * _findItems functions. Resolves a QueryPlan from the where clause and fetches
 * all matching items via the appropriate DynamoDB access pattern.
 *
 * - Tier 1 (opt-in): GetItem for PK equality → single-item array.
 * - Tier 2: GSI Query with fetchAllByPlan + optional KEYS_ONLY follow-up.
 * - Tier 3: Scan with fetchAllByPlan.
 * - Empty where: full table Scan.
 */

import { GetCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBAdapterConfig } from "../types";
import type { WhereClause } from "../types";
import { resolveQueryPlan } from "./query-planner";
import { resolveKEYS_ONLY } from "./batch-get";
import { fetchAllByPlan, type FetchAllPlan } from "./fetch-all";
import { shouldLog } from "./debug-log";
import { getLogger } from "./logger";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRecord = Record<string, any>;

export async function findAllItems(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  where: WhereClause[],
  model: string,
  schema: { pkField: string; skField?: string },
  config: DynamoDBAdapterConfig,
  opts?: {
    /** Debug key used in Tier-3 warning messages (e.g. "updateMany", "deleteMany"). */
    debugKey?: string;
    /** When true, handles Tier 1 (GetItem on PK). Default: false. */
    includeTier1?: boolean;
  },
): Promise<AnyRecord[]> {
  // No where clause → full table Scan
  if (!where || where.length === 0) {
    return fetchAllByPlan(docClient, tableName, {
      operation: "scan",
      expressionAttributeNames: {},
      expressionAttributeValues: {},
    });
  }

  const plan = resolveQueryPlan(where, model, config);

  // ── Tier 1: GetItem (opt-in) ────────────────────────────────
  if (opts?.includeTier1 && plan.operation === "getItem") {
    const result = await docClient.send(
      new GetCommand({
        TableName: tableName,
        Key: plan.key!,
      }),
    );
    const item = result.Item as any;
    return item ? [item] : [];
  }

  // ── Tier 2: GSI Query ───────────────────────────────────────
  if (plan.operation === "query") {
    const items = await fetchAllByPlan(docClient, tableName, plan as any);

    // Follow-up BatchGetItem for KEYS_ONLY GSIs
    if (plan.needsFollowUpGetItem && items.length > 0) {
      return resolveKEYS_ONLY(
        docClient,
        tableName,
        plan.followUpKeyFields ?? { pkField: schema.pkField, skField: schema.skField },
        items,
      );
    }

    return items;
  }

  // ── Tier 3: Scan ────────────────────────────────────────────
  if (opts?.debugKey && shouldLog(config, opts.debugKey)) {
    getLogger(config).warn(
      `[dynamodb-adapter] ${opts.debugKey} on ${model} using Scan (Tier 3). ` +
        `Consider adding a GSI for the queried field(s).`,
      { model, debugKey: opts.debugKey },
    );
  }

  return fetchAllByPlan(docClient, tableName, plan as FetchAllPlan);
}
