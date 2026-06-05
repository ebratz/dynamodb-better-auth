import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMethod } from "../src/adapter/methods/create";
import type { DynamoDBAdapterConfig } from "../src/types";

// Mock the AWS SDK
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  PutCommand: vi.fn().mockImplementation((input: any) => ({ ...input, _type: "PutCommand" })),
  GetCommand: vi.fn().mockImplementation((input: any) => ({ ...input, _type: "GetCommand" })),
  QueryCommand: vi.fn().mockImplementation((input: any) => ({ ...input, _type: "QueryCommand" })),
  ScanCommand: vi.fn().mockImplementation((input: any) => ({ ...input, _type: "ScanCommand" })),
  UpdateCommand: vi.fn().mockImplementation((input: any) => ({ ...input, _type: "UpdateCommand" })),
  DeleteCommand: vi.fn().mockImplementation((input: any) => ({ ...input, _type: "DeleteCommand" })),
  BatchGetCommand: vi.fn().mockImplementation((input: any) => ({ ...input, _type: "BatchGetCommand" })),
  BatchWriteCommand: vi.fn().mockImplementation((input: any) => ({ ...input, _type: "BatchWriteCommand" })),
  TransactWriteCommand: vi.fn().mockImplementation((input: any) => ({ ...input, _type: "TransactWriteCommand" })),
}));

// Mock email-uniqueness module — use vi.hoisted to avoid hoisting issue
const { mockCreateWithEmail } = vi.hoisted(() => ({
  mockCreateWithEmail: vi.fn().mockResolvedValue({ id: "u1", email: "test@test.com" }),
}));
vi.mock("../src/email-uniqueness", () => ({
  createUserWithEmailUniqueness: mockCreateWithEmail,
}));

function makeDocClient(sendImpl: (cmd: any) => Promise<any>) {
  const send = vi.fn().mockImplementation(sendImpl);
  return { send, _calls: () => send.mock.calls.map((c: any) => c[0]) } as any;
}

function makeConfig(overrides: Partial<DynamoDBAdapterConfig> = {}): DynamoDBAdapterConfig {
  return {
    client: {} as any,
    tables: {
      user: "test-users",
      session: "test-sessions",
      account: "test-accounts",
      verification: "test-verifications",
      emailLookups: "test-email-lookups",
    },
    ...overrides,
  } as any;
}

beforeEach(() => {
  mockCreateWithEmail.mockClear();
});

describe("create", () => {
  it("creates a user with PutItem + ConditionExpression", async () => {
    const docClient = makeDocClient(async () => ({}));
    const config = makeConfig();
    const create = createMethod(docClient, config);

    const data = { id: "u1", email: "a@b.com", name: "Alice" };
    const result = await create({ model: "user", data });

    expect(result).toEqual(data);
    const [cmd] = docClient._calls();
    expect(cmd.TableName).toBe("test-users");
    expect(cmd.Item).toEqual(data);
    expect(cmd.ConditionExpression).toBeTruthy();
  });

  it("throws on ConditionalCheckFailedException as DynamoAdapterError", async () => {
    const docClient = makeDocClient(async () => {
      const err: any = new Error("Conditional check failed");
      err.name = "ConditionalCheckFailedException";
      throw err;
    });

    const config = makeConfig();
    const create = createMethod(docClient, config);

    await expect(
      create({ model: "user", data: { id: "u1", email: "a@b.com" } })
    ).rejects.toThrow(/already exists/);
  });

  it("creates an account with composite key and attribute_not_exists on PK", async () => {
    const docClient = makeDocClient(async () => ({}));
    const config = makeConfig();
    const create = createMethod(docClient, config);

    const data = {
      id: "acc1",
      providerId: "google",
      accountId: "12345",
      userId: "u1",
    };
    const result = await create({ model: "account", data });

    expect(result).toEqual(data);
    const [cmd] = docClient._calls();
    expect(cmd.ConditionExpression).toContain("attribute_not_exists");
    // PK field is in ExpressionAttributeNames, not the expression string
    expect(Object.keys(cmd.ExpressionAttributeNames).length).toBeGreaterThan(0);
    const attrNames = Object.values(cmd.ExpressionAttributeNames);
    expect(attrNames).toContain("providerId");
  });

  it("delegates to email-uniqueness when enableEmailUniqueness is true and model is user", async () => {
    const docClient = makeDocClient(async () => ({}));
    const config = makeConfig({ enableEmailUniqueness: true });
    const create = createMethod(docClient, config);

    const data = { id: "u1", email: "test@test.com", name: "Alice" };
    const result = await create({ model: "user", data });

    expect(mockCreateWithEmail).toHaveBeenCalledWith(docClient, config, data);
    expect(result).toEqual({ id: "u1", email: "test@test.com" });
  });

  it("does NOT delegate to email-uniqueness on non-user model even when flag is enabled", async () => {
    const docClient = makeDocClient(async () => ({}));
    const config = makeConfig({ enableEmailUniqueness: true });
    const create = createMethod(docClient, config);

    const data = { token: "tok1", userId: "u1" };
    const result = await create({ model: "session", data });

    expect(mockCreateWithEmail).not.toHaveBeenCalled();
    expect(result).toEqual(data);
  });

  it("does NOT delegate to email-uniqueness when data has no email field", async () => {
    const docClient = makeDocClient(async () => ({}));
    const config = makeConfig({ enableEmailUniqueness: true });
    const create = createMethod(docClient, config);

    // User without email — should use standard PutItem
    const data = { id: "u1", name: "No Email User" };
    const result = await create({ model: "user", data });

    expect(mockCreateWithEmail).not.toHaveBeenCalled();
    expect(result).toEqual(data);
  });
});
