import { describe, it, expect, vi, beforeEach } from "vitest";
import { updateManyMethod } from "../src/adapter/methods/update-many";
import type { DynamoDBAdapterConfig } from "../src/types";

// Mock the AWS SDK
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  UpdateCommand: vi.fn().mockImplementation((input: any) => ({
    ...input,
    _type: "UpdateCommand",
  })),
  GetCommand: vi.fn().mockImplementation((input: any) => ({
    ...input,
    _type: "GetCommand",
  })),
  QueryCommand: vi.fn().mockImplementation((input: any) => ({
    ...input,
    _type: "QueryCommand",
  })),
  ScanCommand: vi.fn().mockImplementation((input: any) => ({
    ...input,
    _type: "ScanCommand",
  })),
  PutCommand: vi.fn().mockImplementation((input: any) => ({
    ...input,
    _type: "PutCommand",
  })),
  DeleteCommand: vi.fn().mockImplementation((input: any) => ({
    ...input,
    _type: "DeleteCommand",
  })),
  BatchGetCommand: vi.fn().mockImplementation((input: any) => ({
    ...input,
    _type: "BatchGetCommand",
  })),
  BatchWriteCommand: vi.fn().mockImplementation((input: any) => ({
    ...input,
    _type: "BatchWriteCommand",
  })),
}));

function makeDocClient(sendImpl: (cmd: any) => Promise<any>) {
  return { send: sendImpl } as any;
}

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

describe("updateMany", () => {
  it("finds items via GSI Query and updates each with parallel UpdateItem", async () => {
    const calls: any[] = [];
    const sessions = [
      { token: "tok1", userId: "u1", ipAddress: "1.2.3.4" },
      { token: "tok2", userId: "u1", ipAddress: "5.6.7.8" },
      { token: "tok3", userId: "u1", ipAddress: "9.0.1.2" },
    ];

    const docClient = makeDocClient(async (cmd: any) => {
      calls.push(cmd);
      if (cmd._type === "QueryCommand") {
        return { Items: sessions };
      }
      if (cmd._type === "UpdateCommand") {
        return { Attributes: {} };
      }
      return {};
    });

    const config = makeConfig({
      indexes: {
        session: {
          userId: { indexName: "userId-index", hashKey: "userId" },
        },
      },
    });
    const updateMany = updateManyMethod(docClient, config);

    const count = await updateMany({
      model: "session",
      where: [{ field: "userId", operator: "eq", value: "u1" }],
      update: { ipAddress: "0.0.0.0" },
    });

    expect(count).toBe(3);
    // First call: Query; remaining 3: UpdateCommand
    expect(calls[0]._type).toBe("QueryCommand");
    const updateCalls = calls.filter(
      (c: any) => c._type === "UpdateCommand",
    );
    expect(updateCalls.length).toBe(3);
    // Each UpdateCommand should target the correct session key
    expect(updateCalls[0].Key).toEqual({ token: "tok1" });
    expect(updateCalls[1].Key).toEqual({ token: "tok2" });
    expect(updateCalls[2].Key).toEqual({ token: "tok3" });
    // Each UpdateExpression should use field-level SET (not full-item Put)
    for (const uc of updateCalls) {
      expect(uc.UpdateExpression).toContain("SET");
    }
  });

  it("finds items via Scan (Tier 3) and updates each", async () => {
    const calls: any[] = [];
    const users = [
      { id: "u1", name: "Alice", role: "user" },
      { id: "u2", name: "Bob", role: "user" },
    ];

    const docClient = makeDocClient(async (cmd: any) => {
      calls.push(cmd);
      if (cmd._type === "ScanCommand") {
        return { Items: users };
      }
      if (cmd._type === "UpdateCommand") {
        return { Attributes: {} };
      }
      return {};
    });

    const config = makeConfig();
    const updateMany = updateManyMethod(docClient, config);

    const count = await updateMany({
      model: "user",
      where: [{ field: "role", operator: "eq", value: "user" }],
      update: { role: "admin" },
    });

    expect(count).toBe(2);
    expect(calls[0]._type).toBe("ScanCommand");
    const updateCalls = calls.filter(
      (c: any) => c._type === "UpdateCommand",
    );
    expect(updateCalls.length).toBe(2);
  });

  it("throws AggregateError on partial failure", async () => {
    const calls: any[] = [];
    const sessions = [
      { token: "tok1", userId: "u1" },
      { token: "tok2", userId: "u1" }, // this one will fail
      { token: "tok3", userId: "u1" },
    ];

    let updateCallCount = 0;
    const docClient = makeDocClient(async (cmd: any) => {
      calls.push(cmd);
      if (cmd._type === "QueryCommand") {
        return { Items: sessions };
      }
      if (cmd._type === "UpdateCommand") {
        updateCallCount++;
        if (updateCallCount === 2) {
          throw new Error("ThrottlingException");
        }
        return { Attributes: {} };
      }
      return {};
    });

    const config = makeConfig({
      indexes: {
        session: {
          userId: { indexName: "userId-index", hashKey: "userId" },
        },
      },
    });
    const updateMany = updateManyMethod(docClient, config);

    await expect(
      updateMany({
        model: "session",
        where: [{ field: "userId", operator: "eq", value: "u1" }],
        update: { ipAddress: "0.0.0.0" },
      }),
    ).rejects.toThrow(AggregateError);
  });

  it("returns 0 when no items match", async () => {
    const docClient = makeDocClient(async (cmd: any) => {
      if ((cmd as any)._type === "QueryCommand") {
        return { Items: [] };
      }
      if ((cmd as any)._type === "ScanCommand") {
        return { Items: [] };
      }
      return {};
    });

    const config = makeConfig();
    const updateMany = updateManyMethod(docClient, config);

    const count = await updateMany({
      model: "user",
      where: [{ field: "role", operator: "eq", value: "superadmin" }],
      update: { role: "admin" },
    });

    expect(count).toBe(0);
  });

  it("returns 0 when update object is empty", async () => {
    const docClient = makeDocClient(async (_cmd: any) => ({}));
    const config = makeConfig();
    const updateMany = updateManyMethod(docClient, config);

    const count = await updateMany({
      model: "user",
      where: [{ field: "role", operator: "eq", value: "user" }],
      update: {},
    });

    expect(count).toBe(0);
  });

  it("respects concurrency limit", async () => {
    const items: any[] = [];
    // Create 25 items — should be processed in batches of 10
    for (let i = 0; i < 25; i++) {
      items.push({ token: `tok${i}`, userId: "u1" });
    }

    let inFlight = 0;
    let maxInFlight = 0;

    const docClient = makeDocClient(async (cmd: any) => {
      if (cmd._type === "QueryCommand") {
        return { Items: items };
      }
      if (cmd._type === "UpdateCommand") {
        inFlight++;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        // Actually await a short delay so concurrency is observable
        await new Promise<void>((resolve) =>
          setTimeout(() => {
            inFlight--;
            resolve();
          }, 10),
        );
        return { Attributes: {} };
      }
      return {};
    });

    const config = makeConfig({
      updateManyConcurrency: 10,
      indexes: {
        session: {
          userId: { indexName: "userId-index", hashKey: "userId" },
        },
      },
    });
    const updateMany = updateManyMethod(docClient, config);

    const count = await updateMany({
      model: "session",
      where: [{ field: "userId", operator: "eq", value: "u1" }],
      update: { ipAddress: "0.0.0.0" },
    });

    expect(count).toBe(25);
    // Concurrency should not exceed the limit
    expect(maxInFlight).toBeLessThanOrEqual(10);
  });

  // ── unsafeBatchUpdate path ────────────────────────────────

  it("unsafeBatchUpdate: true uses BatchWriteCommand+PutRequest", async () => {
    const calls: any[] = [];
    const users = [
      { id: "u1", name: "Alice", role: "user" },
      { id: "u2", name: "Bob", role: "user" },
      { id: "u3", name: "Charlie", role: "user" },
    ];

    const docClient = makeDocClient(async (cmd: any) => {
      calls.push(cmd);
      if (cmd._type === "ScanCommand") {
        return { Items: users };
      }
      if (cmd._type === "BatchWriteCommand") {
        return { UnprocessedItems: {} };
      }
      return {};
    });

    const config = makeConfig({ unsafeBatchUpdate: true });
    const updateMany = updateManyMethod(docClient, config);

    const count = await updateMany({
      model: "user",
      where: [{ field: "role", operator: "eq", value: "user" }],
      update: { role: "admin" },
    });

    expect(count).toBe(3);
    const batchCall = calls.find((c: any) => c._type === "BatchWriteCommand");
    expect(batchCall).not.toBeNull();
    // Should use PutRequest (full-item overwrite), not UpdateCommand
    const putRequests = batchCall.RequestItems["test-users"];
    expect(putRequests.length).toBe(3);
    expect(putRequests[0].PutRequest).toMatchObject({ Item: { role: "admin" } });
    expect(putRequests[0].PutRequest.Item.role).toBe("admin");
    expect(putRequests[0].PutRequest.Item.name).toBe("Alice"); // full item preserved
  });

  it("unsafeBatchUpdate emits last-write-wins warning with debugLogs", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const users = [{ id: "u1", name: "Alice" }];

    const docClient = makeDocClient(async (cmd: any) => {
      if (cmd._type === "ScanCommand") return { Items: users };
      if (cmd._type === "BatchWriteCommand") return { UnprocessedItems: {} };
      return {};
    });

    const config = makeConfig({ unsafeBatchUpdate: true, debugLogs: true });
    const updateMany = updateManyMethod(docClient, config);

    await updateMany({
      model: "user",
      where: [{ field: "role", operator: "eq", value: "user" }],
      update: { role: "admin" },
    });

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("_updateOne skips concurrently deleted item (ConditionalCheckFailed)", async () => {
    const calls: any[] = [];
    const sessions = [
      { token: "tok1", userId: "u1" },
      { token: "tok2", userId: "u1" },
      { token: "tok3", userId: "u1" },
    ];

    let updateCallCount = 0;
    const docClient = makeDocClient(async (cmd: any) => {
      calls.push(cmd);
      if (cmd._type === "QueryCommand") {
        return { Items: sessions };
      }
      if (cmd._type === "UpdateCommand") {
        updateCallCount++;
        if (updateCallCount === 2) {
          // Simulate item #2 being deleted between findMany and update
          const err: any = new Error("ConditionalCheckFailed");
          err.name = "ConditionalCheckFailedException";
          throw err;
        }
        return { Attributes: {} };
      }
      return {};
    });

    const config = makeConfig({
      indexes: {
        session: {
          userId: { indexName: "userId-index", hashKey: "userId" },
        },
      },
    });
    const updateMany = updateManyMethod(docClient, config);

    // Should NOT throw — ConditionalCheckFailed is caught per-item
    const count = await updateMany({
      model: "session",
      where: [{ field: "userId", operator: "eq", value: "u1" }],
      update: { ipAddress: "0.0.0.0" },
    });

    // 2 of 3 succeeded (the deleted one was skipped)
    expect(count).toBe(2);
  });

  it("converts Date to ISO string in UpdateCommand ExpressionAttributeValues", async () => {
    const calls: any[] = [];
    const sessions = [{ token: "tok1", userId: "u1" }];
    const testDate = new Date("2025-06-05T12:00:00.000Z");

    const docClient = makeDocClient(async (cmd: any) => {
      calls.push(cmd);
      if (cmd._type === "QueryCommand") return { Items: sessions };
      if (cmd._type === "UpdateCommand") return { Attributes: {} };
      return {};
    });

    const config = makeConfig({
      indexes: {
        session: {
          userId: { indexName: "userId-index", hashKey: "userId" },
        },
      },
    });
    const updateMany = updateManyMethod(docClient, config);

    await updateMany({
      model: "session",
      where: [{ field: "userId", operator: "eq", value: "u1" }],
      update: { ipAddress: "10.0.0.1", refreshedAt: testDate },
    });

    const updateCall = calls.find((c: any) => c._type === "UpdateCommand");
    const vals: any = updateCall.ExpressionAttributeValues;
    const isoVal = Object.values(vals).find(
      (v: any) => v === "2025-06-05T12:00:00.000Z",
    );
    expect(isoVal).toBe("2025-06-05T12:00:00.000Z");
  });

  it("standard path with empty where scans all items", async () => {
    const calls: any[] = [];
    const users = [
      { id: "u1", name: "Alice", role: "user" },
      { id: "u2", name: "Bob", role: "user" },
    ];

    const docClient = makeDocClient(async (cmd: any) => {
      calls.push(cmd);
      if (cmd._type === "ScanCommand") return { Items: users };
      if (cmd._type === "UpdateCommand") return { Attributes: {} };
      return {};
    });

    const config = makeConfig();
    const updateMany = updateManyMethod(docClient, config);

    const count = await updateMany({
      model: "user",
      where: [],  // empty where → full table scan
      update: { role: "member" },
    });

    expect(count).toBe(2);
    // First call must be ScanCommand (not QueryCommand)
    expect(calls[0]._type).toBe("ScanCommand");
    // Should have 1 scan + 2 updates
    const updateCalls = calls.filter((c: any) => c._type === "UpdateCommand");
    expect(updateCalls.length).toBe(2);
  });

  it("unsafeBatchUpdate chunks >25 items across multiple BatchWriteCommands", async () => {
    const calls: any[] = [];
    const users = Array.from({ length: 60 }, (_, i) => ({
      id: `u${i}`,
      name: `User ${i}`,
    }));

    const docClient = makeDocClient(async (cmd: any) => {
      calls.push(cmd);
      if (cmd._type === "ScanCommand") {
        return { Items: users };
      }
      if (cmd._type === "BatchWriteCommand") {
        return { UnprocessedItems: {} };
      }
      return {};
    });

    const config = makeConfig({ unsafeBatchUpdate: true });
    const updateMany = updateManyMethod(docClient, config);

    const count = await updateMany({
      model: "user",
      where: [],
      update: { role: "admin" },
    });

    expect(count).toBe(60);
    const batchCalls = calls.filter((c: any) => c._type === "BatchWriteCommand");
    expect(batchCalls.length).toBe(3); // 25 + 25 + 10
    expect(batchCalls[0].RequestItems["test-users"].length).toBe(25);
    expect(batchCalls[1].RequestItems["test-users"].length).toBe(25);
    expect(batchCalls[2].RequestItems["test-users"].length).toBe(10);
  });
});
