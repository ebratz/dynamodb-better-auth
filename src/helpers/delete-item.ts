import { DeleteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBAdapterConfig, WhereClause } from "../types";
import { writeCondition, snapshotWhere } from "./write-condition";
import { getKeySchema } from "./key-builder";
import { getTableName } from "../adapter/client";
import { toDefaultModelName } from "./model-name";
import { commitUserMutation } from "../email-uniqueness";

/** Return the deleted preimage; null means no row still satisfied the predicate. */
export async function deleteItem(
  client: DynamoDBDocumentClient,
  config: DynamoDBAdapterConfig,
  model: string,
  key: Record<string, unknown>,
  where: WhereClause[],
  snapshot?: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const schema = getKeySchema(model, config);
  const unique = config.enableEmailUniqueness && toDefaultModelName(config, model) === "user";
  if (unique && !snapshot) return null;
  const input = {
    TableName: getTableName(model, config), Key: key,
    ...writeCondition(unique && snapshot ? snapshotWhere(snapshot) : where, schema.pkField, snapshot),
  };
  if (unique && snapshot) {
    return await commitUserMutation(client, config, snapshot, { Delete: input }) ? snapshot : null;
  }
  try {
    const result = await client.send(new DeleteCommand({ ...input, ReturnValues: "ALL_OLD" }));
    return result.Attributes ?? null;
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") return null;
    throw error;
  }
}
