import { describe, it, expect, vi } from "vitest";
import { countMethod } from "../src/adapter/methods/count";
import type { DynamoDBAdapterConfig } from "../src/types";

// Mock the AWS SDK so command input props are spread onto the object
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  ScanCommand: vi.fn().mockImplementation((input: any) => ({ ...input, _type: "ScanCommand" })),
  QueryCommand: vi.fn().mockImplementation((input: any) => ({ ...input, _type: "QueryCommand" })),
}));

function makeDocClient(responses: any[]) {
  let callIdx = 0;
  const send = vi.fn().mockImplementation(async (_cmd: any) => {
    const resp = responses[callIdx] ?? { Count: 0, ScannedCount: 0 };
    callIdx++;
    return resp;
  });
  return { send, _capture: () => send.mock.calls.map((c: any) => c[0]) } as any;
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

describe("count", () => {
  it("returns 0 for empty table", async () => {
    const docClient = makeDocClient([{ Count: 0, ScannedCount: 0 }]);
    const config = makeConfig();
    const count = countMethod(docClient, config);

    const result = await count({ model: "user" });
    expect(result).toBe(0);
  });

  it("returns count from a single page", async () => {
    const docClient = makeDocClient([{ Count: 42, ScannedCount: 42 }]);
    const config = makeConfig();
    const count = countMethod(docClient, config);

    const result = await count({ model: "user" });
    expect(result).toBe(42);
  });

  it("paginates across multiple pages", async () => {
    const docClient = makeDocClient([
      { Count: 30, ScannedCount: 30, LastEvaluatedKey: { id: "page1" } },
      { Count: 20, ScannedCount: 20 },
    ]);
    const config = makeConfig();
    const count = countMethod(docClient, config);

    const result = await count({ model: "user" });
    expect(result).toBe(50);
    expect(docClient.send).toHaveBeenCalledTimes(2);
  });

  it("warns when scanned count exceeds threshold", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const docClient = makeDocClient([{ Count: 50_000, ScannedCount: 50_000 }]);
    const config = makeConfig({ debugLogs: true });
    const count = countMethod(docClient, config);

    await count({ model: "user" });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("does not warn when warnOnLargeCount is 0", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const docClient = makeDocClient([{ Count: 50_000, ScannedCount: 50_000 }]);
    const config = makeConfig({ debugLogs: true, warnOnLargeCount: 0 });
    const count = countMethod(docClient, config);

    await count({ model: "user" });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // ── Filter operator coverage ──────────────────────────────

  it("count with where[gt] emits FilterExpression with >", async () => {
    const docClient = makeDocClient([{ Count: 10, ScannedCount: 10 }]);
    const config = makeConfig();
    const count = countMethod(docClient, config);
    await count({ model: "user", where: [{ field: "age", operator: "gt", value: 18 }] });
    const [cmd] = docClient._capture();
    expect(cmd.FilterExpression).toContain(">");
  });

  it("count with where[gte] emits FilterExpression with >=", async () => {
    const docClient = makeDocClient([{ Count: 5, ScannedCount: 5 }]);
    const config = makeConfig();
    const count = countMethod(docClient, config);
    await count({ model: "user", where: [{ field: "score", operator: "gte", value: 50 }] });
    const [cmd] = docClient._capture();
    expect(cmd.FilterExpression).toContain(">=");
  });

  it("count with where[lt] emits FilterExpression with <", async () => {
    const docClient = makeDocClient([{ Count: 3, ScannedCount: 3 }]);
    const config = makeConfig();
    const count = countMethod(docClient, config);
    await count({ model: "user", where: [{ field: "age", operator: "lt", value: 65 }] });
    const [cmd] = docClient._capture();
    expect(cmd.FilterExpression).toContain("<");
  });

  it("count with where[lte] emits FilterExpression with <=", async () => {
    const docClient = makeDocClient([{ Count: 7, ScannedCount: 7 }]);
    const config = makeConfig();
    const count = countMethod(docClient, config);
    await count({ model: "user", where: [{ field: "limit", operator: "lte", value: 100 }] });
    const [cmd] = docClient._capture();
    expect(cmd.FilterExpression).toContain("<=");
  });

  it("count with where[ne] emits FilterExpression with <>", async () => {
    const docClient = makeDocClient([{ Count: 9, ScannedCount: 9 }]);
    const config = makeConfig();
    const count = countMethod(docClient, config);
    await count({ model: "user", where: [{ field: "status", operator: "ne", value: "deleted" }] });
    const [cmd] = docClient._capture();
    expect(cmd.FilterExpression).toContain("<>");
  });

  it("count with where[in] emits IN clause with value list", async () => {
    const docClient = makeDocClient([{ Count: 12, ScannedCount: 12 }]);
    const config = makeConfig();
    const count = countMethod(docClient, config);
    await count({
      model: "user",
      where: [{ field: "role", operator: "in", value: ["admin", "mod", "editor", "viewer", "guest"] }],
    });
    const [cmd] = docClient._capture();
    expect(cmd.FilterExpression).toContain("IN");
    // The first value ref may be :v1 (if :v0 was used by the field name)
    expect(cmd.FilterExpression).toContain(":v");
    // Should include 5 values
    const valCount = (cmd.FilterExpression.match(/:v\d+/g) || []).length;
    expect(valCount).toBe(5);
  });

  it("count with where[starts_with] emits begins_with", async () => {
    const docClient = makeDocClient([{ Count: 4, ScannedCount: 4 }]);
    const config = makeConfig();
    const count = countMethod(docClient, config);
    await count({
      model: "user",
      where: [{ field: "email", operator: "starts_with", value: "admin@" }],
    });
    const [cmd] = docClient._capture();
    expect(cmd.FilterExpression).toContain("begins_with");
  });

  it("count with where[contains] emits contains function", async () => {
    const docClient = makeDocClient([{ Count: 6, ScannedCount: 6 }]);
    const config = makeConfig();
    const count = countMethod(docClient, config);
    await count({
      model: "user",
      where: [{ field: "bio", operator: "contains", value: "engineer" }],
    });
    const [cmd] = docClient._capture();
    expect(cmd.FilterExpression).toContain("contains");
  });

  it("count with where[not_in] emits NOT IN expression", async () => {
    const docClient = makeDocClient([{ Count: 3, ScannedCount: 3 }]);
    const config = makeConfig();
    const count = countMethod(docClient, config);
    await count({
      model: "user",
      where: [{ field: "role", operator: "not_in", value: ["banned", "deleted"] }],
    });
    const [cmd] = docClient._capture();
    expect(cmd.FilterExpression).toContain("NOT");
    expect(cmd.FilterExpression).toContain("IN");
  });

  it("count with where[between] emits BETWEEN expression", async () => {
    const docClient = makeDocClient([{ Count: 5, ScannedCount: 5 }]);
    const config = makeConfig();
    const count = countMethod(docClient, config);
    await count({
      model: "user",
      where: [{ field: "age", operator: "between", value: [18, 65] }],
    });
    const [cmd] = docClient._capture();
    expect(cmd.FilterExpression).toContain("BETWEEN");
    expect(cmd.FilterExpression).toContain("AND");
  });

  it("count with mixed AND+OR connectors produces grouped expression", async () => {
    const docClient = makeDocClient([{ Count: 1, ScannedCount: 1 }]);
    const config = makeConfig();
    const count = countMethod(docClient, config);
    await count({
      model: "user",
      where: [
        { field: "status", operator: "eq", value: "active", connector: "AND" },
        { field: "role", operator: "eq", value: "admin", connector: "AND" },
        { field: "role", operator: "eq", value: "mod", connector: "OR" },
      ],
    });
    const [cmd] = docClient._capture();
    expect(cmd.FilterExpression).toContain("AND");
    expect(cmd.FilterExpression).toContain("OR");
  });

  // ── GSI-optimised count ───────────────────────────────────

  it("uses QueryCommand on GSI when where[eq] matches hash key", async () => {
    const docClient = makeDocClient([{ Count: 7, ScannedCount: 7 }]);
    const config = makeConfig({
      indexes: {
        user: { email: { indexName: "email-index", hashKey: "email" } },
      },
    });
    const count = countMethod(docClient, config);

    await count({
      model: "user",
      where: [{ field: "email", operator: "eq", value: "a@b.com" }],
    });

    const [cmd] = docClient._capture();
    expect(cmd._type).toBe("QueryCommand");
    expect(cmd.IndexName).toBe("email-index");
    expect(cmd.Select).toBe("COUNT");
    expect(cmd.KeyConditionExpression).toContain("#hk = :hv");
  });

  it("uses QueryCommand on GSI with extra where clauses as FilterExpression", async () => {
    const docClient = makeDocClient([{ Count: 2, ScannedCount: 2 }]);
    const config = makeConfig({
      indexes: {
        user: { email: { indexName: "email-index", hashKey: "email" } },
      },
    });
    const count = countMethod(docClient, config);

    await count({
      model: "user",
      where: [
        { field: "email", operator: "eq", value: "a@b.com" },
        { field: "status", operator: "eq", value: "active" },
      ],
    });

    const [cmd] = docClient._capture();
    expect(cmd._type).toBe("QueryCommand");
    expect(cmd.IndexName).toBe("email-index");
    expect(cmd.KeyConditionExpression).toContain("#hk = :hv");
    // Extra where clause becomes FilterExpression
    expect(cmd.FilterExpression).toBeDefined();
  });

  it("falls back to ScanCommand when no GSI hash key matches", async () => {
    const docClient = makeDocClient([{ Count: 5, ScannedCount: 5 }]);
    const config = makeConfig({
      indexes: {
        user: { email: { indexName: "email-index", hashKey: "email" } },
      },
    });
    const count = countMethod(docClient, config);

    // "name" is not a GSI hash key → falls back to Scan
    await count({
      model: "user",
      where: [{ field: "name", operator: "eq", value: "Alice" }],
    });

    const [cmd] = docClient._capture();
    expect(cmd._type).toBe("ScanCommand");
  });

  it("falls back to ScanCommand when operator is not eq", async () => {
    const docClient = makeDocClient([{ Count: 3, ScannedCount: 3 }]);
    const config = makeConfig({
      indexes: {
        user: { email: { indexName: "email-index", hashKey: "email" } },
      },
    });
    const count = countMethod(docClient, config);

    // starts_with is not eq → no GSI optimisation
    await count({
      model: "user",
      where: [{ field: "email", operator: "starts_with", value: "admin" }],
    });

    const [cmd] = docClient._capture();
    expect(cmd._type).toBe("ScanCommand");
  });

  it("count on empty where uses ScanCommand (no GSI match)", async () => {
    const docClient = makeDocClient([{ Count: 42, ScannedCount: 42 }]);
    const config = makeConfig({
      indexes: {
        user: { email: { indexName: "email-index", hashKey: "email" } },
      },
    });
    const count = countMethod(docClient, config);

    await count({ model: "user" });

    const [cmd] = docClient._capture();
    expect(cmd._type).toBe("ScanCommand");
  });
});
