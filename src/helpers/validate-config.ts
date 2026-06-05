/**
 * Config validation — catches misconfiguration at startup.
 *
 * Called during `dynamodbAdapter()` construction. Throws for critical
 * errors (missing core tables). Returns warnings for non-critical issues
 * (email-uniqueness without emailLookups table, GSIs referencing unknown
 * fields on core models).
 *
 * Plugin models (anything not in CORE_MODELS) skip field validation
 * since their schemas are dynamic.
 */

import type { DynamoDBAdapterConfig } from "../types";
import { DynamoAdapterError } from "../errors";

// ── Known fields per core model ─────────────────────────────────

/** Fields expected on core Better Auth models. Used to validate GSI key references. */
const CORE_MODEL_FIELDS: Record<string, ReadonlySet<string>> = {
  user: new Set([
    "id", "email", "name", "emailVerified", "image",
    "createdAt", "updatedAt",
  ]),
  session: new Set([
    "token", "id", "userId",
    "expiresAt", "ipAddress", "userAgent",
    "createdAt", "updatedAt",
  ]),
  account: new Set([
    "providerId", "accountId", "id", "userId",
    "provider", "accessToken", "refreshToken", "idToken", "scope",
    "expiresAt", "createdAt", "updatedAt",
  ]),
  verification: new Set([
    "id", "identifier", "value",
    "expiresAt", "createdAt",
  ]),
};

const REQUIRED_TABLES = ["user", "session", "account", "verification"] as const;

// ── Public API ──────────────────────────────────────────────────

/**
 * Validates adapter configuration at construction time.
 *
 * Throws DynamoAdapterError for critical misconfiguration (missing
 * required core tables).
 *
 * Returns an array of warning strings for non-critical issues.
 * Callers should log these if debugLogs is enabled.
 */
export function validateConfig(config: DynamoDBAdapterConfig): string[] {
  const warnings: string[] = [];

  // ── Critical: required core tables ──────────────────────────
  for (const model of REQUIRED_TABLES) {
    const tableName = config.tables[model];
    if (!tableName || typeof tableName !== "string" || tableName.trim() === "") {
      throw new DynamoAdapterError(
        "INVALID_CONFIG",
        `Required table "${model}" is missing or empty. ` +
          `Core models (${REQUIRED_TABLES.join(", ")}) must have configured table names.`,
      );
    }
  }

  // ── Email uniqueness prerequisite ───────────────────────────
  if (config.enableEmailUniqueness && !config.tables.emailLookups) {
    warnings.push(
      `enableEmailUniqueness is true but tables.emailLookups is not configured. ` +
        `Email uniqueness enforcement requires an EmailLookups sidecar table. ` +
        `Set tables.emailLookups or disable enableEmailUniqueness.`,
    );
  }

  // ── GSI field validation ────────────────────────────────────
  const indexes = config.indexes ?? {};

  for (const [model, modelIndexes] of Object.entries(indexes)) {
    const knownFields = CORE_MODEL_FIELDS[model];

    // Plugin models (not in CORE_MODEL_FIELDS) skip field validation
    if (!knownFields) {
      // Plugin models have dynamic schemas — all GSI keys are accepted
      continue;
    }

    for (const [field, gsi] of Object.entries(modelIndexes)) {
      if (!knownFields.has(gsi.hashKey)) {
        warnings.push(
          `GSI "${gsi.indexName}" on model "${model}" references hashKey ` +
            `"${gsi.hashKey}" which is not a known field on this model. ` +
            `If this is intentional, ignore this warning.`,
        );
      }

      if (gsi.rangeKey && !knownFields.has(gsi.rangeKey)) {
        warnings.push(
          `GSI "${gsi.indexName}" on model "${model}" references rangeKey ` +
            `"${gsi.rangeKey}" which is not a known field on this model. ` +
            `If this is intentional, ignore this warning.`,
        );
      }
    }
  }

  return warnings;
}
