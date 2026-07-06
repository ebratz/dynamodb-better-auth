/**
 * consumeOne method — per DESIGN.md §5 (consumeOne method) + review-gap fix A.
 *
 * Atomically reads and deletes a single item.
 *
 * - Tier 1: PK (or PK+SK) equality → DeleteCommand with
 *   ReturnValues: "ALL_OLD". Extra where clauses beyond the key are
 *   folded into a ConditionExpression so the consume stays atomic
 *   ("consume only if still unused" cannot fail open).
 * - Tier 2: Query the GSI via resolveItemByPlan, extract key, then
 *   DeleteCommand with ReturnValues: "ALL_OLD".
 * - Tier 3: rejected → throw InvalidWhereError (consumeOne requires PK or
 *   indexed equality — Gap A fix).
 *
 * Returns the deleted item's Attributes, or null if no item matched.
 */

import { DeleteCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBAdapterConfig, WhereClause } from "../../types";
import { getKeySchema } from "../../helpers/key-builder";
import { getTableName } from "../client";
import { resolveQueryPlan, resolveFilter } from "../../helpers/query-planner";
import { resolveItemByPlan, matchesClientFilters } from "../../helpers/resolve-item";
import { compactExpr } from "../../helpers/expression-names";
import { InvalidWhereError } from "../../errors";

export function consumeOneMethod(
  docClient: DynamoDBDocumentClient,
  config: DynamoDBAdapterConfig,
) {
  return async (args: {
    model: string;
    where: WhereClause[];
  }): Promise<Record<string, any> | null> => {
    const { model, where } = args;
    const tableName = getTableName(model, config);
    const schema = getKeySchema(model, config);

    // ── Resolve plan via centralized planner ──────────────────
    const plan = resolveQueryPlan(where, model, config);

    // Vacuously-false where clause (e.g. `in: []`) — nothing to consume.
    if (plan.alwaysFalse) return null;

    let key: Record<string, any>;
    let conditionFilters = plan.clientSideFilters;

    if (plan.tier === 1) {
      // Tier-1 keys are complete by construction (the planner falls
      // through to Tier 2/3 for partial composite keys).
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
      conditionFilters = undefined; // already verified by the resolver
    } else {
      // Tier 3: rejected — consumeOne requires PK or indexed equality
      if (schema.skField) {
        const pkMatch = where.find(
          (w: WhereClause) =>
            w.field === schema.pkField && (!w.operator || w.operator === "eq"),
        );
        const skMatch = where.find(
          (w: WhereClause) =>
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

    // ── Fold extra where clauses into an atomic ConditionExpression ──
    // GetItem/Delete have no FilterExpression, but Delete supports a
    // ConditionExpression — the "consume only if still valid" guard must
    // hold at delete time, not at a separate read.
    let condition:
      | { expression: string; names: Record<string, string>; values: Record<string, any> }
      | undefined;

    if (conditionFilters && conditionFilters.length > 0) {
      const filter = resolveFilter(
        conditionFilters.map((f) => ({
          field: f.field,
          operator: f.operator,
          value: f.value,
        })) as WhereClause[],
        model,
        config,
      );
      if (filter?.alwaysFalse) return null;

      if (filter?.postFilters && filter.postFilters.length > 0) {
        // ends_with cannot be expressed in a ConditionExpression.
        // Pre-verify client-side (narrow TOCTOU window), then delete with
        // the server-expressible remainder of the condition.
        const preCheck = await docClient.send(
          new GetCommand({ TableName: tableName, Key: key }),
        );
        const item = (preCheck.Item as any) ?? null;
        if (!item || !matchesClientFilters(item, conditionFilters)) {
          return null;
        }
      }
      if (filter?.expression) {
        condition = {
          expression: filter.expression,
          names: filter.expressionAttributeNames,
          values: filter.expressionAttributeValues,
        };
      }
    }

    // ── Atomic delete with pre-state capture ──────────────────
    try {
      const result = await docClient.send(
        new DeleteCommand({
          TableName: tableName,
          Key: key,
          ReturnValues: "ALL_OLD",
          ...(condition
            ? {
                ConditionExpression: condition.expression,
                ...compactExpr(condition.names, condition.values),
              }
            : {}),
        }),
      );
      return (result.Attributes as any) ?? null;
    } catch (err: any) {
      // Condition failed → the item doesn't satisfy the extra where
      // clauses (or was consumed concurrently) → not consumed.
      if (err.name === "ConditionalCheckFailedException") {
        return null;
      }
      throw err;
    }
  };
}
