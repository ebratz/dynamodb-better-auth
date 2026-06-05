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

import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBAdapterConfig, WhereClause } from "../../types";
import { getKeySchema } from "../../helpers/key-builder";
import { resolveQueryPlan } from "../../helpers/query-planner";
import { resolveItemByPlan } from "../../helpers/resolve-item";
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

    // ── Resolve key ────────────────────────────────────────────
    let key: Record<string, any>;

    // Tier 1: use pre-resolved key directly, but only when the key
    // is complete (composite tables require SK) and there are no
    // extra where clauses that need client-side filtering.
    const keyIsComplete =
      plan.tier === 1 &&
      plan.key &&
      !plan.needsClientSideFilter &&
      (!schema.skField || plan.key[schema.skField] !== undefined);

    if (keyIsComplete) {
      key = plan.key!;
    } else {
      // Tier 2/3 (or incomplete Tier 1): find the item first
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


