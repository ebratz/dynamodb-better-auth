import { describe, it, expect, vi, beforeEach } from "vitest";
import { deleteMethod } from "../src/adapter/methods/delete";
import type { DynamoDBAdapterConfig } from "../src/types";

// Mock the AWS SDK
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DeleteCommand: vi.fn().mockImplementation((input: any) => ({ ...input, _type: "DeleteCommand" })),
  GetCommand: vi.fn().mockImplementation((input: any) => ({ ...input, _type: "GetCommand" })),
  QueryCommand: vi.fn().mockImplementation((input: any) => ({ ...input, _type: "QueryCommand" })),
  ScanCommand: vi.fn().mockImplementation((input: any) => ({ ...input, _type: "ScanCommand" })),
}));

function makeDocClient(sendImpl: (cmd: any) => Promise<any>) {
  return { send: sendImpl } as any;
}

function makeConfig(overrides: Partial<DynamoDBAdapterConfig> = {}): DynamoDBAdapterConfig {
  return {
    client: {} as any,
    tables: {
      user: "test-users",
      session: "test-sessions",
      account: "test-accounts",
      verification: "test-verifications",
    },
    indexes: {
      user: { email: { indexName: "email-index", hashKey: "email" } },
      session: { userId: { indexName: "userId-index", hashKey: "userId" } },
      account: {
        id: { indexName: "by-id", hashKey: "id", projection: "KEYS_ONLY" },
      },
    },
    ...overrides,
  } as any;
}

describe("delete", () => {
  // ── Tier 1: PK delete ──────────────────────────────────────
  it("Tier 1: uses DeleteCommand with resolved PK", async () => {
    const calls: any[] = [];
    const docClient = makeDocClient(async (cmd: any) => {
      calls.push(cmd);
      return {};
    });

    const config = makeConfig();
    const del = deleteMethod(docClient, config);

    await del({
      model: "user",
      where: [{ field: "id", operator: "eq", value: "u1" }],
    });

    expect(calls.length).toBe(1);
    expect(calls[0]._type).toBe("DeleteCommand");
    expect(calls[0].TableName).toBe("test-users");
    expect(calls[0].Key).toEqual({ id: "u1" });
  });

  it("Tier 1: uses DeleteCommand with composite key (account)", async () => {
    const calls: any[] = [];
    const docClient = makeDocClient(async (cmd: any) => {
      calls.push(cmd);
      return {};
    });

    const config = makeConfig();
    const del = deleteMethod(docClient, config);

    await del({
      model: "account",
      where: [
        { field: "providerId", operator: "eq", value: "google" },
        { field: "accountId", operator: "eq", value: "12345" },
      ],
    });

    expect(calls.length).toBe(1);
    expect(calls[0]._type).toBe("DeleteCommand");
    expect(calls[0].Key).toEqual({ providerId: "google", accountId: "12345" });
  });

  // ── Tier 2: GSI Query → Delete ─────────────────────────────
  it("Tier 2: queries GSI then deletes by resolved key", async () => {
    const calls: any[] = [];
    const docClient = makeDocClient(async (cmd: any) => {
      calls.push(cmd);
      if (cmd._type === "QueryCommand") {
        return { Items: [{ id: "u1", email: "a@b.com" }] };
      }
      return {};
    });

    const config = makeConfig();
    const del = deleteMethod(docClient, config);

    await del({
      model: "user",
      where: [{ field: "email", operator: "eq", value: "a@b.com" }],
    });

    expect(calls.length).toBe(2);
    // First: Query GSI
    expect(calls[0]._type).toBe("QueryCommand");
    expect(calls[0].IndexName).toBe("email-index");
    expect(calls[0].Limit).toBe(1);
    // Second: DeleteItem
    expect(calls[1]._type).toBe("DeleteCommand");
    expect(calls[1].Key).toEqual({ id: "u1" });
  });

  it("Tier 2: silently does nothing when no item matches", async () => {
    const calls: any[] = [];
    const docClient = makeDocClient(async (cmd: any) => {
      calls.push(cmd);
      return { Items: [] };
    });

    const config = makeConfig();
    const del = deleteMethod(docClient, config);

    await del({
      model: "user",
      where: [{ field: "email", operator: "eq", value: "noone@here.com" }],
    });

    // Only the Query call, no DeleteItem
    expect(calls.length).toBe(1);
    expect(calls[0]._type).toBe("QueryCommand");
  });

  // ── Tier 3: Scan → Delete ──────────────────────────────────
  it("Tier 3: scans then deletes by resolved key", async () => {
    const calls: any[] = [];
    const docClient = makeDocClient(async (cmd: any) => {
      calls.push(cmd);
      if (cmd._type === "ScanCommand") {
        return { Items: [{ id: "u1", name: "Alice" }] };
      }
      return {};
    });

    const config = makeConfig();
    const del = deleteMethod(docClient, config);

    await del({
      model: "user",
      where: [{ field: "name", operator: "eq", value: "Alice" }],
    });

    expect(calls.length).toBe(2);
    // First: Scan
    expect(calls[0]._type).toBe("ScanCommand");
    expect(calls[0].FilterExpression).toBeDefined();
    expect(calls[0].Limit).toBe(1);
    // Second: DeleteItem
    expect(calls[1]._type).toBe("DeleteCommand");
    expect(calls[1].Key).toEqual({ id: "u1" });
  });

  it("Tier 3: silently does nothing when no item matches", async () => {
    const docClient = makeDocClient(async (_cmd: any) => ({
      Items: [],
    }));

    const config = makeConfig();
    const del = deleteMethod(docClient, config);

    // Should not throw
    await expect(
      del({
        model: "user",
        where: [{ field: "name", operator: "eq", value: "Nobody" }],
      }),
    ).resolves.toBeUndefined();
  });

  // ── Tier 3 filter-builder: per-operator branches ───────────
  // Exercises every branch in delete.ts internal buildSimpleFilter
  // (gt, gte, lt, lte, ne, in, starts_with, contains, mixed AND/OR).
  const tier3Cases: Array<{ name: string; op: string; value: any; expected: RegExp }> = [
    { name: "gt",          op: "gt",          value: 5,           expected: /#n0 > :v0/ },
    { name: "gte",         op: "gte",         value: 5,           expected: /#n0 >= :v0/ },
    { name: "lt",          op: "lt",          value: 5,           expected: /#n0 < :v0/ },
    { name: "lte",         op: "lte",         value: 5,           expected: /#n0 <= :v0/ },
    { name: "ne",          op: "ne",          value: "x",         expected: /#n0 <> :v0/ },
    { name: "starts_with", op: "starts_with", value: "pre",       expected: /begins_with\(#n0, :v0\)/ },
    { name: "contains",    op: "contains",    value: "sub",       expected: /contains\(#n0, :v0\)/ },
  ];

  for (const { name, op, value, expected } of tier3Cases) {
    it(`Tier 3 buildSimpleFilter: ${name} produces expected expression`, async () => {
      const calls: any[] = [];
      const docClient = makeDocClient(async (cmd: any) => {
        calls.push(cmd);
        if (cmd._type === "ScanCommand") {
          return { Items: [{ id: "u1", name: "X" }] };
        }
        return {};
      });

      const config = makeConfig();
      const del = deleteMethod(docClient, config);

      await del({
        model: "user",
        where: [{ field: "name", operator: op as any, value }],
      });

      const scan = calls.find((c) => c._type === "ScanCommand");
      expect(scan).toBeDefined();
      expect(scan.FilterExpression).toMatch(expected);
    });
  }

  it("Tier 3 buildSimpleFilter: in operator expands to IN (:v0, :v1, ...)", async () => {
    const calls: any[] = [];
    const docClient = makeDocClient(async (cmd: any) => {
      calls.push(cmd);
      if (cmd._type === "ScanCommand") return { Items: [{ id: "u1" }] };
      return {};
    });

    const config = makeConfig();
    const del = deleteMethod(docClient, config);

    await del({
      model: "user",
      where: [{ field: "role", operator: "in" as any, value: ["a", "b", "c"] }],
    });

    const scan = calls.find((c) => c._type === "ScanCommand");
    expect(scan.FilterExpression).toMatch(/#n0 IN \(:v0, :v1, :v2\)/);
  });

  it("Tier 3: mixed AND+OR connectors uses convertWhereClause expression format", async () => {
    const calls: any[] = [];
    const docClient = makeDocClient(async (cmd: any) => {
      calls.push(cmd);
      if (cmd._type === "ScanCommand") return { Items: [{ id: "u1" }] };
      return {};
    });

    const config = makeConfig();
    const del = deleteMethod(docClient, config);

    await del({
      model: "user",
      where: [
        { field: "status", operator: "eq" as any, value: "active", connector: "AND" } as any,
        { field: "role", operator: "eq" as any, value: "admin", connector: "OR" } as any,
        { field: "name", operator: "eq" as any, value: "X", connector: "OR" } as any,
      ],
    });

    const scan = calls.find((c) => c._type === "ScanCommand");
    // convertWhereClause groups by OR separators: three single-element groups joined with OR
    expect(scan.FilterExpression).toMatch(/^#n\d+ = :v\d+ OR #n\d+ = :v\d+ OR #n\d+ = :v\d+$/);
  });

  it("Tier 3 buildSimpleFilter: all-OR connectors join with OR", async () => {
    const calls: any[] = [];
    const docClient = makeDocClient(async (cmd: any) => {
      calls.push(cmd);
      if (cmd._type === "ScanCommand") return { Items: [{ id: "u1" }] };
      return {};
    });

    const config = makeConfig();
    const del = deleteMethod(docClient, config);

    await del({
      model: "user",
      where: [
        { field: "a", operator: "eq" as any, value: 1, connector: "OR" } as any,
        { field: "b", operator: "eq" as any, value: 2, connector: "OR" } as any,
      ],
    });

    const scan = calls.find((c) => c._type === "ScanCommand");
    expect(scan.FilterExpression).toMatch(/#n0 = :v0 OR #n1 = :v1/);
  });
});
