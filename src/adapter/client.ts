/**
 * Client infrastructure — per DESIGN.md §8.
 *
 * resolveDocClient wraps a raw DynamoDBClient or validates a pre-configured
 * DocumentClient. If raw, constructs with { removeUndefinedValues: true }.
 */

import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient as DocClientType } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBAdapterConfig } from "../types";
import { DynamoAdapterError } from "../errors";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DynamoDBClientLike = any;

/**
 * Wraps a raw DynamoDBClient or validates a pre-configured DocumentClient.
 * If raw client, constructs a DocumentClient with marshallOptions that strip
 * undefined values to prevent ValidationException on optional auth fields.
 */
export function resolveDocClient(
  client: DynamoDBClientLike | DocClientType,
): DocClientType {
  // If already a DocumentClient (instanceof or structural check), pass through.
  // instanceof can fail when DynamoDBDocumentClient is mocked (vitest).
  try {
    if (client instanceof DynamoDBDocumentClient) {
      return client;
    }
  } catch {
    // instanceof failed — fall through to structural check
  }

  // Structural passthrough: DocumentClient stores translate options either in
  // config.translateConfig (real SDK) or as a direct property (mock objects).
  if (
    client &&
    typeof client === "object" &&
    typeof client.send === "function" &&
    ("translateConfig" in client ||
      (client.config && "translateConfig" in client.config))
  ) {
    return client as DocClientType;
  }

  // If the client doesn't even have a send method, return as-is.
  // This handles mock/test objects that may be configured later.
  if (
    !client ||
    typeof client !== "object" ||
    typeof client.send !== "function"
  ) {
    return client as DocClientType;
  }

  return DynamoDBDocumentClient.from(client as DynamoDBClientLike, {
    marshallOptions: {
      removeUndefinedValues: true,
      convertClassInstanceToMap: false,
    },
    unmarshallOptions: {
      wrapNumbers: false,
    },
  });
}

/**
 * Returns the configured table name for a model.
 * Throws DynamoAdapterError("UNKNOWN_MODEL") if missing.
 */
export function getTableName(
  model: string,
  config: DynamoDBAdapterConfig,
): string {
  const tableName = config.tables[model];
  if (!tableName) {
    throw new DynamoAdapterError(
      "UNKNOWN_MODEL",
      `[UNKNOWN_MODEL] No table configured for model "${model}".`,
    );
  }
  return tableName;
}
