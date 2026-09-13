/**
 * Store-level TTL support (ports the fix described in
 * app.ebratz.com `docs/build/12-better-auth-dynamodb-adapter-fix.md`, §6.1).
 *
 * Better Auth garbage-collects its own expired rows by issuing a keyless
 * range delete over a whole model — `deleteMany(<field> lt <now>)`. A
 * key-value store cannot serve that from a key, so the adapter has two
 * options: scan (what Tier 3 does today, which is fatal on large tables and
 * trips `maxDeleteManyItems`) or recognise the sweep and defer to DynamoDB's
 * native TTL. This module supplies the pieces for the second option:
 *
 *   1. `ttlFromExpiryValue` — turn whatever Better Auth wrote (ISO string,
 *      Date, or epoch-millisecond number) into epoch **seconds** + grace,
 *      the only shape DynamoDB TTL deletes on.
 *   2. `withTtlAttribute` — derive and attach that attribute to a write
 *      payload when the model declares a TTL field.
 *
 * The grace period is not cosmetic: DynamoDB deletes strictly *later* than
 * the sweep's cutoff, so it can delete rows the sweep would have deleted and
 * never rows the sweep would have kept. A TTL that fired early would be a
 * real bug.
 *
 * `ttlPruneWhere` (in query-planner.ts) recognises the sweep itself and is
 * gated on the same `ttlFields` declaration, so a model that has not opted
 * into TTL keeps the previous behaviour.
 */

import type { DynamoDBAdapterConfig } from "../types";
import { toDefaultModelName } from "./model-name";

/** Extra time a TTL row lives past its expiry. Mirrors app.ebratz's 7 days. */
export const TTL_GRACE_SECONDS = 7 * 24 * 60 * 60;

/** Default name of the numeric DynamoDB TTL attribute. */
export const DEFAULT_TTL_ATTRIBUTE = "ttl";

/**
 * Epoch **milliseconds** floor below which a numeric expiry value is read as
 * epoch **seconds**. Any real millisecond timestamp is ≥ 1e11 (1973-03-03),
 * and any real seconds timestamp is ~1e9, so this cleanly separates the two.
 * Read a seconds value as milliseconds and the TTL lands in 1970 and
 * DynamoDB deletes the row on sight.
 */
const EPOCH_MS_FLOOR = 1e11;

/**
 * Converts a Better Auth expiry value into a DynamoDB TTL timestamp
 * (epoch seconds, plus the grace period).
 *
 * - `number` → epoch milliseconds (e.g. `rateLimit.lastRequest`), with a
 *   guard for values already expressed in seconds.
 * - `Date` / ISO-8601 `string` → parsed, then converted to seconds.
 *
 * Returns `undefined` for values that cannot carry an expiry, so callers
 * simply omit the TTL attribute rather than writing a bogus one.
 */
export function ttlFromExpiryValue(
  value: unknown,
  graceSeconds: number = TTL_GRACE_SECONDS,
): number | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    const seconds =
      value >= EPOCH_MS_FLOOR ? Math.floor(value / 1000) : Math.floor(value);
    return seconds + graceSeconds;
  }

  let millis: number | undefined;
  if (value instanceof Date) {
    millis = value.getTime();
  } else if (typeof value === "string") {
    millis = Date.parse(value);
  }

  if (millis === undefined || Number.isNaN(millis)) return undefined;
  return Math.floor(millis / 1000) + graceSeconds;
}

/** The expiry field declared for `model`, or `undefined` when it has no TTL. */
export function resolveTtlField(
  config: DynamoDBAdapterConfig,
  model: string,
): string | undefined {
  return config.ttlFields?.[toDefaultModelName(config, model)];
}

/** The configured DynamoDB TTL attribute name. */
export function ttlAttributeName(config: DynamoDBAdapterConfig): string {
  return config.ttlAttribute ?? DEFAULT_TTL_ATTRIBUTE;
}

/**
 * Returns a copy of `data` with the numeric TTL attribute attached when:
 *   - the model declares a TTL field (via `config.ttlFields`), and
 *   - that field is present in `data`, and
 *   - its value converts to a valid TTL timestamp.
 *
 * Otherwise returns `data` unchanged (same reference). Never mutates input.
 */
export function withTtlAttribute<T extends Record<string, any>>(
  config: DynamoDBAdapterConfig,
  model: string,
  data: T,
): T {
  const field = resolveTtlField(config, model);
  if (field === undefined || !(field in data)) return data;
  // DynamoDB ignores a non-numeric TTL. Clear stale deadlines on nullable expiry.
  if (data[field] === null) return { ...data, [ttlAttributeName(config)]: null };

  const ttl = ttlFromExpiryValue((data as Record<string, any>)[field]);
  if (ttl === undefined) return data;

  return { ...data, [ttlAttributeName(config)]: ttl };
}
