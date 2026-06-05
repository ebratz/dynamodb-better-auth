import { describe, it, expect } from "vitest";
import { resolveQueryPlan } from "../src/helpers/query-planner";
import type { DynamoDBAdapterConfig } from "../src/types";

const baseConfig: DynamoDBAdapterConfig = {
  client: {} as any,
  tables: {
    user: "Users",
    session: "Sessions",
    account: "Accounts",
    verification: "Verifications",
    emailLookups: "EmailLookups",
  },
  indexes: {
    user: {
      email: { indexName: "email-index", hashKey: "email" },
    },
    session: {
      userId: { indexName: "userId-index", hashKey: "userId" },
    },
    account: {
      userId: { indexName: "by-userId", hashKey: "userId" },
      id: { indexName: "by-id", hashKey: "id", projection: "KEYS_ONLY" },
    },
    verification: {
      identifier: { indexName: "identifier-index", hashKey: "identifier" },
    },
  },
};

describe("resolveQueryPlan", () => {
  // ── Tier 1 — simple PK ───────────────────────────────────────
  it("Tier 1: user by id", () => {
    const plan = resolveQueryPlan(
      [{ field: "id", operator: "eq", value: "u1" }],
      "user",
      baseConfig,
    );
    expect(plan.tier).toBe(1);
    expect(plan.operation).toBe("getItem");
    expect(plan.tableName).toBe("Users");
    expect(plan.key).toEqual({ id: "u1" });
    expect(plan.needsClientSideFilter).toBeFalsy();
  });

  it("Tier 1: session by token", () => {
    const plan = resolveQueryPlan(
      [{ field: "token", operator: "eq", value: "sess-abc" }],
      "session",
      baseConfig,
    );
    expect(plan.tier).toBe(1);
    expect(plan.operation).toBe("getItem");
    expect(plan.key).toEqual({ token: "sess-abc" });
  });

  it("Tier 1: verification by id", () => {
    const plan = resolveQueryPlan(
      [{ field: "id", operator: "eq", value: "vfy-1" }],
      "verification",
      baseConfig,
    );
    expect(plan.tier).toBe(1);
    expect(plan.key).toEqual({ id: "vfy-1" });
  });

  it("Tier 1: emailLookups by email", () => {
    const plan = resolveQueryPlan(
      [{ field: "email", operator: "eq", value: "x@y.com" }],
      "emailLookups",
      baseConfig,
    );
    expect(plan.tier).toBe(1);
    expect(plan.key).toEqual({ email: "x@y.com" });
  });

  // ── Tier 1 — composite PK (account) ──────────────────────────
  it("Tier 1: account by (providerId, accountId)", () => {
    const plan = resolveQueryPlan(
      [
        { field: "providerId", operator: "eq", value: "google" },
        { field: "accountId", operator: "eq", value: "12345" },
      ],
      "account",
      baseConfig,
    );
    expect(plan.tier).toBe(1);
    expect(plan.operation).toBe("getItem");
    expect(plan.key).toEqual({ providerId: "google", accountId: "12345" });
  });

  it("Tier 1: account with only PK (no SK) — still GetItem", () => {
    const plan = resolveQueryPlan(
      [{ field: "providerId", operator: "eq", value: "google" }],
      "account",
      baseConfig,
    );
    expect(plan.tier).toBe(1);
    expect(plan.key).toEqual({ providerId: "google" });
    expect(plan.key).not.toHaveProperty("accountId");
  });

  // ── Tier 1 + extra conditions → client-side filter ───────────
  it("Tier 1 with extra clause triggers client-side filter", () => {
    const plan = resolveQueryPlan(
      [
        { field: "id", operator: "eq", value: "u1" },
        { field: "emailVerified", operator: "eq", value: true },
      ],
      "user",
      baseConfig,
    );
    expect(plan.tier).toBe(1);
    expect(plan.key).toEqual({ id: "u1" });
    expect(plan.needsClientSideFilter).toBe(true);
    expect(plan.clientSideFilters).toHaveLength(1);
    expect(plan.clientSideFilters![0]).toEqual({
      field: "emailVerified",
      operator: "eq",
      value: true,
    });
  });

  // ── Tier 2 — GSI hash key ────────────────────────────────────
  it("Tier 2: user by email (GSI)", () => {
    const plan = resolveQueryPlan(
      [{ field: "email", operator: "eq", value: "x@y.com" }],
      "user",
      baseConfig,
    );
    expect(plan.tier).toBe(2);
    expect(plan.operation).toBe("query");
    expect(plan.indexName).toBe("email-index");
    expect(plan.keyCondition).toBe("#n0 = :v0");
    expect(plan.expressionAttributeNames).toEqual({ "#n0": "email" });
    expect(plan.expressionAttributeValues).toEqual({ ":v0": "x@y.com" });
  });

  it("Tier 2: session by userId (GSI)", () => {
    const plan = resolveQueryPlan(
      [{ field: "userId", operator: "eq", value: "u1" }],
      "session",
      baseConfig,
    );
    expect(plan.tier).toBe(2);
    expect(plan.indexName).toBe("userId-index");
  });

  it("Tier 2: account by userId (GSI)", () => {
    const plan = resolveQueryPlan(
      [{ field: "userId", operator: "eq", value: "u1" }],
      "account",
      baseConfig,
    );
    expect(plan.tier).toBe(2);
    expect(plan.indexName).toBe("by-userId");
  });

  it("Tier 2: verification by identifier (GSI)", () => {
    const plan = resolveQueryPlan(
      [{ field: "identifier", operator: "eq", value: "token-123" }],
      "verification",
      baseConfig,
    );
    expect(plan.tier).toBe(2);
    expect(plan.indexName).toBe("identifier-index");
  });

  // ── Tier 2 — GSI with extra filter clauses ───────────────────
  it("Tier 2: GSI match + extra clause → FilterExpression", () => {
    const plan = resolveQueryPlan(
      [
        { field: "email", operator: "eq", value: "x@y.com" },
        { field: "emailVerified", operator: "eq", value: true },
      ],
      "user",
      baseConfig,
    );
    expect(plan.tier).toBe(2);
    expect(plan.indexName).toBe("email-index");
    expect(plan.keyCondition).toContain("#n0 = :v0");
    // Filter expression should be present.
    expect(plan.filterExpression).toBeTruthy();
    // Both field names should be in expressionAttributeNames.
    const fieldNames = Object.values(plan.expressionAttributeNames);
    expect(fieldNames).toContain("email");
    expect(fieldNames).toContain("emailVerified");
  });

  // ── Tier 2 — account by-id GSI (KEYS_ONLY) ───────────────────
  it("Tier 2: account by id GSI sets needsFollowUpGetItem", () => {
    const plan = resolveQueryPlan(
      [{ field: "id", operator: "eq", value: "acc-1" }],
      "account",
      baseConfig,
    );
    expect(plan.tier).toBe(2);
    expect(plan.indexName).toBe("by-id");
    expect(plan.needsFollowUpGetItem).toBe(true);
    expect(plan.followUpKeyFields).toEqual({
      pkField: "providerId",
      skField: "accountId",
    });
  });

  // ── Tier 3 — no index match ──────────────────────────────────
  it("Tier 3: user by name (no GSI)", () => {
    const plan = resolveQueryPlan(
      [{ field: "name", operator: "eq", value: "John" }],
      "user",
      baseConfig,
    );
    expect(plan.tier).toBe(3);
    expect(plan.operation).toBe("scan");
    expect(plan.filterExpression).toBe("#n0 = :v0");
  });

  it("Tier 3: user by non-eq PK operator", () => {
    // PK field with ne operator — can't use GetItem or Query on PK
    const plan = resolveQueryPlan(
      [{ field: "id", operator: "ne", value: "u1" }],
      "user",
      baseConfig,
    );
    expect(plan.tier).toBe(3);
    expect(plan.operation).toBe("scan");
  });

  it("Tier 3: scan with multiple conditions", () => {
    const plan = resolveQueryPlan(
      [
        { field: "status", operator: "eq", value: "active" },
        { field: "role", operator: "in", value: ["admin", "mod"] },
      ],
      "user",
      baseConfig,
    );
    expect(plan.tier).toBe(3);
    expect(plan.operation).toBe("scan");
    expect(plan.filterExpression).toContain("#n0 = :v0");
    expect(plan.filterExpression).toContain("IN");
  });

  // ── Plugin model ─────────────────────────────────────────────
  it("Tier 1: plugin model with pk=id defaults to GetItem", () => {
    const configWithPlugin = {
      ...baseConfig,
      tables: { ...baseConfig.tables, organization: "Organizations" },
    };
    const plan = resolveQueryPlan(
      [{ field: "id", operator: "eq", value: "org-1" }],
      "organization",
      configWithPlugin,
    );
    expect(plan.tier).toBe(1);
    expect(plan.key).toEqual({ id: "org-1" });
  });

  it("Tier 3: plugin model without indexes on non-id field", () => {
    const configWithPlugin = {
      ...baseConfig,
      tables: { ...baseConfig.tables, organization: "Organizations" },
    };
    const plan = resolveQueryPlan(
      [{ field: "name", operator: "eq", value: "Acme" }],
      "organization",
      configWithPlugin,
    );
    expect(plan.tier).toBe(3);
  });

  // ── Empty where ──────────────────────────────────────────────
  it("Tier 3: empty where clause → scan with no filter", () => {
    const plan = resolveQueryPlan([], "user", baseConfig);
    expect(plan.tier).toBe(3);
    expect(plan.operation).toBe("scan");
    expect(plan.filterExpression).toBeUndefined();
  });

  // ── Tier 2 with sort key operations ──────────────────────────
  it("Tier 2: sort key comparisons go in KeyConditionExpression", () => {
    // account has by-userId GSI with hashKey: "userId"
    // No sort key on by-userId, so extra clauses become filter.
    const plan = resolveQueryPlan(
      [
        { field: "userId", operator: "eq", value: "u1" },
        { field: "createdAt", operator: "gt", value: "2024-01-01" },
      ],
      "account",
      baseConfig,
    );
    expect(plan.tier).toBe(2);
    expect(plan.indexName).toBe("by-userId");
    // createdAt is NOT the sort key — it goes to filter
    expect(plan.filterExpression).toBeTruthy();
  });

  it("Tier 2: starts_with on GSI sort key goes in KeyConditionExpression", () => {
    const configWithSortKey = {
      ...baseConfig,
      indexes: {
        ...baseConfig.indexes,
        user: {
          ...baseConfig.indexes!.user,
          email: {
            indexName: "email-index",
            hashKey: "email",
            rangeKey: "createdAt",
          },
        },
      },
    };
    const plan = resolveQueryPlan(
      [
        { field: "email", operator: "eq", value: "x@y.com" },
        { field: "createdAt", operator: "starts_with", value: "2024-" },
      ],
      "user",
      configWithSortKey,
    );
    expect(plan.tier).toBe(2);
    expect(plan.indexName).toBe("email-index");
    // starts_with on sort key → KeyConditionExpression, not FilterExpression
    expect(plan.keyCondition).toContain("begins_with");
    expect(plan.filterExpression).toBeUndefined();
  });

  it("Tier 2: unsupported operator on GSI sort key → FilterExpression", () => {
    const configWithSortKey = {
      ...baseConfig,
      indexes: {
        ...baseConfig.indexes,
        user: {
          ...baseConfig.indexes!.user,
          email: {
            indexName: "email-index",
            hashKey: "email",
            rangeKey: "createdAt",
          },
        },
      },
    };
    const plan = resolveQueryPlan(
      [
        { field: "email", operator: "eq", value: "x@y.com" },
        { field: "createdAt", operator: "contains", value: "2024" },
      ],
      "user",
      configWithSortKey,
    );
    expect(plan.tier).toBe(2);
    // contains is not a sort-key operator → goes to FilterExpression
    expect(plan.filterExpression).toBeTruthy();
  });

  it("Tier 2: key/filter placeholder collision is remapped correctly", () => {
    // When keyConditionClauses and filterClauses are converted separately,
    // convertWhereClause assigns #n0, #n1, ... independently for each call.
    // This causes collisions when merged — the same #nX refers to different
    // fields in kcNames vs filterNames.
    //
    // Scenario:
    //   GSI: hashKey=email, rangeKey=createdAt
    //   Key condition (2 fields): email=eq, createdAt=gt → #n0=email, #n1=createdAt
    //   Filter (1 field): role=admin → #n0=role (fresh start)
    //
    // Without remapping, the filter's #n0 would map to "email" in the merged
    // names map, silently breaking the filter expression. The collision code
    // (query-planner.ts L209-218) detects this and remaps to #n2.
    const configWithSortKey = {
      ...baseConfig,
      indexes: {
        ...baseConfig.indexes,
        user: {
          ...baseConfig.indexes!.user,
          email: {
            indexName: "email-index",
            hashKey: "email",
            rangeKey: "createdAt",
          },
        },
      },
    };
    const plan = resolveQueryPlan(
      [
        { field: "email", operator: "eq", value: "x@y.com" },
        { field: "createdAt", operator: "gt", value: "2024-01-01" },
        { field: "role", operator: "eq", value: "admin" },
      ],
      "user",
      configWithSortKey,
    );
    expect(plan.tier).toBe(2);
    expect(plan.indexName).toBe("email-index");
    // Key condition should reference email and createdAt
    expect(plan.keyCondition).toContain("#n0 = :v0");
    expect(plan.keyCondition).toContain("#n1");
    // Filter expression should use a distinct, non-colliding placeholder.
    // With remapping, filter gets #n2 (offset = 2 from kcNames).
    // The value reference stays :v0 (filter starts its own value namespace)
    expect(plan.filterExpression).toContain("#n2 = :v0");
    // Verify the merged names map has all 3 fields with distinct keys
    const names = plan.expressionAttributeNames;
    expect(names["#n0"]).toBe("email");
    expect(names["#n1"]).toBe("createdAt");
    expect(names["#n2"]).toBe("role");
    expect(Object.keys(names)).toHaveLength(3);
  });
});
