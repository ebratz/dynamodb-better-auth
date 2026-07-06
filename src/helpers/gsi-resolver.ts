/**
 * Single source of truth for resolving GSI declarations from config.
 *
 * `config.indexes` is `Record<model, Record<fieldName, GsiDeclaration>>`
 * (types.ts). The map KEY is a human label only — resolution matches on
 * the declaration's `hashKey`, never on the key. Three call sites
 * (query-planner, count, find-many) previously interpreted the shape
 * three different ways; they all resolve through here now.
 */

import type { DynamoDBAdapterConfig, GsiDeclaration } from "../types";
import { toDefaultModelName } from "./model-name";

/**
 * Returns the first GSI on `model` whose hash key is `field`.
 */
export function findGsiForField(
  model: string,
  field: string,
  config: DynamoDBAdapterConfig,
): GsiDeclaration | undefined {
  const modelIndexes = config.indexes?.[toDefaultModelName(config, model)];
  if (!modelIndexes) return undefined;
  for (const gsi of Object.values(modelIndexes)) {
    if (gsi.hashKey === field) return gsi;
  }
  return undefined;
}

/**
 * Returns the GSI on `model` with the given DynamoDB index name.
 */
export function findGsiByIndexName(
  model: string,
  indexName: string,
  config: DynamoDBAdapterConfig,
): GsiDeclaration | undefined {
  const modelIndexes = config.indexes?.[toDefaultModelName(config, model)];
  if (!modelIndexes) return undefined;
  for (const gsi of Object.values(modelIndexes)) {
    if (gsi.indexName === indexName) return gsi;
  }
  return undefined;
}

/**
 * Lists all GSI declarations for a model.
 */
export function listGsis(
  model: string,
  config: DynamoDBAdapterConfig,
): GsiDeclaration[] {
  return Object.values(config.indexes?.[toDefaultModelName(config, model)] ?? {});
}
