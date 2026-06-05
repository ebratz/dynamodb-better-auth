/**
 * Unit tests for resolveItemByPlan and matchesClientFilters —
 * shared single-item resolution helpers.
 */

import { describe, it, expect, vi } from "vitest";
import { resolveItemByPlan, matchesClientFilters } from "../src/helpers/resolve-item";
import type { DynamoDBAdapterConfig } from "../src/types";

// Mock the SDK
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  QueryCommand: vi.fn().mockImplementation((input: any) => ({
    ...input,
    _type: "QueryCommand",
  })),
  ScanCommand: vi.fn().mockImplementation((input: any) => ({
    ...input,
    _type: "ScanCommand",
  })),
  GetCommand: vi.fn().mockImplementation((input: any) => ({
    ...input,
    _type: "GetCommand",
  })),
}));

// Mock shouldLog to suppress console spam in tests
vi.mock("../src/helpers/debug-log", () => ({
  shouldLog: () => false,
}));

function makeConfig(
  overrides: Partial<DynamoDBAdapterConfig> = {},
): DynamoDBAdapterConfig {
  return {
    client: {} as any,
    tables: {
      user: "test-users",
      session: "test-sessions",
      account: "test-accounts",
      verification: "test-verifications",
    },
    ...overrides,
  } as any;
}

describe("resolveItemByPlan", () => {
  // ── Tier 2: GSI Query ────────────────────────────────────

  it("Tier 2 Query: finds item, returns it", async () => {
    const item = { id: "u1", email: "a@b.com", name: "Alice" };
    const calls: any[] = [];
    const docClient = {
      send: vi.fn().mockImplementation(async (cmd: any) => {
        calls.push(cmd);
        return { Items: [item] };
      }),
    };
    const config = makeConfig();

    const plan = {
      tier: 2 as const,
      operation: "query" as const,
      indexName: "email-index",
      keyCondition: "#n0 = :v0",
      expressionAttributeNames: { "#n0": "email" },
      expressionAttributeValues: { ":v0": "a@b.com" },
    };

    const result = await resolveItemByPlan(
      docClient as any,
      "test-users",
      plan as any,
      config,
      "user",
    );

    expect(result).toEqual(item);
    expect(calls).toHaveLength(1);
    expect(calls[0].IndexName).toBe("email-index");
    expect(calls[0].Limit).toBe(1);
  });

  it("Tier 2 Query: no match returns null", async () => {
    const docClient = {
      send: vi.fn().mockImplementation(async () => ({ Items: [] })),
    };
    const config = makeConfig();

    const plan = {
      tier: 2 as const,
      operation: "query" as const,
      indexName: "email-index",
      keyCondition: "#n0 = :v0",
      expressionAttributeNames: { "#n0": "email" },
      expressionAttributeValues: { ":v0": "nonexistent" },
    };

    const result = await resolveItemByPlan(
      docClient as any,
      "test-users",
      plan as any,
      config,
      "user",
    );

    expect(result).toBeNull();
  });

  it("Tier 2 KEYS_ONLY: triggers follow-up GetCommand with correct Key", async () => {
    const gsiItem = { providerId: "google", accountId: "g1" };
    const fullItem = { providerId: "google", accountId: "g1", id: "acc1", userId: "u1" };

    const calls: any[] = [];
    const docClient = {
      send: vi.fn().mockImplementation(async (cmd: any) => {
        calls.push(cmd);
        if (cmd._type === "QueryCommand") {
          return { Items: [gsiItem] };
        }
        if (cmd._type === "GetCommand") {
          return { Item: fullItem };
        }
        return {};
      }),
    };
    const config = makeConfig();

    const plan = {
      tier: 2 as const,
      operation: "query" as const,
      indexName: "by-id",
      keyCondition: "#n0 = :v0",
      expressionAttributeNames: { "#n0": "id" },
      expressionAttributeValues: { ":v0": "acc1" },
      needsFollowUpGetItem: true,
      followUpKeyFields: { pkField: "providerId", skField: "accountId" },
    };

    const result = await resolveItemByPlan(
      docClient as any,
      "test-accounts",
      plan as any,
      config,
      "account",
    );

    expect(result).toEqual(fullItem);
    expect(calls).toHaveLength(2);
    // First call: QueryCommand
    expect(calls[0]._type).toBe("QueryCommand");
    // Second call: GetCommand with the composite key
    expect(calls[1]._type).toBe("GetCommand");
    expect(calls[1].Key).toEqual({ providerId: "google", accountId: "g1" });
  });

  it("Tier 2 KEYS_ONLY: returns null when Query returns no items", async () => {
    const docClient = {
      send: vi.fn().mockImplementation(async () => ({ Items: [] })),
    };
    const config = makeConfig();

    const plan = {
      tier: 2 as const,
      operation: "query" as const,
      indexName: "by-id",
      keyCondition: "#n0 = :v0",
      expressionAttributeNames: { "#n0": "id" },
      expressionAttributeValues: { ":v0": "missing" },
      needsFollowUpGetItem: true,
      followUpKeyFields: { pkField: "providerId", skField: "accountId" },
    };

    const result = await resolveItemByPlan(
      docClient as any,
      "test-accounts",
      plan as any,
      config,
      "account",
    );

    expect(result).toBeNull();
    // Only 1 call — no follow-up GetCommand when Query returns nothing
    expect(docClient.send).toHaveBeenCalledTimes(1);
  });

  it("Tier 2 KEYS_ONLY: GetCommand returns no item → null", async () => {
    const gsiItem = { providerId: "google", accountId: "g1" };

    const docClient = {
      send: vi.fn().mockImplementation(async (cmd: any) => {
        if (cmd._type === "QueryCommand") {
          return { Items: [gsiItem] };
        }
        if (cmd._type === "GetCommand") {
          return {}; // no Item
        }
        return {};
      }),
    };
    const config = makeConfig();

    const plan = {
      tier: 2 as const,
      operation: "query" as const,
      indexName: "by-id",
      keyCondition: "#n0 = :v0",
      expressionAttributeNames: { "#n0": "id" },
      expressionAttributeValues: { ":v0": "acc1" },
      needsFollowUpGetItem: true,
      followUpKeyFields: { pkField: "providerId", skField: "accountId" },
    };

    const result = await resolveItemByPlan(
      docClient as any,
      "test-accounts",
      plan as any,
      config,
      "account",
    );

    expect(result).toBeNull();
  });

  // ── Tier 3: Scan ─────────────────────────────────────────

  it("Tier 3 Scan: finds item, returns it", async () => {
    const item = { id: "u1", name: "Alice" };
    const calls: any[] = [];
    const docClient = {
      send: vi.fn().mockImplementation(async (cmd: any) => {
        calls.push(cmd);
        return { Items: [item] };
      }),
    };
    const config = makeConfig();

    const plan = {
      tier: 3 as const,
      operation: "scan" as const,
      filterExpression: "#n0 = :v0",
      expressionAttributeNames: { "#n0": "name" },
      expressionAttributeValues: { ":v0": "Alice" },
    };

    const result = await resolveItemByPlan(
      docClient as any,
      "test-users",
      plan as any,
      config,
      "user",
    );

    expect(result).toEqual(item);
    expect(calls).toHaveLength(1);
    expect(calls[0].FilterExpression).toBe("#n0 = :v0");
    expect(calls[0].Limit).toBe(1);
  });

  it("Tier 3 Scan: no match returns null", async () => {
    const docClient = {
      send: vi.fn().mockImplementation(async () => ({ Items: [] })),
    };
    const config = makeConfig();

    const plan = {
      tier: 3 as const,
      operation: "scan" as const,
      filterExpression: "#n0 = :v0",
      expressionAttributeNames: { "#n0": "name" },
      expressionAttributeValues: { ":v0": "Nobody" },
    };

    const result = await resolveItemByPlan(
      docClient as any,
      "test-users",
      plan as any,
      config,
      "user",
    );

    expect(result).toBeNull();
  });

  it("Tier 3 Scan: Items is undefined → returns null", async () => {
    const docClient = {
      send: vi.fn().mockImplementation(async () => ({})),
    };
    const config = makeConfig();

    const plan = {
      tier: 3 as const,
      operation: "scan" as const,
      filterExpression: "#n0 = :v0",
      expressionAttributeNames: { "#n0": "name" },
      expressionAttributeValues: { ":v0": "Nobody" },
    };

    const result = await resolveItemByPlan(
      docClient as any,
      "test-users",
      plan as any,
      config,
      "user",
    );

    expect(result).toBeNull();
  });

  it("Tier 3 Scan without filterExpression: handles it gracefully", async () => {
    const docClient = {
      send: vi.fn().mockImplementation(async () => ({ Items: [{ id: "u1" }] })),
    };
    const config = makeConfig();

    const plan = {
      tier: 3 as const,
      operation: "scan" as const,
      expressionAttributeNames: {},
      expressionAttributeValues: {},
    };

    const result = await resolveItemByPlan(
      docClient as any,
      "test-users",
      plan as any,
      config,
      "user",
    );

    expect(result).toEqual({ id: "u1" });
  });
});

describe("matchesClientFilters", () => {
  const item = {
    id: "u1",
    name: "Alice",
    age: 30,
    role: "admin",
    email: "alice@example.com",
    tags: ["dev", "admin"],
  };

  // ── All 10 operators ─────────────────────────────────────

  it("eq: matches when equal", () => {
    expect(matchesClientFilters(item, [{ field: "name", operator: "eq", value: "Alice" }])).toBe(true);
    expect(matchesClientFilters(item, [{ field: "name", operator: "eq", value: "Bob" }])).toBe(false);
  });

  it("ne: matches when not equal", () => {
    expect(matchesClientFilters(item, [{ field: "name", operator: "ne", value: "Bob" }])).toBe(true);
    expect(matchesClientFilters(item, [{ field: "name", operator: "ne", value: "Alice" }])).toBe(false);
  });

  it("gt: matches when greater than", () => {
    expect(matchesClientFilters(item, [{ field: "age", operator: "gt", value: 18 }])).toBe(true);
    expect(matchesClientFilters(item, [{ field: "age", operator: "gt", value: 30 }])).toBe(false);
  });

  it("gte: matches when greater or equal", () => {
    expect(matchesClientFilters(item, [{ field: "age", operator: "gte", value: 30 }])).toBe(true);
    expect(matchesClientFilters(item, [{ field: "age", operator: "gte", value: 31 }])).toBe(false);
  });

  it("lt: matches when less than", () => {
    expect(matchesClientFilters(item, [{ field: "age", operator: "lt", value: 65 }])).toBe(true);
    expect(matchesClientFilters(item, [{ field: "age", operator: "lt", value: 30 }])).toBe(false);
  });

  it("lte: matches when less or equal", () => {
    expect(matchesClientFilters(item, [{ field: "age", operator: "lte", value: 30 }])).toBe(true);
    expect(matchesClientFilters(item, [{ field: "age", operator: "lte", value: 29 }])).toBe(false);
  });

  it("in: matches when value is in the array", () => {
    expect(matchesClientFilters(item, [{ field: "role", operator: "in", value: ["admin", "mod"] }])).toBe(true);
    expect(matchesClientFilters(item, [{ field: "role", operator: "in", value: ["user", "guest"] }])).toBe(false);
  });

  it("in: works with single non-array value", () => {
    expect(matchesClientFilters(item, [{ field: "role", operator: "in", value: "admin" }])).toBe(true);
    expect(matchesClientFilters(item, [{ field: "role", operator: "in", value: "user" }])).toBe(false);
  });

  it("not_in: matches when value is NOT in the array", () => {
    expect(matchesClientFilters(item, [{ field: "role", operator: "not_in", value: ["user", "guest"] }])).toBe(true);
    expect(matchesClientFilters(item, [{ field: "role", operator: "not_in", value: ["admin", "mod"] }])).toBe(false);
  });

  it("contains: matches when string contains substring", () => {
    expect(matchesClientFilters(item, [{ field: "email", operator: "contains", value: "example" }])).toBe(true);
    expect(matchesClientFilters(item, [{ field: "email", operator: "contains", value: "gmail" }])).toBe(false);
  });

  it("contains: returns false for non-string field", () => {
    expect(matchesClientFilters(item, [{ field: "age", operator: "contains", value: "3" }])).toBe(false);
  });

  it("starts_with: matches when string starts with prefix", () => {
    expect(matchesClientFilters(item, [{ field: "email", operator: "starts_with", value: "alice" }])).toBe(true);
    expect(matchesClientFilters(item, [{ field: "email", operator: "starts_with", value: "bob" }])).toBe(false);
  });

  it("starts_with: returns false for non-string field", () => {
    expect(matchesClientFilters(item, [{ field: "age", operator: "starts_with", value: "3" }])).toBe(false);
  });

  // ── Edge cases ───────────────────────────────────────────

  it("empty filters array returns true", () => {
    expect(matchesClientFilters(item, [])).toBe(true);
  });

  it("multiple filters: all must match for true", () => {
    expect(matchesClientFilters(item, [
      { field: "name", operator: "eq", value: "Alice" },
      { field: "age", operator: "gt", value: 18 },
      { field: "role", operator: "in", value: ["admin"] },
    ])).toBe(true);
  });

  it("multiple filters: fails on first mismatch", () => {
    expect(matchesClientFilters(item, [
      { field: "name", operator: "eq", value: "Alice" },
      { field: "age", operator: "gt", value: 50 },  // fails
      { field: "role", operator: "eq", value: "admin" },
    ])).toBe(false);
  });

  it("unknown operator returns false", () => {
    expect(matchesClientFilters(item, [
      { field: "name", operator: "regex" as any, value: ".*" },
    ])).toBe(false);
  });

  it("field not present on item: returns false for eq operator", () => {
    expect(matchesClientFilters(item, [
      { field: "nonexistent", operator: "eq", value: "something" },
    ])).toBe(false);
  });
});
