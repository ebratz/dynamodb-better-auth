import { describe, it, expect, vi } from "vitest";
import { updateMethod } from "../src/adapter/methods/update";
import { makeConfig } from "./helpers";

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

describe("update", () => {
  it("Tier 1: UpdateItem with SET expression and ReturnValues ALL_NEW", async () => {
    const calls: any[] = [];
    const updatedUser = {
      id: "u1",
      email: "a@b.com",
      name: "Alice Updated",
      updatedAt: "2024-01-01T00:00:00Z",
    };

    const docClient = makeDocClient(async (cmd: any) => {
      calls.push(cmd);
      return { Attributes: updatedUser };
    });

    const config = makeConfig();
    const update = updateMethod(docClient, config);

    const result = await update({
      model: "user",
      where: [
        { field: "id", operator: "eq", value: "u1" },
      ],
      update: { name: "Alice Updated" },
    });

    expect(result).toEqual(updatedUser);
    expect(calls.length).toBe(1);
    expect(calls[0]._type).toBe("UpdateCommand");
    expect(calls[0].TableName).toBe("test-users");
    expect(calls[0].Key).toEqual({ id: "u1" });
    expect(calls[0].UpdateExpression).toContain("SET");
    expect(calls[0].UpdateExpression).toContain("=");
    expect(calls[0].ReturnValues).toBe("ALL_NEW");
    // ExpressionAttributeNames should contain the name field ref
    expect(Object.keys(calls[0].ExpressionAttributeNames).length).toBeGreaterThan(0);
    // ExpressionAttributeValues should contain the new name value
    expect(Object.keys(calls[0].ExpressionAttributeValues).length).toBeGreaterThan(0);
    const vals: any = calls[0].ExpressionAttributeValues;
    const valRefs = Object.keys(vals);
    expect(valRefs.length).toBe(1);
    expect(vals[valRefs[0]!]).toBe("Alice Updated");
  });

  it("Tier 1: UpdateItem on composite key (account)", async () => {
    const calls: any[] = [];
    const updatedAccount = {
      id: "acc1",
      providerId: "google",
      accountId: "12345",
      userId: "u1",
      accessToken: "new-token",
    };

    const docClient = makeDocClient(async (cmd: any) => {
      calls.push(cmd);
      return { Attributes: updatedAccount };
    });

    const config = makeConfig();
    const update = updateMethod(docClient, config);

    const result = await update({
      model: "account",
      where: [
        { field: "providerId", operator: "eq", value: "google" },
        { field: "accountId", operator: "eq", value: "12345" },
      ],
      update: { accessToken: "new-token" },
    });

    expect(result).toEqual(updatedAccount);
    expect(calls[0].Key).toEqual({
      providerId: "google",
      accountId: "12345",
    });
  });

  it("Tier 2: findOne via GSI Query → UpdateItem on resolved key", async () => {
    const calls: any[] = [];
    const existingUser = { id: "u1", email: "x@y.com", name: "Old" };

    const docClient = makeDocClient(async (cmd: any) => {
      calls.push(cmd);
      if (cmd._type === "QueryCommand") {
        return { Items: [existingUser] };
      }
      if (cmd._type === "UpdateCommand") {
        return { Attributes: { ...existingUser, name: "New" } };
      }
      return {};
    });

    const config = makeConfig({
      indexes: {
        user: {
          email: { indexName: "email-index", hashKey: "email" },
        },
      },
    });
    const update = updateMethod(docClient, config);

    const result = await update({
      model: "user",
      where: [{ field: "email", operator: "eq", value: "x@y.com" }],
      update: { name: "New" },
    });

    expect(result).not.toBeNull();
    expect(result!.name).toBe("New");
    // First call should be Query, second should be Update
    expect(calls[0]._type).toBe("QueryCommand");
    expect(calls[1]._type).toBe("UpdateCommand");
    // UpdateCommand should use the key resolved from the query result
    expect(calls[1].Key).toEqual({ id: "u1" });
  });

  it("Tier 3: Scan → findOne → UpdateItem on resolved key", async () => {
    const calls: any[] = [];
    const existingUser = { id: "u1", email: "x@y.com", name: "Old" };

    const docClient = makeDocClient(async (cmd: any) => {
      calls.push(cmd);
      if (cmd._type === "ScanCommand") {
        return { Items: [existingUser] };
      }
      if (cmd._type === "UpdateCommand") {
        return { Attributes: { ...existingUser, name: "New" } };
      }
      return {};
    });

    const config = makeConfig(); // no indexes → Tier 3
    const update = updateMethod(docClient, config);

    const result = await update({
      model: "user",
      where: [{ field: "name", operator: "contains", value: "Old" }],
      update: { name: "New" },
    });

    expect(result).not.toBeNull();
    // Scan used, then UpdateCommand on resolved key (NOT PutItem)
    expect(calls[0]._type).toBe("ScanCommand");
    expect(calls[1]._type).toBe("UpdateCommand");
  });

  it("returns null when no matching item found (Tier 2)", async () => {
    const docClient = makeDocClient(async (cmd: any) => {
      if ((cmd as any)._type === "QueryCommand") {
        return { Items: [] };
      }
      return {};
    });

    const config = makeConfig({
      indexes: {
        user: {
          email: { indexName: "email-index", hashKey: "email" },
        },
      },
    });
    const update = updateMethod(docClient, config);

    const result = await update({
      model: "user",
      where: [{ field: "email", operator: "eq", value: "nonexistent@test.com" }],
      update: { name: "DoesNotMatter" },
    });

    expect(result).toBeNull();
  });

  it("returns null when no matching item found (Tier 3)", async () => {
    const docClient = makeDocClient(async (cmd: any) => {
      if ((cmd as any)._type === "ScanCommand") {
        return { Items: [] };
      }
      return {};
    });

    const config = makeConfig();
    const update = updateMethod(docClient, config);

    const result = await update({
      model: "user",
      where: [{ field: "name", operator: "eq", value: "Nobody" }],
      update: { name: "DoesNotMatter" },
    });

    expect(result).toBeNull();
  });

  it("handles empty update object (no-op, returns item as-is)", async () => {
    const existingUser = { id: "u1", name: "Alice" };
    const docClient = makeDocClient(async (cmd: any) => {
      return { Item: existingUser };
    });

    const config = makeConfig();
    const update = updateMethod(docClient, config);

    const result = await update({
      model: "user",
      where: [{ field: "id", operator: "eq", value: "u1" }],
      update: {},
    });

    expect(result).toEqual(existingUser);
  });

  it("Tier 1: includes ConditionExpression attribute_exists(#pk)", async () => {
    const calls: any[] = [];
    const updatedUser = { id: "u1", name: "Alice Updated" };

    const docClient = makeDocClient(async (cmd: any) => {
      calls.push(cmd);
      return { Attributes: updatedUser };
    });

    const config = makeConfig();
    const update = updateMethod(docClient, config);

    await update({
      model: "user",
      where: [{ field: "id", operator: "eq", value: "u1" }],
      update: { name: "Alice Updated" },
    });

    expect(calls[0].ConditionExpression).toBe("attribute_exists(#pk)");
    expect(calls[0].ExpressionAttributeNames).toHaveProperty("#pk", "id");
  });

  it("strips PK and SK fields from update payload", async () => {
    const calls: any[] = [];
    const updatedUser = { id: "u1", name: "Renamed" };

    const docClient = makeDocClient(async (cmd: any) => {
      calls.push(cmd);
      return { Attributes: updatedUser };
    });

    const config = makeConfig();
    const update = updateMethod(docClient, config);

    await update({
      model: "user",
      where: [{ field: "id", operator: "eq", value: "u1" }],
      update: { id: "should-be-ignored", name: "Renamed" },
    });

    const vals = calls[0].ExpressionAttributeValues;
    const valKeys = Object.keys(vals);
    // Only one value (for "name" — not "id")
    expect(valKeys.length).toBe(1);
    expect(vals[valKeys[0]!]).toBe("Renamed");
    // The attr names should not include "id" as a SET field (only as #pk for condition)
    const attrNames = calls[0].ExpressionAttributeNames;
    const setFields = Object.entries(attrNames)
      .filter(([k]) => k.startsWith("#n"))
      .map(([, v]) => v);
    expect(setFields).not.toContain("id");
  });

  it("strips composite PK and SK fields from update payload", async () => {
    const calls: any[] = [];
    const updatedAccount = {
      id: "acc1",
      providerId: "google",
      accountId: "12345",
      accessToken: "new-token",
    };

    const docClient = makeDocClient(async (cmd: any) => {
      calls.push(cmd);
      return { Attributes: updatedAccount };
    });

    const config = makeConfig();
    const update = updateMethod(docClient, config);

    await update({
      model: "account",
      where: [
        { field: "providerId", operator: "eq", value: "google" },
        { field: "accountId", operator: "eq", value: "12345" },
      ],
      update: {
        providerId: "should-be-ignored",
        accountId: "should-also-be-ignored",
        accessToken: "new-token",
      },
    });

    const vals = calls[0].ExpressionAttributeValues;
    const valKeys = Object.keys(vals);
    // Only accessToken should remain
    expect(valKeys.length).toBe(1);
  });

  it("returns null when ConditionalCheckFailedException is thrown (prevents upsert)", async () => {
    const err: any = new Error("ConditionalCheckFailed");
    err.name = "ConditionalCheckFailedException";

    const docClient = makeDocClient(async (cmd: any) => {
      if (cmd._type === "UpdateCommand") throw err;
      return {};
    });

    const config = makeConfig();
    const update = updateMethod(docClient, config);

    const result = await update({
      model: "user",
      where: [{ field: "id", operator: "eq", value: "u1" }],
      update: { name: "New" },
    });

    expect(result).toBeNull();
  });

  it("converts Date to ISO string in ExpressionAttributeValues", async () => {
    const calls: any[] = [];
    const docClient = makeDocClient(async (cmd: any) => {
      calls.push(cmd);
      return { Attributes: { id: "u1", name: "Bob", updatedAt: "2025-01-01T00:00:00.000Z" } };
    });

    const config = makeConfig();
    const update = updateMethod(docClient, config);
    const testDate = new Date("2025-01-01T00:00:00.000Z");

    await update({
      model: "user",
      where: [{ field: "id", operator: "eq", value: "u1" }],
      update: { name: "Bob", updatedAt: testDate },
    });

    const vals: any = calls[0].ExpressionAttributeValues;
    const valRefs = Object.keys(vals);
    // Should have 2 values (name + updatedAt)
    expect(valRefs.length).toBe(2);
    // Find the value that is the ISO string
    const isoVal = Object.values(vals).find(
      (v: any) => v === "2025-01-01T00:00:00.000Z",
    );
    expect(isoVal).toBe("2025-01-01T00:00:00.000Z");
    // No Date object should be present
    const hasDate = Object.values(vals).some(
      (v: any) => v instanceof Date,
    );
    expect(hasDate).toBe(false);
  });

  it("Tier 3 with multiple matches updates the first item only", async () => {
    const calls: any[] = [];
    const user1 = { id: "u1", name: "Alice" };
    const user2 = { id: "u2", name: "Alice" };

    const docClient = makeDocClient(async (cmd: any) => {
      calls.push(cmd);
      if (cmd._type === "ScanCommand") {
        return { Items: [user1, user2] };
      }
      if (cmd._type === "UpdateCommand") {
        return { Attributes: { ...user1, name: "Alice Renamed" } };
      }
      return {};
    });

    const config = makeConfig();
    const update = updateMethod(docClient, config);

    const result = await update({
      model: "user",
      where: [{ field: "name", operator: "eq", value: "Alice" }],
      update: { name: "Alice Renamed" },
    });

    expect(result).not.toBeNull();
    expect(result!.name).toBe("Alice Renamed");
    // Should update only the first match
    expect(calls[1]._type).toBe("UpdateCommand");
    expect(calls[1].Key).toEqual({ id: "u1" });
  });
});
