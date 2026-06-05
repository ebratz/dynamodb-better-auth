/**
 * Config validation tests.
 */

import { describe, it, expect } from "vitest";
import { validateConfig } from "../src/helpers/validate-config";
import type { DynamoDBAdapterConfig } from "../src/types";

function makeConfig(
  overrides: Partial<DynamoDBAdapterConfig> = {},
): DynamoDBAdapterConfig {
  return {
    client: {} as any,
    tables: {
      user: "Users",
      session: "Sessions",
      account: "Accounts",
      verification: "Verifications",
    },
    ...overrides,
  };
}

describe("validateConfig", () => {
  // ── Critical errors (throw) ──────────────────────────────────

  it("throws when tables.user is missing", () => {
    const config = makeConfig({ tables: {} as any });
    expect(() => validateConfig(config)).toThrow(/user.*missing/);
  });

  it("throws when tables.user is empty string", () => {
    const config = makeConfig({
      tables: { user: "", session: "S", account: "A", verification: "V" } as any,
    });
    expect(() => validateConfig(config)).toThrow(/user.*missing/);
  });

  it("throws when tables.session is missing", () => {
    const config = makeConfig({
      tables: {
        user: "U",
        session: undefined as any,
        account: "A",
        verification: "V",
      } as any,
    });
    expect(() => validateConfig(config)).toThrow(/session.*missing/);
  });

  it("throws when tables.account is missing", () => {
    expect(() =>
      validateConfig(
        makeConfig({
          tables: { user: "U", session: "S", account: "" as any, verification: "V" } as any,
        }),
      ),
    ).toThrow(/account.*missing/);
  });

  it("throws when tables.verification is missing", () => {
    expect(() =>
      validateConfig(
        makeConfig({
          tables: { user: "U", session: "S", account: "A", verification: "" as any } as any,
        }),
      ),
    ).toThrow(/verification.*missing/);
  });

  it("does not throw for valid config with all core tables", () => {
    expect(() => validateConfig(makeConfig())).not.toThrow();
  });

  // ── Warnings ─────────────────────────────────────────────────

  it("returns empty warnings for valid config", () => {
    const warnings = validateConfig(makeConfig());
    expect(warnings).toEqual([]);
  });

  it("warns when enableEmailUniqueness is true but emailLookups missing", () => {
    const config = makeConfig({
      enableEmailUniqueness: true,
    });
    const warnings = validateConfig(config);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("enableEmailUniqueness");
    expect(warnings[0]).toContain("emailLookups");
  });

  it("does not warn when enableEmailUniqueness is true and emailLookups is set", () => {
    const config = makeConfig({
      enableEmailUniqueness: true,
      tables: {
        user: "Users",
        session: "Sessions",
        account: "Accounts",
        verification: "Verifications",
        emailLookups: "EmailLookups",
      },
    });
    const warnings = validateConfig(config);
    expect(warnings).toEqual([]);
  });

  it("does not warn when enableEmailUniqueness is false (default)", () => {
    const config = makeConfig();
    const warnings = validateConfig(config);
    expect(warnings).toEqual([]);
  });

  // ── GSI validation ───────────────────────────────────────────

  it("warns when GSI hashKey references unknown field on core model", () => {
    const config = makeConfig({
      indexes: {
        user: {
          nonExistentField: {
            indexName: "bad-index",
            hashKey: "nonExistentField",
          },
        },
      },
    });
    const warnings = validateConfig(config);
    expect(warnings).toHaveLength(1);
    // The GSI is keyed by field name "nonExistentField", and its hashKey is "nonExistentField"
    // The warning mentions the hashKey
    expect(warnings[0]).toContain("nonExistentField");
    expect(warnings[0]).toContain("hashKey");
    expect(warnings[0]).toContain("user");
  });

  it("warns when GSI rangeKey references unknown field on core model", () => {
    const config = makeConfig({
      indexes: {
        user: {
          email: {
            indexName: "email-index",
            hashKey: "email",
            rangeKey: "nonExistentRangeKey",
          },
        },
      },
    });
    const warnings = validateConfig(config);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("nonExistentRangeKey");
    expect(warnings[0]).toContain("rangeKey");
  });

  it("does not warn when GSI keys reference known fields on user model", () => {
    const config = makeConfig({
      indexes: {
        user: {
          email: {
            indexName: "email-index",
            hashKey: "email",
          },
        },
        session: {
          userId: {
            indexName: "userId-index",
            hashKey: "userId",
          },
        },
      },
    });
    const warnings = validateConfig(config);
    expect(warnings).toEqual([]);
  });

  it("does not warn when GSI keys reference known fields with valid rangeKey", () => {
    const config = makeConfig({
      indexes: {
        user: {
          email: {
            indexName: "email-index",
            hashKey: "email",
            rangeKey: "createdAt",
          },
        },
      },
    });
    const warnings = validateConfig(config);
    expect(warnings).toEqual([]);
  });

  it("does not warn for GSI on plugin model (dynamic fields)", () => {
    const config = makeConfig({
      tables: {
        ...makeConfig().tables,
        organization: "Organizations",
      },
      indexes: {
        organization: {
          tenantId: {
            indexName: "tenant-index",
            hashKey: "tenantId",
            rangeKey: "memberSince",
          },
        },
      },
    });
    const warnings = validateConfig(config);
    // Plugin models skip field validation — no warnings
    expect(warnings).toEqual([]);
  });

  it("warns for both hashKey and rangeKey when both are unknown", () => {
    const config = makeConfig({
      indexes: {
        user: {
          badField: {
            indexName: "bad-index",
            hashKey: "badHash",
            rangeKey: "badRange",
          },
        },
      },
    });
    const warnings = validateConfig(config);
    // Two warnings: one for hashKey, one for rangeKey
    // The GSI is keyed by "badField" but its hashKey is "badHash" and rangeKey is "badRange"
    expect(warnings).toHaveLength(2);
  });

  it("handles multiple models with GSIs", () => {
    const config = makeConfig({
      indexes: {
        user: {
          email: { indexName: "email-idx", hashKey: "email" }, // valid
          bad: { indexName: "bad-idx", hashKey: "unknownField" }, // invalid
        },
        session: {
          token: { indexName: "token-idx", hashKey: "token" }, // valid
        },
      },
    });
    const warnings = validateConfig(config);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("unknownField");
  });

  it("does not throw for config with extra plugin tables", () => {
    const config = makeConfig({
      tables: {
        ...makeConfig().tables,
        organization: "Organizations",
        team: "Teams",
      },
    });
    expect(() => validateConfig(config)).not.toThrow();
    const warnings = validateConfig(config);
    expect(warnings).toEqual([]);
  });
});
