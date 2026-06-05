/**
 * consumeOne method — per DESIGN.md §5 (consumeOne method) + review-gap fix A.
 *
 * Atomically reads and deletes a single item.
 *
 * - Tier 1: PK (or PK+SK) equality → DeleteCommand with
 *   ReturnValues: "ALL_OLD".
 * - Tier 2: Query the GSI with Limit: 1 via resolveItemByPlan,
 *   extract key, then DeleteCommand with ReturnValues: "ALL_OLD".
 * - Tier 3: rejected → throw InvalidWhereError (consumeOne requires PK or
 *   indexed equality — Gap A fix).
 *
 * Returns the deleted item's Attributes, or null if no item matched.
 */

import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBAdapterConfig } from "../../types";
import { getKeySchema } from "../../helpers/key-builder";
import { getTableName } from "../client";
import { resolveQueryPlan } from "../../helpers/query-planner";
import { resolveItemByPlan } from "../../helpers/resolve-item";
import { InvalidWhereError } from "../../errors";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Where = any;

export function consumeOneMethod(
  docClient: DynamoDBDocumentClient,
  config: DynamoDBAdapterConfig,
) {
  return async (args: {
    model: string;
    where: Where[];
  }): Promise<Record<string, any> | null> => {
    const { model, where } = args;
    const tableName = getTableName(model, config);
    const schema = getKeySchema(model, config);

    // ── Resolve plan via centralized planner ──────────────────
    const plan = resolveQueryPlan(where, model, config);

    let key: Record<string, any>;

    if (plan.tier === 1) {
      // Tier 1: direct PK (or PK+SK) access.
      // For composite-key models, the planner treats SK as optional but
      // consumeOne requires both PK and SK to uniquely identify one item.
      if (schema.skField && !(schema.skField in (plan.key ?? {}))) {
        throw new InvalidWhereError(
          `consumeOne requires both PK (${schema.pkField}) and ` +
          `SK (${schema.skField}) for composite-key model "${model}".`,
        );
      }
      key = plan.key!;
    } else if (plan.tier === 2) {
      // Tier 2: find the item via shared resolver, then extract key
      const item = await resolveItemByPlan(
        docClient,
        tableName,
        plan,
        config,
        model,
      );
      if (!item) return null;
      key = { [schema.pkField]: item[schema.pkField] };
      if (schema.skField && item[schema.skField] !== undefined) {
        key[schema.skField] = item[schema.skField];
      }
    } else {
      // Tier 3: rejected — consumeOne requires PK or indexed equality
      if (schema.skField) {
        const pkMatch = where.find(
          (w: Where) =>
            w.field === schema.pkField && (!w.operator || w.operator === "eq"),
        );
        const skMatch = where.find(
          (w: Where) =>
            w.field === schema.skField && (!w.operator || w.operator === "eq"),
        );
        if (pkMatch && !skMatch) {
          throw new InvalidWhereError(
            `consumeOne requires both PK (${schema.pkField}) and ` +
            `SK (${schema.skField}) for composite-key model "${model}".`,
          );
        }
      }
      throw new InvalidWhereError(
        `consumeOne requires PK equality or indexed field equality (Tier 1 or Tier 2). ` +
        `Got Tier 3 Scan for model "${model}".`,
      );
    }

    // ── Atomic delete with pre-state capture ──────────────────
    const result = await docClient.send(
      new DeleteCommand({
        TableName: tableName,
        Key: key,
        ReturnValues: "ALL_OLD",
      }),
    );

    return (result.Attributes as any) ?? null;
  };
}
