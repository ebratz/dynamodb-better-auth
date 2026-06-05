import { describe, it, expect, vi } from "vitest";
import {
  createUserWithEmailUniqueness,
  deleteUserWithEmailRelease,
  updateUserEmailWithUniqueness,
  buildEmailUniquenessActions,
} from "../src/email-uniqueness";
import type { DynamoDBAdapterConfig } from "../src/types";

// Mock the AWS SDK
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  TransactWriteCommand: vi.fn().mockImplementation((input: any) => ({
    ...input,
    _type: "TransactWriteCommand",
  })),
  UpdateCommand: vi.fn().mockImplementation((input: any) => ({
    ...input,
    _type: "UpdateCommand",
  })),
}));

// Mock crypto for deterministic tokens
vi.mock("crypto", () => ({
  randomUUID: () => "00000000-0000-4000-8000-000000000000",
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
      emailLookups: "test-email-lookups",
    },
    enableEmailUniqueness: true,
    ...overrides,
  } as any;
}

describe("email-uniqueness", () => {
  describe("createUserWithEmailUniqueness", () => {
    it("creates user and email-lookup atomically with TransactWriteItems", async () => {
      const calls: any[] = [];
      const docClient = makeDocClient(async (cmd: any) => {
        calls.push(cmd);
        return {};
      });

      const config = makeConfig();
      const userData = { id: "u1", email: "Alice@Example.com", name: "Alice" };

      const result = await createUserWithEmailUniqueness(docClient, config, userData);

      expect(result).toEqual(userData);
      expect(calls.length).toBe(1);
      expect(calls[0]._type).toBe("TransactWriteCommand");

      const items = calls[0].TransactItems;
      expect(items.length).toBe(2);

      // First item: user Put
      expect(items[0].Put.TableName).toBe("test-users");
      expect(items[0].Put.Item).toEqual(userData);
      expect(items[0].Put.ConditionExpression).toContain("attribute_not_exists");

      // Second item: email-lookup Put (lowercase email)
      expect(items[1].Put.TableName).toBe("test-email-lookups");
      expect(items[1].Put.Item.email).toBe("alice@example.com");
      expect(items[1].Put.Item.userId).toBe("u1");
      expect(items[1].Put.ConditionExpression).toContain("attribute_not_exists");

      // ClientRequestToken should be set for idempotency
      expect(calls[0].ClientRequestToken).toBeTruthy();
    });

    it("throws EMAIL_EXISTS when email-lookup Put fails with ConditionalCheckFailed", async () => {
      const docClient = makeDocClient(async (_cmd: any) => {
        const err: any = new Error("Transaction cancelled");
        err.name = "TransactionCanceledException";
        err.CancellationReasons = [
          { Code: "None" },
          { Code: "ConditionalCheckFailed", Message: "The conditional request failed" },
        ];
        throw err;
      });

      const config = makeConfig();

      await expect(
        createUserWithEmailUniqueness(docClient, config, {
          id: "u1",
          email: "taken@test.com",
        }),
      ).rejects.toThrow(/already registered/);
    });

    it("throws CONDITIONAL_CHECK_FAILED when user Put fails (UUID collision)", async () => {
      const docClient = makeDocClient(async (_cmd: any) => {
        const err: any = new Error("Transaction cancelled");
        err.name = "TransactionCanceledException";
        err.CancellationReasons = [
          { Code: "ConditionalCheckFailed" },
          { Code: "None" },
        ];
        throw err;
      });

      const config = makeConfig();

      await expect(
        createUserWithEmailUniqueness(docClient, config, {
          id: "u1",
          email: "test@test.com",
        }),
      ).rejects.toThrow(/User creation failed/);
    });

    it("throws MISSING_TABLE when emailLookups table not configured", async () => {
      const docClient = makeDocClient(async () => ({}));
      const config = makeConfig({
        tables: {
          user: "test-users",
          session: "test-sessions",
          account: "test-accounts",
          verification: "test-verifications",
          // No emailLookups
        },
      } as any);

      await expect(
        createUserWithEmailUniqueness(docClient, config, {
          id: "u1",
          email: "test@test.com",
        }),
      ).rejects.toThrow(/emailLookups/);
    });

    it("lowercases the email in the lookup item", async () => {
      const calls: any[] = [];
      const docClient = makeDocClient(async (cmd: any) => {
        calls.push(cmd);
        return {};
      });

      const config = makeConfig();
      await createUserWithEmailUniqueness(docClient, config, {
        id: "u1",
        email: "UPPERCASE@Example.COM",
      });

      const lookupItem = calls[0].TransactItems[1].Put.Item;
      expect(lookupItem.email).toBe("uppercase@example.com");
    });
  });

  describe("deleteUserWithEmailRelease", () => {
    it("atomically deletes user and email-lookup", async () => {
      const calls: any[] = [];
      const docClient = makeDocClient(async (cmd: any) => {
        calls.push(cmd);
        return {};
      });

      const config = makeConfig();
      const user = { id: "u1", email: "alice@test.com", name: "Alice" };

      await deleteUserWithEmailRelease(docClient, config, user);

      expect(calls.length).toBe(1);
      expect(calls[0]._type).toBe("TransactWriteCommand");

      const items = calls[0].TransactItems;
      expect(items.length).toBe(2);

      // Delete user
      expect(items[0].Delete.TableName).toBe("test-users");
      expect(items[0].Delete.Key).toEqual({ id: "u1" });

      // Delete email-lookup (lowercase)
      expect(items[1].Delete.TableName).toBe("test-email-lookups");
      expect(items[1].Delete.Key).toEqual({ email: "alice@test.com" });
    });

    it("handles user without email gracefully (only deletes user)", async () => {
      const calls: any[] = [];
      const docClient = makeDocClient(async (cmd: any) => {
        calls.push(cmd);
        return {};
      });

      const config = makeConfig();
      // User with no email field (edge case)
      const user = { id: "u1", name: "NoEmail" };

      await deleteUserWithEmailRelease(docClient, config, user);

      const items = calls[0].TransactItems;
      expect(items.length).toBe(1); // Only user delete
      expect(items[0].Delete.Key).toEqual({ id: "u1" });
    });
  });

  describe("updateUserEmailWithUniqueness", () => {
    it("atomically updates user, releases old email, claims new email", async () => {
      const calls: any[] = [];
      const docClient = makeDocClient(async (cmd: any) => {
        calls.push(cmd);
        return {};
      });

      const config = makeConfig();
      const user = { id: "u1", email: "old@test.com", name: "Alice" };
      const patch = { name: "Alice Updated" };

      const result = await updateUserEmailWithUniqueness(
        docClient,
        config,
        user,
        "old@test.com",
        "new@test.com",
        patch,
      );

      expect(result).toEqual({
        id: "u1",
        email: "new@test.com",
        name: "Alice Updated",
      });

      expect(calls.length).toBe(1);
      expect(calls[0]._type).toBe("TransactWriteCommand");

      const items = calls[0].TransactItems;
      expect(items.length).toBe(3);

      // Update user
      expect(items[0].Update.TableName).toBe("test-users");
      expect(items[0].Update.Key).toEqual({ id: "u1" });
      expect(items[0].Update.UpdateExpression).toContain("SET");
      const attrNames = items[0].Update.ExpressionAttributeNames as Record<string, string>;
      expect(Object.values(attrNames)).toContain("name");
      expect(Object.values(attrNames)).toContain("email");
      expect(Object.keys(items[0].Update.ExpressionAttributeValues).length).toBeGreaterThan(0);

      // Delete old email-lookup
      expect(items[1].Delete.TableName).toBe("test-email-lookups");
      expect(items[1].Delete.Key).toEqual({ email: "old@test.com" });

      // Put new email-lookup
      expect(items[2].Put.TableName).toBe("test-email-lookups");
      expect(items[2].Put.Item.email).toBe("new@test.com");
      expect(items[2].Put.Item.userId).toBe("u1");
      expect(items[2].Put.ConditionExpression).toContain("attribute_not_exists");
    });

    it("throws EMAIL_EXISTS when new email is already taken", async () => {
      const docClient = makeDocClient(async (_cmd: any) => {
        const err: any = new Error("Transaction cancelled");
        err.name = "TransactionCanceledException";
        err.CancellationReasons = [
          { Code: "None" },
          { Code: "None" },
          { Code: "ConditionalCheckFailed" }, // new email-lookup
        ];
        throw err;
      });

      const config = makeConfig();

      await expect(
        updateUserEmailWithUniqueness(
          docClient,
          config,
          { id: "u1", email: "old@test.com" },
          "old@test.com",
          "taken@test.com",
          {},
        ),
      ).rejects.toThrow(/already registered/);
    });

    it("succeeds even when old email-lookup row is missing (idempotent delete)", async () => {
      const calls: any[] = [];
      const docClient = makeDocClient(async (cmd: any) => {
        calls.push(cmd);
        return {};
      });

      const config = makeConfig();
      const user = { id: "u1", email: "old@test.com" };

      const result = await updateUserEmailWithUniqueness(
        docClient,
        config,
        user,
        "old@test.com",
        "new@test.com",
        { name: "Updated" },
      );

      // Should complete without throwing — DynamoDB Delete is idempotent
      expect(result).not.toBeNull();
      expect(result.email).toBe("new@test.com");
      // 3 items: Update user, Delete old, Put new
      expect(calls[0].TransactItems.length).toBe(3);
    });
  });

  describe("buildEmailUniquenessActions", () => {
    it("builds create email-lookup action", () => {
      const config = makeConfig();
      const actions = buildEmailUniquenessActions("create", config, {
        data: { id: "u1", email: "Test@Example.com" },
      });

      expect(actions.length).toBe(1);
      expect(actions[0].Put.TableName).toBe("test-email-lookups");
      expect(actions[0].Put.Item.email).toBe("test@example.com");
      expect(actions[0].Put.Item.userId).toBe("u1");
      expect(actions[0].Put.ConditionExpression).toContain("attribute_not_exists");
    });

    it("builds delete email-lookup action", () => {
      const config = makeConfig();
      const actions = buildEmailUniquenessActions("delete", config, {
        user: { id: "u1", email: "Test@Example.com" },
      });

      expect(actions.length).toBe(1);
      expect(actions[0].Delete.TableName).toBe("test-email-lookups");
      expect(actions[0].Delete.Key).toEqual({ email: "test@example.com" });
    });

    it("builds updateEmail actions (delete old + put new)", () => {
      const config = makeConfig();
      const actions = buildEmailUniquenessActions("updateEmail", config, {
        user: { id: "u1" },
        oldEmail: "old@test.com",
        newEmail: "New@Test.com",
      });

      expect(actions.length).toBe(2);
      expect(actions[0].Delete.TableName).toBe("test-email-lookups");
      expect(actions[0].Delete.Key).toEqual({ email: "old@test.com" });
      expect(actions[1].Put.TableName).toBe("test-email-lookups");
      expect(actions[1].Put.Item.email).toBe("new@test.com");
    });

    it("returns empty array when data missing for create", () => {
      const config = makeConfig();
      const actions = buildEmailUniquenessActions("create", config, {
        data: { id: "u1" }, // no email
      });
      expect(actions).toEqual([]);
    });

    it("throws when emailLookups table not configured", () => {
      const config = makeConfig({
        tables: {
          user: "test-users",
          session: "test-sessions",
          account: "test-accounts",
          verification: "test-verifications",
          // No emailLookups
        },
      } as any);

      expect(() =>
        buildEmailUniquenessActions("create", config, {
          data: { id: "u1", email: "test@test.com" },
        }),
      ).toThrow(/emailLookups/);
    });
  });
});
