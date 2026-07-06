/**
 * Model-name normalization.
 *
 * better-auth applies `getModelName` (custom `modelName` overrides and
 * `usePlural`) BEFORE calling the adapter, so methods receive mapped names
 * like "users"/"sessions". Adapter config (`tables`, `indexes`,
 * `keySchemas`) and the hardcoded core key schemas are keyed by DEFAULT
 * model names ("user", "session", ...). Every config lookup normalizes
 * through here first.
 *
 * The resolver is better-auth's own `getDefaultModelName`, handed to the
 * adapter callback by `createAdapterFactory` and registered per config
 * object at factory init. Outside the factory (unit tests, direct method
 * construction) no resolver is registered and names pass through unchanged.
 */

import type { DynamoDBAdapterConfig } from "../types";

const resolvers = new WeakMap<object, (model: string) => string>();

/** Registers better-auth's getDefaultModelName for a config instance. */
export function registerModelNameResolver(
  config: DynamoDBAdapterConfig,
  resolve: (model: string) => string,
): void {
  resolvers.set(config, resolve);
}

/**
 * Maps a (possibly plural/renamed) model name back to its default name
 * for config/schema lookups. Identity when no resolver is registered.
 */
export function toDefaultModelName(
  config: DynamoDBAdapterConfig,
  model: string,
): string {
  const resolve = resolvers.get(config);
  if (!resolve) return model;
  try {
    return resolve(model) ?? model;
  } catch {
    // getDefaultModelName throws for models missing from the schema
    // (e.g. the emailLookups sidecar) — fall back to the raw name.
    return model;
  }
}
