/**
 * create method — per DESIGN.md §5 (create method).
 *
 * Uses PutItem with ConditionExpression for idempotent creates.
 * For composite-key tables (Accounts), attribute_not_exists guards the full
 * (providerId, accountId) tuple per DynamoDB semantics.
 *
 * When enableEmailUniqueness is true and model is "user", delegates to
 * createUserWithEmailUniqueness (X2).
 */

import { PutCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBAdapterConfig } from "../../types";
import { getKeySchema } from "../../helpers/key-builder";
import { buildExpressionNames } from "../../helpers/expression-names";
import { sanitizeForWrite } from "../../helpers/update-item";
import { DynamoAdapterError } from "../../errors";
import { createUserWithEmailUniqueness } from "../../email-uniqueness";

export function createMethod(
  docClient: DynamoDBDocumentClient,
  config: DynamoDBAdapterConfig,
) {
  return async (args: {
    model: string;
    data: Record<string, any>;
    select?: string[];
  }): Promise<Record<string, any>> => {
    const { model, data } = args;

    // Fall back to model name when not explicitly configured
    const tableName = config.tables[model] ?? model;

    // ── Email uniqueness path ──────────────────────────────────
    if (
      config.enableEmailUniqueness &&
      model === "user" &&
      data.email &&
      config.tables.emailLookups
    ) {
      return createUserWithEmailUniqueness(docClient, config, data);
    }

    // ── Standard create ────────────────────────────────────────
    const schema = getKeySchema(model, config);
    const pkField = schema.pkField;
    const { names } = buildExpressionNames([pkField]);

    const placeholderKeys = Object.keys(names);
    const placeholder = placeholderKeys.length > 0 ? placeholderKeys[0]! : "#n0";

    // Convert Date → ISO string for DocumentClient marshalling
    const item = sanitizeForWrite(data);

    try {
      await docClient.send(
        new PutCommand({
          TableName: tableName,
          Item: item,
          ConditionExpression: `attribute_not_exists(${placeholder})`,
          ExpressionAttributeNames: placeholderKeys.length > 0 ? names : undefined,
        }),
      );
      return data;
    } catch (err: any) {
      if (err.name === "ConditionalCheckFailedException") {
        throw new DynamoAdapterError(
          "CONDITIONAL_CHECK_FAILED",
          `Item with ${pkField}="${data[pkField]}" already exists in ${tableName}`,
        );
      }
      throw err;
    }
  };
}
