import { describe, it, expect, vi } from "vitest";
import { consumeOneMethod } from "../src/adapter/methods/consume-one";
import type { DynamoDBAdapterConfig } from "../src/types";

// Mock the AWS SDK
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DeleteCommand: vi.fn().mockImplementation((input: any) => ({
    ...input,
    _type: "DeleteCommand",
  })),
  QueryCommand: vi.fn().mockImplementation((input: any) => ({
    ...input,
    _type: "QueryCommand",
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

describe("consumeOne", () => {
  it("Tier 1: resolves PK directly from where, deletes with ReturnValues ALL_OLD", async () => {
    const verificationItem = {
      id: "v1",
      identifier: "user@test.com",
      value: "token123",
      expiresAt: "2025-01-01T00:00:00Z",
    };

    const calls: any[] = [];
    const docClient = makeDocClient(async (cmd: any) => {
      calls.push(cmd);
      if (cmd._type === "DeleteCommand") {
        return { Attributes: verificationItem };
      }
      return {};
    });

    const config = makeConfig();
    const consumeOne = consumeOneMethod(docClient, config);

    const result = await consumeOne({
      model: "verification",
      where: [{ field: "id", operator: "eq", value: "v1" }],
    });

    expect(result).toEqual(verificationItem);
    expect(calls.length).toBe(1);
    expect(calls[0]._type).toBe("DeleteCommand");
    expect(calls[0].TableName).toBe("test-verifications");
    expect(calls[0].Key).toEqual({ id: "v1" });
    expect(calls[0].ReturnValues).toBe("ALL_OLD");
  });

  it("Tier 2: resolves key via GSI Query Limit:1, then deletes (review-gap fix A)", async () => {
    const verificationItem = {
      id: "v1",
      identifier: "user@test.com",
      value: "token456",
      expiresAt: "2025-01-01T00:00:00Z",
    };

    const calls: any[] = [];
    const docClient = makeDocClient(async (cmd: any) => {
      calls.push(cmd);
      if (cmd._type === "QueryCommand") {
        return { Items: [verificationItem] };
      }
      if (cmd._type === "DeleteCommand") {
        return { Attributes: verificationItem };
      }
      return {};
    });

    const config = makeConfig({
      indexes: {
        verification: {
          identifier: {
            indexName: "identifier-index",
            hashKey: "identifier",
          },
        },
      },
    });

    const consumeOne = consumeOneMethod(docClient, config);

    const result = await consumeOne({
      model: "verification",
      where: [{ field: "identifier", operator: "eq", value: "user@test.com" }],
    });

    expect(result).toEqual(verificationItem);

    // First call: GSI Query to resolve the key
    expect(calls[0]._type).toBe("QueryCommand");
    expect(calls[0].IndexName).toBe("identifier-index");
    expect(calls[0].Limit).toBe(1);

    // Second call: Delete with resolved key
    expect(calls[1]._type).toBe("DeleteCommand");
    expect(calls[1].Key).toEqual({ id: "v1" });
    expect(calls[1].ReturnValues).toBe("ALL_OLD");
  });

  it("returns null when item not found (Tier 1)", async () => {
    const docClient = makeDocClient(async (cmd: any) => {
      if (cmd._type === "DeleteCommand") {
        return {}; // No Attributes returned
      }
      return {};
    });

    const config = makeConfig();
    const consumeOne = consumeOneMethod(docClient, config);

    const result = await consumeOne({
      model: "verification",
      where: [{ field: "id", operator: "eq", value: "nonexistent" }],
    });

    expect(result).toBeNull();
  });

  it("returns null when item not found (Tier 2 GSI Query)", async () => {
    const docClient = makeDocClient(async (cmd: any) => {
      if (cmd._type === "QueryCommand") {
        return { Items: [] };
      }
      return {};
    });

    const config = makeConfig({
      indexes: {
        verification: {
          identifier: {
            indexName: "identifier-index",
            hashKey: "identifier",
          },
        },
      },
    });

    const consumeOne = consumeOneMethod(docClient, config);

    const result = await consumeOne({
      model: "verification",
      where: [{ field: "identifier", operator: "eq", value: "none@test.com" }],
    });

    expect(result).toBeNull();
  });

  it("throws InvalidWhereError on Tier 3 (no index match)", async () => {
    const docClient = makeDocClient(async () => ({}));

    const config = makeConfig(); // no indexes
    const consumeOne = consumeOneMethod(docClient, config);

    await expect(
      consumeOne({
        model: "verification",
        where: [{ field: "value", operator: "eq", value: "token123" }],
      }),
    ).rejects.toThrow(/consumeOne requires/);
  });

  it("handles composite key consume (account by providerId + accountId)", async () => {
    const accountItem = {
      id: "acc1",
      providerId: "google",
      accountId: "12345",
      userId: "u1",
    };

    const calls: any[] = [];
    const docClient = makeDocClient(async (cmd: any) => {
      calls.push(cmd);
      if (cmd._type === "DeleteCommand") {
        return { Attributes: accountItem };
      }
      return {};
    });

    const config = makeConfig();
    const consumeOne = consumeOneMethod(docClient, config);

    const result = await consumeOne({
      model: "account",
      where: [
        { field: "providerId", operator: "eq", value: "google" },
        { field: "accountId", operator: "eq", value: "12345" },
      ],
    });

    expect(result).toEqual(accountItem);
    expect(calls[0]._type).toBe("DeleteCommand");
    expect(calls[0].Key).toEqual({
      providerId: "google",
      accountId: "12345",
    });
  });

  it("throws InvalidWhereError on composite key without SK", async () => {
    const docClient = makeDocClient(async () => ({}));

    const config = makeConfig();
    const consumeOne = consumeOneMethod(docClient, config);

    await expect(
      consumeOne({
        model: "account",
        // Missing accountId
        where: [{ field: "providerId", operator: "eq", value: "google" }],
      }),
    ).rejects.toThrow(/consumeOne requires both PK/);
  });
});
