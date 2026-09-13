/**
 * Discover matching rows, then conditionally delete each one. Recheck the
 * predicate at the write boundary and count only deleted preimages.
 * Successful deletes remain committed if a later write fails.
 */

import { deleteItem } from "../../helpers/delete-item";
import { ttlPruneWhere } from "../../helpers/query-planner";
import { resolveTtlField } from "../../helpers/ttl";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBAdapterConfig, WhereClause } from "../../types";
import { getKeySchema } from "../../helpers/key-builder";
import { getTableName } from "../client";
import { findAllItems } from "../../helpers/find-items";
import { DynamoAdapterError } from "../../errors";

export function deleteManyMethod(
  docClient: DynamoDBDocumentClient,
  config: DynamoDBAdapterConfig,
) {
  return async (args: {
    model: string;
    where?: WhereClause[];
  }): Promise<number> => {
    const { model, where } = args;

    if (ttlPruneWhere(where, resolveTtlField(config, model))) return 0;

    const tableName = getTableName(model, config);
    const schema = getKeySchema(model, config);

    // ── Find all matching items via shared helper ──────────────
    const items = await findAllItems(docClient, tableName, where ?? [], model, schema, config, {
      debugKey: "deleteMany",
      includeTier1: true,
    });

    if (items.length === 0) {
      return 0;
    }

    // ── Safety limit ──────────────────────────────────────────
    const maxItems = config.maxDeleteManyItems ?? 1000;
    if (maxItems > 0 && items.length > maxItems) {
      throw new DynamoAdapterError(
        "TOO_MANY_ITEMS",
        `deleteMany matched ${items.length} items but the safety limit is ${maxItems}. ` +
          `Refine your where clause or increase maxDeleteManyItems in config.`,
      );
    }

    // ── Extract keys from items ───────────────────────────────
    const keys = items.map((item: Record<string, any>) => {
      const key: Record<string, any> = { [schema.pkField]: item[schema.pkField] };
      if (schema.skField && item[schema.skField] !== undefined) {
        key[schema.skField] = item[schema.skField];
      }
      return key;
    });

    let deletedCount = 0;
    for (const [i, key] of keys.entries()) {
      if (await deleteItem(docClient, config, model, key, where ?? [], items[i])) deletedCount++;
    }
    return deletedCount;
  };
}
