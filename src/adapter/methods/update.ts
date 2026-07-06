/**
 * update method — per DESIGN.md §5 (update method) + accepted R3.
 *
 * Returns the full updated row (ReturnValues: "ALL_NEW").
 *
 * Uses centralized resolveQueryPlan for Tier 1–3 key resolution.
 * Tier 1: UpdateCommand on resolved PK (+SK) with ConditionExpression
 *         (attribute_exists) to prevent upsert on missing items.
 * Tier 2/3: Query/Scan + Limit:1 to find the row, extract key,
 *           then UpdateCommand. No PutItem fallback.
 *
 * PK/SK fields are stripped from the update payload to prevent
 * DynamoDB ValidationException on key-attribute mutation.
 */

import {
  UpdateCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBAdapterConfig, WhereClause } from "../../types";
import { getKeySchema } from "../../helpers/key-builder";
import { resolveQueryPlan } from "../../helpers/query-planner";
import { resolveItemByPlan, matchesClientFilters } from "../../helpers/resolve-item";
import { buildUpdateExpression } from "../../helpers/update-item";
import { getTableName } from "../client";
import { DynamoAdapterError } from "../../errors";

export function updateMethod(
  docClient: DynamoDBDocumentClient,
  config: DynamoDBAdapterConfig,
) {
  return async (args: {
    model: string;
    where: WhereClause[];
    update: Record<string, any>;
  }): Promise<Record<string, any> | null> => {
    const { model, where, update } = args;
    const tableName = getTableName(model, config);
    const schema = getKeySchema(model, config);

    // ── Resolve plan via centralized planner ───────────────────
    const plan = resolveQueryPlan(where, model, config);

    // Vacuously-false where clause (e.g. `in: []`) — nothing can match.
    if (plan.alwaysFalse) return null;

    // ── Resolve key ────────────────────────────────────────────
    let key: Record<string, any>;

    if (plan.tier === 1) {
      // Tier-1 keys are always complete (the planner falls through to
      // Tier 2/3 otherwise). Extra where clauses must be verified against
      // the actual item — GetItem has no FilterExpression, and routing a
      // Tier-1 plan through resolveItemByPlan would scan UNFILTERED.
      if (plan.needsClientSideFilter && plan.clientSideFilters) {
        const current = await docClient.send(
          new GetCommand({ TableName: tableName, Key: plan.key! }),
        );
        const item = (current.Item as any) ?? null;
        if (!item || !matchesClientFilters(item, plan.clientSideFilters)) {
          return null;
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
      if (!item) return null;
      key = { [schema.pkField]: item[schema.pkField] };
      if (schema.skField && item[schema.skField] !== undefined) {
        key[schema.skField] = item[schema.skField];
      }
    }

    // ── Build UpdateExpression via shared helper ───────────────
    // Strips PK/SK fields, converts Date → ISO, returns #nX/:vN placeholders.
    const { setClauses, attrNames, attrValues } = buildUpdateExpression(
      update,
      schema.pkField,
      schema.skField,
    );

    if (setClauses.length === 0) {
      // Nothing to update — return the item as-is
      const result = await docClient.send(
        new GetCommand({ TableName: tableName, Key: key }),
      );
      return (result.Item as any) ?? null;
    }

    // ── Execute UpdateItem ─────────────────────────────────────
    // ConditionExpression (#pk) guards against upsert on missing
    // items. #pk is distinct from buildUpdateExpression's #nX
    // placeholders since PK/SK were stripped above.
    try {
      const result = await docClient.send(
        new UpdateCommand({
          TableName: tableName,
          Key: key,
          UpdateExpression: `SET ${setClauses.join(", ")}`,
          ExpressionAttributeNames: { ...attrNames, "#pk": schema.pkField },
          ExpressionAttributeValues: attrValues,
          ConditionExpression: "attribute_exists(#pk)",
          ReturnValues: "ALL_NEW",
        }),
      );
      return (result.Attributes as any) ?? null;
    } catch (err: any) {
      // ConditionalCheckFailedException → item didn't exist.
      // Return null so callers can handle missing items gracefully.
      if (err.name === "ConditionalCheckFailedException") {
        return null;
      }
      throw new DynamoAdapterError(
        "DYNAMODB_ERROR",
        err.message || "Unexpected DynamoDB error",
        err,
      );
    }
  };
}


