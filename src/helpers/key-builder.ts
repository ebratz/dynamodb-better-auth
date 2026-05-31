import { InvalidWhereError } from "../errors";
import type { DynamoDBAdapterConfig, KeySchema } from "../types";

/**
 * Returns the key schema (pkField, skField?) for a model.
 * Resolution order:
 *   1. config.keySchemas?.[model] (explicit override)
 *   2. Hardcoded core models
 *   3. Default { pkField: "id" } for plugin models
 *
 * Per DESIGN.md §2 + review-gap fix C.
 */
export function getKeySchema(
  model: string,
  config: DynamoDBAdapterConfig
): KeySchema {
  // 1. Explicit override
  if (config.keySchemas?.[model]) {
    return config.keySchemas[model]!;
  }

  // 2. Hardcoded core models
  const coreSchemas: Record<string, KeySchema> = {
    user:         { pkField: "id" },
    session:      { pkField: "token" },
    account:      { pkField: "providerId", skField: "accountId" },
    verification: { pkField: "id" },
    emailLookups: { pkField: "email" },
  };

  if (coreSchemas[model]) {
    return coreSchemas[model]!;
  }

  // 3. Plugin models default to PK=id
  return { pkField: "id" };
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
