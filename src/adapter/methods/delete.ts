/**
 * delete method — per DESIGN.md §5 (delete method).
 *
 * Deletes a single item identified by the where clause.
 *
 * Uses centralized resolveQueryPlan for Tier 1–3 key resolution.
 * Tier 1: DeleteCommand on resolved PK (+SK).
 * Tier 2/3: Query/Scan + Limit:1 to find the row, extract key,
 *           then DeleteCommand.
 * Missing item → silently OK (no-op).
 */

import { DeleteCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBAdapterConfig, WhereClause } from "../../types";
import { getKeySchema } from "../../helpers/key-builder";
import { resolveQueryPlan } from "../../helpers/query-planner";
import { resolveItemByPlan, matchesClientFilters } from "../../helpers/resolve-item";
import { getTableName } from "../client";

export function deleteMethod(
  docClient: DynamoDBDocumentClient,
  config: DynamoDBAdapterConfig,
) {
  return async (args: {
    model: string;
    where: WhereClause[];
  }): Promise<void> => {
    const { model, where } = args;
    const tableName = getTableName(model, config);
    const schema = getKeySchema(model, config);

    // ── Resolve plan via centralized planner ───────────────────
    const plan = resolveQueryPlan(where, model, config);

    // Vacuously-false where clause (e.g. `in: []`) — nothing to delete.
    if (plan.alwaysFalse) return;

    // ── Resolve key ────────────────────────────────────────────
    let key: Record<string, any>;

    if (plan.tier === 1) {
      // Tier-1 keys are always complete (the planner falls through to
      // Tier 2/3 otherwise). Extra where clauses must be verified against
      // the actual item — GetItem has no FilterExpression, and routing a
      // Tier-1 plan through resolveItemByPlan would scan UNFILTERED and
      // delete an arbitrary row.
      if (plan.needsClientSideFilter && plan.clientSideFilters) {
        const current = await docClient.send(
          new GetCommand({ TableName: tableName, Key: plan.key! }),
        );
        const item = (current.Item as any) ?? null;
        if (!item || !matchesClientFilters(item, plan.clientSideFilters)) {
          return; // silently OK — nothing matching to delete
        }
      }
      key = plan.key!;
    } else {
      // Tier 2/3: find the item first
      const item = await resolveItemByPlan(
        docClient,
        tableName,
        plan,
        config,
        model,
      );
      if (!item) return; // silently OK — nothing to delete
      key = { [schema.pkField]: item[schema.pkField] };
      if (schema.skField && item[schema.skField] !== undefined) {
        key[schema.skField] = item[schema.skField];
      }
    }

    // ── Execute DeleteItem ─────────────────────────────────────
    await docClient.send(
      new DeleteCommand({
        TableName: tableName,
        Key: key,
      }),
    );
  };
}


