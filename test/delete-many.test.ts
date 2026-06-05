import { describe, it, expect, vi, beforeEach } from "vitest";
import { deleteManyMethod } from "../src/adapter/methods/delete-many";
import type { DynamoDBAdapterConfig } from "../src/types";

// Mock the AWS SDK
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  BatchWriteCommand: vi.fn().mockImplementation((input: any) => ({
    ...input,
    _type: "BatchWriteCommand",
  })),
  BatchGetCommand: vi.fn().mockImplementation((input: any) => ({
    ...input,
    _type: "BatchGetCommand",
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

describe("deleteMany", () => {
  it("deletes items found via Tier 2 GSI Query, batches into 25, returns count", async () => {
    // Create 30 users with the same userId pattern
    const users = Array.from({ length: 30 }, (_, i) => ({
      id: `u${i}`,
      userId: "owner1",
      name: `User ${i}`,
    }));

    const calls: any[] = [];
    const docClient = makeDocClient(async (cmd: any) => {
      calls.push(cmd);

      if (cmd._type === "QueryCommand") {
        // Return all 30 items in one page
        return { Items: users };
      }

      if (cmd._type === "BatchWriteCommand") {
        // All deletes succeed
        return { UnprocessedItems: {} };
      }

      return {};
    });

    const config = makeConfig({
      indexes: {
        user: {
          userId: { indexName: "userId-index", hashKey: "userId" },
        },
      },
    });

    const deleteMany = deleteManyMethod(docClient, config);
    const result = await deleteMany({
      model: "user",
      where: [{ field: "userId", operator: "eq", value: "owner1" }],
    });

    expect(result).toBe(30);

    // First call should be Query on the GSI
    expect(calls[0]._type).toBe("QueryCommand");
    expect(calls[0].IndexName).toBe("userId-index");

    // Should have split into 2 batches: 25 + 5
    const batchCalls = calls.filter((c: any) => c._type === "BatchWriteCommand");
    expect(batchCalls.length).toBe(2);

    // First batch should have 25 items
    const batch1Requests = batchCalls[0].RequestItems["test-users"];
    expect(batch1Requests.length).toBe(25);
    expect(batch1Requests[0].DeleteRequest.Key).toEqual({ id: "u0" });

    // Second batch should have 5 items
    const batch2Requests = batchCalls[1].RequestItems["test-users"];
    expect(batch2Requests.length).toBe(5);
  });

  it("retries UnprocessedItems with exponential backoff", async () => {
    const users = Array.from({ length: 5 }, (_, i) => ({
      id: `u${i}`,
      name: `User ${i}`,
    }));

    let batchCalls = 0;
    const docClient = makeDocClient(async (cmd: any) => {
      if (cmd._type === "GetCommand") {
        // Tier 1: GetItem returns the item
        const keyId = (cmd as any).Key.id;
        const found = users.find((u: any) => u.id === keyId);
        return { Item: found ?? null };
      }

      if (cmd._type === "QueryCommand") {
        return { Items: users };
      }

      if (cmd._type === "ScanCommand") {
        return { Items: users };
      }

      if (cmd._type === "BatchWriteCommand") {
        batchCalls++;
        if (batchCalls === 1) {
          // First attempt: 2 unprocessed items
          return {
            UnprocessedItems: {
              "test-users": [
                { DeleteRequest: { Key: { id: "u0" } } },
                { DeleteRequest: { Key: { id: "u1" } } },
              ],
            },
          };
        }
        if (batchCalls === 2) {
          // Second attempt: 1 unprocessed item
          return {
            UnprocessedItems: {
              "test-users": [
                { DeleteRequest: { Key: { id: "u0" } } },
              ],
            },
          };
        }
        // Third attempt: all succeed
        return { UnprocessedItems: {} };
      }

      return {};
    });

    const config = makeConfig();
    const deleteMany = deleteManyMethod(docClient, config);

    const result = await deleteMany({
      model: "user",
      // Use a non-PK field to trigger Scan (Tier 3) so all 5 items match
      where: [{ field: "name", operator: "starts_with", value: "User" }],
    });

    // First batch attempt: 5 sent, 2 unprocessed → 3 committed
    // Retry 1: 2 sent, 1 unprocessed → 1 more committed
    // Retry 2: 1 sent, all ok → 1 committed
    // Total = 3 + 1 + 1 = 5
    expect(result).toBe(5);
    // Should have had 3 batch calls total: initial + 2 retries
    expect(batchCalls).toBe(3);
  });

  it("handles KEYS_ONLY GSI with follow-up GetItem", async () => {
    const gsiItems = [
      { id: "acc1", providerId: "google", accountId: "123" },
      { id: "acc2", providerId: "google", accountId: "456" },
    ];
    const fullItems = [
      { id: "acc1", providerId: "google", accountId: "123", userId: "u1", accessToken: "t1" },
      { id: "acc2", providerId: "google", accountId: "456", userId: "u2", accessToken: "t2" },
    ];

    const calls: any[] = [];
    const docClient = makeDocClient(async (cmd: any) => {
      calls.push(cmd);

      if (cmd._type === "QueryCommand") {
        return { Items: gsiItems };
      }

      if (cmd._type === "BatchGetCommand") {
        const keys = (cmd as any).RequestItems["test-accounts"].Keys;
        const items = keys
          .map((k: any) =>
            fullItems.find(
              (f) => f.providerId === k.providerId && f.accountId === k.accountId,
            ),
          )
          .filter(Boolean);
        return { Responses: { "test-accounts": items }, UnprocessedKeys: {} };
      }

      if (cmd._type === "BatchWriteCommand") {
        return { UnprocessedItems: {} };
      }

      return {};
    });

    const config = makeConfig({
      indexes: {
        account: {
          id: {
            indexName: "by-id",
            hashKey: "id",
            projection: "KEYS_ONLY",
          },
        },
      },
    });

    const deleteMany = deleteManyMethod(docClient, config);
    const result = await deleteMany({
      model: "account",
      where: [{ field: "id", operator: "eq", value: "acc1" }],
    });

    // Follow-up BatchGetCommand should have been made for KEYS_ONLY projection
    const batchGetCalls = calls.filter((c: any) => c._type === "BatchGetCommand");
    expect(batchGetCalls.length).toBe(1);

    // BatchWrite should use composite keys (providerId + accountId)
    const batchCalls = calls.filter((c: any) => c._type === "BatchWriteCommand");
    expect(batchCalls.length).toBe(1);
    const requests = batchCalls[0].RequestItems["test-accounts"];
    expect(requests.length).toBe(2);
    expect(requests[0].DeleteRequest.Key).toEqual({
      providerId: "google",
      accountId: "123",
    });
    expect(requests[1].DeleteRequest.Key).toEqual({
      providerId: "google",
      accountId: "456",
    });

    expect(result).toBe(2);
  });

  it("throws when where is an empty array", async () => {
    const docClient = makeDocClient(async () => ({}));
    const config = makeConfig();
    const deleteMany = deleteManyMethod(docClient, config);

    await expect(
      deleteMany({ model: "user", where: [] }),
    ).rejects.toThrow(/empty where/);
  });

  it("returns 0 when no matching items found", async () => {
    const docClient = makeDocClient(async (cmd: any) => {
      if (cmd._type === "QueryCommand") {
        return { Items: [] };
      }
      return {};
    });

    const config = makeConfig({
      indexes: {
        user: {
          userId: { indexName: "userId-index", hashKey: "userId" },
        },
      },
    });

    const deleteMany = deleteManyMethod(docClient, config);
    const result = await deleteMany({
      model: "user",
      where: [{ field: "userId", operator: "eq", value: "nonexistent" }],
    });

    expect(result).toBe(0);
  });

  it("uses Tier 1 GetItem when PK equality in where", async () => {
    const calls: any[] = [];
    const docClient = makeDocClient(async (cmd: any) => {
      calls.push(cmd);

      if (cmd._type === "GetCommand") {
        return { Item: { id: "u1", name: "Alice" } };
      }

      if (cmd._type === "BatchWriteCommand") {
        return { UnprocessedItems: {} };
      }

      return {};
    });

    const config = makeConfig();
    const deleteMany = deleteManyMethod(docClient, config);

    const result = await deleteMany({
      model: "user",
      where: [{ field: "id", operator: "eq", value: "u1" }],
    });

    expect(result).toBe(1);

    // Should use GetItem, not Query
    expect(calls[0]._type).toBe("GetCommand");
    expect(calls[0].Key).toEqual({ id: "u1" });

    // Should batch-delete the single key
    const batchCall = calls.find((c: any) => c._type === "BatchWriteCommand");
    expect(batchCall).not.toBeNull();
    expect(batchCall.RequestItems["test-users"][0].DeleteRequest.Key).toEqual({
      id: "u1",
    });
  });

  it("returns partial count when retries exhausted with remaining UnprocessedItems", async () => {
    // Scan returns 2 items. Every BatchWrite call returns 1 UnprocessedItem.
    // After 3 attempts (initial + 2 retries), 1 item remains unprocessed = 1 deleted.
    const users = [{ id: "u1", role: "admin" }, { id: "u2", role: "admin" }];

    const docClient = makeDocClient(async (cmd: any) => {
      if (cmd._type === "ScanCommand") {
        return { Items: users };
      }
      if (cmd._type === "BatchWriteCommand") {
        // Always return 1 UnprocessedItem for u2
        return {
          UnprocessedItems: {
            "test-users": [{ DeleteRequest: { Key: { id: "u2" } } }],
          },
        };
      }
      return {};
    });

    const config = makeConfig();
    const deleteMany = deleteManyMethod(docClient, config);

    const result = await deleteMany({
      model: "user",
      where: [{ field: "role", operator: "eq", value: "admin" }],
    });

    // 2 items initially, 1 permanently unprocessed after 3 attempts = 1 deleted
    expect(result).toBe(1);
  });

  it("uses Tier 3 Scan when no index matches", async () => {
    const users = [
      { id: "u1", name: "Alice", role: "admin" },
      { id: "u2", name: "Bob", role: "admin" },
    ];

    const calls: any[] = [];
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

    const config = makeConfig(); // no indexes → Tier 3
    const deleteMany = deleteManyMethod(docClient, config);

    const result = await deleteMany({
      model: "user",
      where: [{ field: "role", operator: "eq", value: "admin" }],
    });

    expect(result).toBe(2);
    expect(calls[0]._type).toBe("ScanCommand");
  });
});
