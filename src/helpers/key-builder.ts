import { InvalidWhereError } from "../errors";
import type { DynamoDBAdapterConfig, KeySchema } from "../types";
import { toDefaultModelName } from "./model-name";

/** Module-level cache: model → schema. Immutable once resolved. */
const schemaCache = new Map<string, KeySchema>();

/**
 * Returns the key schema (pkField, skField?) for a model.
 *
 * The incoming model name may be mapped (usePlural / custom modelName —
 * better-auth applies getModelName before calling the adapter); it is
 * normalized to the default name first. `config.keySchemas` is keyed by
 * default model names.
 *
 * Resolution order:
 *   1. config.keySchemas?.[model] (explicit override)
 *   2. Hardcoded core models
 *   3. Default { pkField: "id" } for plugin models
 *
 * Results are memoized per model name — schemas are immutable once computed.
 *
 * Per DESIGN.md §2 + review-gap fix C.
 */
export function getKeySchema(
  model: string,
  config: DynamoDBAdapterConfig
): KeySchema {
  model = toDefaultModelName(config, model);

  // 1. Explicit override — config-specific, never cached
  if (config.keySchemas?.[model]) {
    return config.keySchemas[model]!;
  }

  // 2-3. Core models + plugin defaults — immutable per model name
  const cached = schemaCache.get(model);
  if (cached) return cached;

  let result: KeySchema;

  // 2. Hardcoded core models
  const coreSchemas: Record<string, KeySchema> = {
    user:         { pkField: "id" },
    session:      { pkField: "token" },
    account:      { pkField: "providerId", skField: "accountId" },
    verification: { pkField: "id" },
    emailLookups: { pkField: "email" },
    // better-auth's built-in database rate limiting always reads/writes
    // by `key` (never `id`) — without this, every rate-limited request
    // degrades to a full-table Scan.
    rateLimit:    { pkField: "key" },
  };

  if (coreSchemas[model]) {
    result = coreSchemas[model]!;
    schemaCache.set(model, result);
    return result;
  }

  // 3. Plugin models default to PK=id
  result = { pkField: "id" };
  schemaCache.set(model, result);
  return result;
}

/**
 * Extracts a DynamoDB Key from a Better Auth where clause.
 * Only valid for Tier 1 PK-equality lookups.
 */
export function buildKeyFromWhere(
  where: any[],
  model: string,
  config: DynamoDBAdapterConfig
): Record<string, any> {
  const schema = getKeySchema(model, config);

  const pkClause = where.find(
    (w: any) => w.field === schema.pkField,
  );
  if (!pkClause) {
    throw new InvalidWhereError(
      `Cannot build key: missing PK field "${schema.pkField}" in where clause`,
    );
  }
  if (pkClause.operator && pkClause.operator !== "eq") {
    throw new InvalidWhereError(
      `Cannot build key: PK field "${schema.pkField}" must use "eq" operator, got "${pkClause.operator}"`,
    );
  }

  const key: Record<string, any> = { [schema.pkField]: pkClause.value };

  if (schema.skField) {
    const skClause = where.find(
      (w: any) => w.field === schema.skField,
    );
    if (skClause) {
      if (skClause.operator && skClause.operator !== "eq") {
        throw new InvalidWhereError(
          `Cannot build key: SK field "${schema.skField}" must use "eq" operator, got "${skClause.operator}"`,
        );
      }
      key[schema.skField] = skClause.value;
    }
  }

  return key;
}
