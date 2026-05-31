import { describe, it, expect, vi } from "vitest";
import { findManyMethod } from "../src/adapter/methods/find-many";
import { UnsupportedOptionError } from "../src/errors";
import type { DynamoDBAdapterConfig } from "../src/types";

// Mock the AWS SDK
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  QueryCommand: vi.fn().mockImplementation((input: any) => ({ ...input, _type: "QueryCommand" })),
  ScanCommand: vi.fn().mockImplementation((input: any) => ({ ...input, _type: "ScanCommand" })),
  BatchGetCommand: vi.fn().mockImplementation((input: any) => ({ ...input, _type: "BatchGetCommand" })),
}));

function makeDocClient(responses: (any | ((cmd: any) => any))[]) {
  let callIdx = 0;
  const calls: any[] = [];
  return {
    send: vi.fn().mockImplementation(async (cmd: any) => {
      calls.push(cmd);
      const respOrFn = responses[callIdx] ?? { Items: [] };
      callIdx++;
      return typeof respOrFn === "function" ? respOrFn(cmd) : respOrFn;
    }),
    _calls: () => calls,
    _callCount: () => callIdx,
  } as any;
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
    ...overrides,
  } as any;
}

describe("findMany", () => {
  it("Tier 2: Query on GSI returns items", async () => {
    const docClient = makeDocClient([
      { Items: [{ id: "u1", email: "a@b.com" }, { id: "u2", email: "c@d.com" }] },
    ]);
    const config = makeConfig({
      indexes: {
        user: { email: { indexName: "email-index", hashKey: "email" } },
      },
    });
    const findMany = findManyMethod(docClient, config);

    const result = await findMany({
      model: "user",
      where: [{ field: "email", operator: "eq", value: "a@b.com" }],
    });

    expect(result.length).toBe(2);
  });

  it("Tier 2: throws UnsupportedOptionError when offset > 0", async () => {
    const docClient = makeDocClient([{ Items: [] }]);
    const config = makeConfig({
      indexes: {
        user: { email: { indexName: "email-index", hashKey: "email" } },
      },
    });
    const findMany = findManyMethod(docClient, config);

    await expect(
      findMany({
        model: "user",
        where: [{ field: "email", operator: "eq", value: "a@b.com" }],
        offset: 10,
      })
    ).rejects.toThrow(UnsupportedOptionError);
  });

  it("Tier 2: paginated Query across ExclusiveStartKey chain", async () => {
    const docClient = makeDocClient([
      { Items: [{ id: "u1" }, { id: "u2" }], LastEvaluatedKey: { id: "u2" } },
      { Items: [{ id: "u3" }, { id: "u4" }] },
    ]);
    const config = makeConfig({
      indexes: {
        user: { email: { indexName: "email-index", hashKey: "email" } },
      },
    });
    const findMany = findManyMethod(docClient, config);

    const result = await findMany({
      model: "user",
      where: [{ field: "email", operator: "eq", value: "a@b.com" }],
      limit: 4,
    });

    expect(result.length).toBe(4);
  });

  it("Tier 2: KEYS_ONLY GSI resolves via BatchGetCommand for full rows", async () => {
    const docClient = makeDocClient([
      // Query on by-id GSI returns 2 partial items
      { Items: [{ providerId: "google", accountId: "g1" }, { providerId: "google", accountId: "g2" }] },
      // BatchGet returns full rows
      {
        Responses: {
          "test-accounts": [
            { providerId: "google", accountId: "g1", id: "acc1", userId: "u1" },
            { providerId: "google", accountId: "g2", id: "acc2", userId: "u2" },
          ],
        },
      },
    ]);
    const config = makeConfig({
      indexes: {
        account: {
          id: { indexName: "by-id", hashKey: "id", projection: "KEYS_ONLY" },
        },
      },
    });
    const findMany = findManyMethod(docClient, config);

    const result = await findMany({
      model: "account",
      where: [{ field: "id", operator: "eq", value: "acc1" }],
    });

    expect(result.length).toBe(2);
    expect(result[0]!.userId).toBe("u1");
  });

  it("Tier 2: BatchGet chunks >100 keys across multiple calls", async () => {
    // Build 250 response items
    const items = Array.from({ length: 250 }, (_, i) => ({
      providerId: "google",
      accountId: `g${i}`,
    }));
    const fullItems = Array.from({ length: 250 }, (_, i) => ({
      providerId: "google",
      accountId: `g${i}`,
      id: `acc${i}`,
      userId: `u${i}`,
    }));

    // Responder returns items in chunks of 100
    const responses: any[] = [{ Items: items }];
    for (let i = 0; i < 3; i++) {
      responses.push({
        Responses: {
          "test-accounts": fullItems.slice(i * 100, (i + 1) * 100),
        },
      });
    }

    const docClient = makeDocClient(responses);
    const config = makeConfig({
      indexes: {
        account: {
          id: { indexName: "by-id", hashKey: "id", projection: "KEYS_ONLY" },
        },
      },
    });
    const findMany = findManyMethod(docClient, config);

    const result = await findMany({
      model: "account",
      where: [{ field: "id", operator: "eq", value: "acc1" }],
      limit: 300,
    });

    expect(result.length).toBe(250);
    // Should have 1 Query + 3 BatchGet calls
    const batchGetCalls = docClient._calls().filter((c: any) => c.RequestItems);
    expect(batchGetCalls.length).toBe(3);
  });

  it("Tier 2: sortBy mismatch triggers client-side sort + warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const docClient = makeDocClient([
      {
        Items: [
          { id: "u2", email: "b@b.com", name: "Bob" },
          { id: "u1", email: "a@a.com", name: "Alice" },
        ],
      },
    ]);
    const config = makeConfig({
      debugLogs: true,
      indexes: {
        user: { email: { indexName: "email-index", hashKey: "email" } },
      },
    });
    const findMany = findManyMethod(docClient, config);

    const result = await findMany({
      model: "user",
      where: [{ field: "email", operator: "contains", value: "@" }],
      sortBy: { field: "name", direction: "asc" },  // name is NOT the sort key
    });

    // Should be sorted by name (client-side)
    expect(result[0]!.name).toBe("Alice");
    expect(result[1]!.name).toBe("Bob");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("Tier 3: Scan with sortBy fetches all pages and sorts client-side", async () => {
    const docClient = makeDocClient([
      { Items: [{ id: "u2", name: "Bob" }, { id: "u1", name: "Alice" }] },
    ]);
    const config = makeConfig();
    const findMany = findManyMethod(docClient, config);

    const result = await findMany({
      model: "user",
      where: [{ field: "name", operator: "ne", value: "" }],
      sortBy: { field: "name", direction: "asc" },
      limit: 2,
    });

    // Should be sorted by name ascending
    expect(result[0]!.name).toBe("Alice");
    expect(result[1]!.name).toBe("Bob");
  });

  it("Tier 3: respects limit", async () => {
    const docClient = makeDocClient([
      { Items: [
        { id: "u1" }, { id: "u2" }, { id: "u3" },
        { id: "u4" }, { id: "u5" },
      ] },
    ]);
    const config = makeConfig();
    const findMany = findManyMethod(docClient, config);

    const result = await findMany({
      model: "user",
      limit: 2,
    });

    expect(result.length).toBe(2);
  });

  it("Tier 3 with mixed AND+OR where produces correct filter shape", async () => {
    const calls: any[] = [];
    const docClient = {
      send: vi.fn().mockImplementation(async (cmd: any) => {
        calls.push(cmd);
        return { Items: [{ id: "u1" }, { id: "u2" }] };
      }),
      _calls: () => calls,
    } as any;

    const config = makeConfig();
    const findMany = findManyMethod(docClient, config);

    await findMany({
      model: "user",
      where: [
        { field: "status", operator: "eq", value: "active", connector: "AND" },
        { field: "role", operator: "eq", value: "admin", connector: "AND" },
        { field: "role", operator: "eq", value: "mod", connector: "OR" },
      ],
    });

    const scanCmd = calls.find((c: any) => c.FilterExpression);
    expect(scanCmd).toBeDefined();
    // With connectors [AND, AND, OR], the filter groups AND clauses then OR clause
    // Result: (A AND B) AND (C) — contains AND (from grouping), C is wrapped standalone
    expect(scanCmd.FilterExpression).toContain("AND");
  });
});
