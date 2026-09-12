import { describe, it, expect } from "vitest";
import {
  TTL_GRACE_SECONDS,
  DEFAULT_TTL_ATTRIBUTE,
  ttlFromExpiryValue,
  resolveTtlField,
  ttlAttributeName,
  withTtlAttribute,
} from "../src/helpers/ttl";
import { makeConfig } from "./helpers";

describe("ttlFromExpiryValue", () => {
  it("converts an ISO-8601 string to epoch seconds + grace", () => {
    const iso = "2030-01-01T00:00:00.000Z";
    const expected = Math.floor(Date.parse(iso) / 1000) + TTL_GRACE_SECONDS;
    expect(ttlFromExpiryValue(iso)).toBe(expected);
  });

  it("converts a Date to epoch seconds + grace", () => {
    const date = new Date("2030-01-01T00:00:00.000Z");
    const expected = Math.floor(date.getTime() / 1000) + TTL_GRACE_SECONDS;
    expect(ttlFromExpiryValue(date)).toBe(expected);
  });

  it("treats a numeric value as epoch milliseconds (e.g. rateLimit.lastRequest)", () => {
    const ms = 1_700_000_000_000;
    expect(ttlFromExpiryValue(ms)).toBe(ms / 1000 + TTL_GRACE_SECONDS);
  });

  it("does not place an already-seconds value in 1970", () => {
    const seconds = 1_700_000_000;
    expect(ttlFromExpiryValue(seconds)).toBe(seconds + TTL_GRACE_SECONDS);
  });

  it("honours a custom grace period", () => {
    expect(ttlFromExpiryValue(1_700_000_000_000, 60)).toBe(1_700_000_000 + 60);
  });

  it("returns undefined for values that carry no expiry", () => {
    expect(ttlFromExpiryValue(Number.NaN)).toBeUndefined();
    expect(ttlFromExpiryValue(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(ttlFromExpiryValue("not-a-date")).toBeUndefined();
    expect(ttlFromExpiryValue(null)).toBeUndefined();
    expect(ttlFromExpiryValue(undefined)).toBeUndefined();
    expect(ttlFromExpiryValue({})).toBeUndefined();
  });
});

describe("resolveTtlField / ttlAttributeName", () => {
  it("reads the per-model TTL field from config", () => {
    const config = makeConfig({ ttlFields: { verification: "expiresAt" } });
    expect(resolveTtlField(config, "verification")).toBe("expiresAt");
    expect(resolveTtlField(config, "user")).toBeUndefined();
  });

  it("defaults the TTL attribute name to 'ttl' and allows an override", () => {
    expect(ttlAttributeName(makeConfig())).toBe(DEFAULT_TTL_ATTRIBUTE);
    expect(ttlAttributeName(makeConfig({ ttlAttribute: "expiresTtl" }))).toBe(
      "expiresTtl",
    );
  });
});

describe("withTtlAttribute", () => {
  const config = makeConfig({ ttlFields: { verification: "expiresAt" } });

  it("attaches a numeric TTL attribute when the expiry field is present", () => {
    const expiresAt = new Date("2030-01-01T00:00:00.000Z");
    const result = withTtlAttribute(config, "verification", {
      id: "v1",
      expiresAt,
    });
    expect(result.ttl).toBe(
      Math.floor(expiresAt.getTime() / 1000) + TTL_GRACE_SECONDS,
    );
  });

  it("uses the configured attribute name", () => {
    const config = makeConfig({
      ttlFields: { verification: "expiresAt" },
      ttlAttribute: "expiresTtl",
    });
    const result = withTtlAttribute(config, "verification", {
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });
    expect(result.expiresTtl).toBeTypeOf("number");
    expect(result.ttl).toBeUndefined();
  });

  it("returns the input unchanged when the model has no declared TTL field", () => {
    const data = { id: "u1", expiresAt: new Date() };
    expect(withTtlAttribute(config, "user", data)).toBe(data);
  });

  it("returns the input unchanged when the expiry field is absent", () => {
    const data = { id: "v1", identifier: "state" };
    expect(withTtlAttribute(config, "verification", data)).toBe(data);
  });

  it("does not mutate the input object", () => {
    const data: Record<string, unknown> = {
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    };
    const result = withTtlAttribute(config, "verification", data);
    expect(result).not.toBe(data);
    expect(data.ttl).toBeUndefined();
  });

  it("omits the TTL attribute when the expiry value cannot be parsed", () => {
    const data = { id: "v1", expiresAt: "garbage" };
    expect(withTtlAttribute(config, "verification", data)).toBe(data);
  });
});
