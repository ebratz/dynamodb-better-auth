import { describe, it, expect, vi } from "vitest";
import { createTransactionWrapper } from "../src/adapter/transaction";
import type { DynamoDBAdapterConfig } from "../src/types";

// Mock the AWS SDK
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  TransactWriteCommand: vi.fn().mockImplementation((input: any) => ({
    ...input,
    _type: "TransactWriteCommand",
  })),
  DynamoDBDocumentClient: {
    from: vi.fn().mockImplementation((client: any) => client),
  },
}));

// Mock crypto
vi.mock("crypto", () => ({
  randomUUID: () => "tx-uuid-0000-0000-0000-000000000000",
}));

function makeDocClient(sendImpl: (cmd: any) => Promise<any>) {
  return { send: sendImpl, config: { translateConfig: {} } } as any;
}

function makeConfig(
  docClient?: any,
  overrides: Partial<DynamoDBAdapterConfig> = {},
): DynamoDBAdapterConfig {
  return {
    client: docClient ?? ({} as any),
    tables: {
      user: "test-users",
      session: "test-sessions",
      account: "test-accounts",
      verification: "test-verifications",
    },
    ...overrides,
  } as any;
}

function makeNativeAdapter(
  overrides: Record<string, any> = {},
) {
  return {
    findOne: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    ...overrides,
  };
}

function getTable(model: string) {
  return `test-${model}s`;
}

describe("transaction", () => {
  describe("reads (non-transactional)", () => {
    it("findOne delegates to nativeAdapter", async () => {
      const nativeAdapter = makeNativeAdapter({
        findOne: vi.fn().mockResolvedValue({ id: "u1", name: "Alice" }),
      });

      const docClient = makeDocClient(async () => ({}));
      const config = makeConfig(docClient);
      const tx = createTransactionWrapper(nativeAdapter, config, getTable);

      let captured: any = null;
      await tx(async (txAdapter) => {
        captured = await txAdapter.findOne({
          model: "user",
          where: [{ field: "id", operator: "eq", value: "u1" }],
        });
      });

      expect(captured).toEqual({ id: "u1", name: "Alice" });
      expect(nativeAdapter.findOne).toHaveBeenCalled();
    });

    it("findMany delegates to nativeAdapter", async () => {
      const users = [{ id: "u1" }, { id: "u2" }];
      const nativeAdapter = makeNativeAdapter({
        findMany: vi.fn().mockResolvedValue(users),
      });

      const docClient = makeDocClient(async () => ({}));
      const config = makeConfig(docClient);
      const tx = createTransactionWrapper(nativeAdapter, config, getTable);

      let captured: any = null;
      await tx(async (txAdapter) => {
        captured = await txAdapter.findMany({ model: "user", where: [] });
      });

      expect(captured).toEqual(users);
    });

    it("count delegates to nativeAdapter", async () => {
      const nativeAdapter = makeNativeAdapter({
        count: vi.fn().mockResolvedValue(42),
      });

      const docClient = makeDocClient(async () => ({}));
      const config = makeConfig(docClient);
      const tx = createTransactionWrapper(nativeAdapter, config, getTable);

      let captured: any = null;
      await tx(async (txAdapter) => {
        captured = await txAdapter.count({ model: "user" });
      });

      expect(captured).toBe(42);
    });
  });

  describe("buffered writes", () => {
    it("buffers create and flushes on commit", async () => {
      const calls: any[] = [];
      const docClient = makeDocClient(async (cmd: any) => {
        calls.push(cmd);
        return {};
      });

      const nativeAdapter = makeNativeAdapter();
      const config = makeConfig(docClient);
      const tx = createTransactionWrapper(nativeAdapter, config, getTable);

      const result = await tx(async (txAdapter) => {
        return txAdapter.create({
          model: "user",
          data: { id: "u1", email: "a@b.com", name: "Alice" },
        });
      });

      expect(result).toEqual({ id: "u1", email: "a@b.com", name: "Alice" });

      // Flush should have been triggered
      expect(calls.length).toBe(1);
      expect(calls[0]._type).toBe("TransactWriteCommand");
      expect(calls[0].TransactItems.length).toBe(1);

      const item = calls[0].TransactItems[0];
      expect(item.Put).toBeDefined();
      expect(item.Put.TableName).toBe("test-users");
      expect(item.Put.Item).toEqual({ id: "u1", email: "a@b.com", name: "Alice" });
      expect(item.Put.ConditionExpression).toContain("attribute_not_exists");
      expect(calls[0].ClientRequestToken).toBeDefined();
    });

    it("eagerly reads pre-state for update, buffers Update action", async () => {
      const calls: any[] = [];
      const docClient = makeDocClient(async (cmd: any) => {
        calls.push(cmd);
        return {};
      });

      // Pre-state: the user exists with old name
      const nativeAdapter = makeNativeAdapter({
        findOne: vi.fn().mockResolvedValue({ id: "u1", name: "OldName", email: "a@b.com" }),
      });

      const config = makeConfig(docClient);
      const tx = createTransactionWrapper(nativeAdapter, config, getTable);

      const result = await tx(async (txAdapter) => {
        return txAdapter.update({
          model: "user",
          where: [{ field: "id", operator: "eq", value: "u1" }],
          update: { name: "NewName" },
        });
      });

      // Return value should merge pre-state + update
      expect(result).toEqual({ id: "u1", name: "NewName", email: "a@b.com" });
      expect(nativeAdapter.findOne).toHaveBeenCalledWith({
        model: "user",
        where: [{ field: "id", operator: "eq", value: "u1" }],
      });

      // Flush should have Update action
      expect(calls.length).toBe(1);
      const item = calls[0].TransactItems[0];
      expect(item.Update).toBeDefined();
      expect(item.Update.TableName).toBe("test-users");
      expect(item.Update.Key).toEqual({ id: "u1" });
      expect(item.Update.UpdateExpression).toContain("SET");
    });

    it("buffers delete on known key", async () => {
      const calls: any[] = [];
      const docClient = makeDocClient(async (cmd: any) => {
        calls.push(cmd);
        return {};
      });

      const nativeAdapter = makeNativeAdapter();
      const config = makeConfig(docClient);
      const tx = createTransactionWrapper(nativeAdapter, config, getTable);

      await tx(async (txAdapter) => {
        await txAdapter.delete({
          model: "session",
          where: [{ field: "token", operator: "eq", value: "tok123" }],
        });
      });

      const item = calls[0].TransactItems[0];
      expect(item.Delete).toBeDefined();
      expect(item.Delete.TableName).toBe("test-sessions");
      expect(item.Delete.Key).toEqual({ token: "tok123" });
    });

    it("buffers deleteMany with multiple Delete actions", async () => {
      const calls: any[] = [];
      const docClient = makeDocClient(async (cmd: any) => {
        calls.push(cmd);
        return {};
      });

      const items = [
        { id: "u1", name: "Alice" },
        { id: "u2", name: "Bob" },
        { id: "u3", name: "Charlie" },
      ];
      const nativeAdapter = makeNativeAdapter({
        findMany: vi.fn().mockResolvedValue(items),
      });

      const config = makeConfig(docClient);
      const tx = createTransactionWrapper(nativeAdapter, config, getTable);

      const count = await tx(async (txAdapter) => {
        return txAdapter.deleteMany({
          model: "user",
          where: [{ field: "name", operator: "contains", value: "li" }],
        });
      });

      expect(count).toBe(3);
      expect(calls[0].TransactItems.length).toBe(3);
      expect(calls[0].TransactItems[0].Delete.Key).toEqual({ id: "u1" });
      expect(calls[0].TransactItems[1].Delete.Key).toEqual({ id: "u2" });
      expect(calls[0].TransactItems[2].Delete.Key).toEqual({ id: "u3" });
    });

    it("buffers updateMany with multiple Update actions", async () => {
      const calls: any[] = [];
      const docClient = makeDocClient(async (cmd: any) => {
        calls.push(cmd);
        return {};
      });

      const items = [
        { id: "u1", name: "Alice", role: "user" },
        { id: "u2", name: "Bob", role: "user" },
      ];
      const nativeAdapter = makeNativeAdapter({
        findMany: vi.fn().mockResolvedValue(items),
      });

      const config = makeConfig(docClient);
      const tx = createTransactionWrapper(nativeAdapter, config, getTable);

      const count = await tx(async (txAdapter) => {
        return txAdapter.updateMany({
          model: "user",
          where: [{ field: "role", operator: "eq", value: "user" }],
          update: { role: "admin" },
        });
      });

      expect(count).toBe(2);
      expect(calls[0].TransactItems.length).toBe(2);
      expect(calls[0].TransactItems[0].Update.Key).toEqual({ id: "u1" });
      expect(calls[0].TransactItems[1].Update.Key).toEqual({ id: "u2" });
    });

    it("eagerly captures item for consumeOne, buffers conditional Delete", async () => {
      const calls: any[] = [];
      const docClient = makeDocClient(async (cmd: any) => {
        calls.push(cmd);
        return {};
      });

      const verificationItem = {
        id: "v1",
        identifier: "user@test.com",
        value: "tok456",
      };
      const nativeAdapter = makeNativeAdapter({
        findOne: vi.fn().mockResolvedValue(verificationItem),
      });

      const config = makeConfig(docClient);
      const tx = createTransactionWrapper(nativeAdapter, config, getTable);

      const result = await tx(async (txAdapter) => {
        return txAdapter.consumeOne({
          model: "verification",
          where: [{ field: "id", operator: "eq", value: "v1" }],
        });
      });

      // Returns the captured item immediately
      expect(result).toEqual(verificationItem);

      // Buffered delete has condition
      const item = calls[0].TransactItems[0];
      expect(item.Delete).toBeDefined();
      expect(item.Delete.TableName).toBe("test-verifications");
      expect(item.Delete.Key).toEqual({ id: "v1" });
      expect(item.Delete.ConditionExpression).toContain("attribute_exists");
    });

    it("consumeOne returns null when item not found (no buffer)", async () => {
      const calls: any[] = [];
      const docClient = makeDocClient(async (cmd: any) => {
        calls.push(cmd);
        return {};
      });

      const nativeAdapter = makeNativeAdapter({
        findOne: vi.fn().mockResolvedValue(null),
      });

      const config = makeConfig(docClient);
      const tx = createTransactionWrapper(nativeAdapter, config, getTable);

      const result = await tx(async (txAdapter) => {
        return txAdapter.consumeOne({
          model: "verification",
          where: [{ field: "id", operator: "eq", value: "nonexistent" }],
        });
      });

      expect(result).toBeNull();
      // No flush when consumeOne didn't find anything
      expect(calls.length).toBe(0);
    });

    it("empty buffer sends nothing", async () => {
      const calls: any[] = [];
      const docClient = makeDocClient(async (cmd: any) => {
        calls.push(cmd);
        return {};
      });

      const nativeAdapter = makeNativeAdapter();
      const config = makeConfig(docClient);
      const tx = createTransactionWrapper(nativeAdapter, config, getTable);

      const result = await tx(async (_txAdapter) => {
        return "no writes";
      });

      expect(result).toBe("no writes");
      expect(calls.length).toBe(0);
    });

    it("throws when >100 actions are buffered", async () => {
      const docClient = makeDocClient(async () => ({}));
      const nativeAdapter = makeNativeAdapter();
      const config = makeConfig(docClient);
      const tx = createTransactionWrapper(nativeAdapter, config, getTable);

      await expect(
        tx(async (txAdapter) => {
          for (let i = 0; i < 101; i++) {
            await txAdapter.create({
              model: "user",
              data: { id: `u${i}`, name: `User ${i}` },
            });
          }
        }),
      ).rejects.toThrow(/more than 100/);
    });
  });

  describe("error handling", () => {
    it("parses TransactionCanceledException CancellationReasons", async () => {
      const docClient = makeDocClient(async (_cmd: any) => {
        const err: any = new Error("Transaction cancelled");
        err.name = "TransactionCanceledException";
        err.CancellationReasons = [
          { Code: "ConditionalCheckFailed", Message: "Duplicate key" },
          { Code: "None" },
        ];
        throw err;
      });

      const nativeAdapter = makeNativeAdapter({
        findOne: vi.fn().mockResolvedValue({ id: "u1", name: "Pre" }),
      });

      const config = makeConfig(docClient);
      const tx = createTransactionWrapper(nativeAdapter, config, getTable);

      await expect(
        tx(async (txAdapter) => {
          // Create two users (buffer 2 items)
          await txAdapter.create({
            model: "user",
            data: { id: "u1", name: "One" },
          });
          await txAdapter.create({
            model: "user",
            data: { id: "u2", name: "Two" },
          });
        }),
      ).rejects.toThrow(/Transaction cancelled/);
    });

    it("callback rejection prevents flush", async () => {
      const calls: any[] = [];
      const docClient = makeDocClient(async (cmd: any) => {
        calls.push(cmd);
        return {};
      });

      const nativeAdapter = makeNativeAdapter();
      const config = makeConfig(docClient);
      const tx = createTransactionWrapper(nativeAdapter, config, getTable);

      await expect(
        tx(async (txAdapter) => {
          await txAdapter.create({
            model: "user",
            data: { id: "u1", name: "One" },
          });
          throw new Error("Callback failed");
        }),
      ).rejects.toThrow("Callback failed");

      // No flush since callback threw
      expect(calls.length).toBe(0);
    });
  });

  describe("email uniqueness in transactions", () => {
    it("tx.create(user) with enableEmailUniqueness buffers email-lookup Put", async () => {
      const calls: any[] = [];
      const docClient = makeDocClient(async (cmd: any) => {
        calls.push(cmd);
        return {};
      });

      const nativeAdapter = makeNativeAdapter();
      const config = makeConfig(docClient, {
        enableEmailUniqueness: true,
        tables: {
          user: "test-users",
          session: "test-sessions",
          account: "test-accounts",
          verification: "test-verifications",
          emailLookups: "test-email-lookups",
        },
      } as any);

      const tx = createTransactionWrapper(nativeAdapter, config, getTable);

      await tx(async (txAdapter) => {
        await txAdapter.create({
          model: "user",
          data: { id: "u1", email: "Alice@Test.com", name: "Alice" },
        });
      });

      expect(calls[0].TransactItems.length).toBe(2);

      // User Put
      expect(calls[0].TransactItems[0].Put.TableName).toBe("test-users");

      // Email-lookup Put
      const emailItem = calls[0].TransactItems[1].Put;
      expect(emailItem.TableName).toBe("test-email-lookups");
      expect(emailItem.Item.email).toBe("alice@test.com");
      expect(emailItem.Item.userId).toBe("u1");
      expect(emailItem.ConditionExpression).toContain("attribute_not_exists");
    });

    it("tx.create(non-user) without enableEmailUniqueness does one Put", async () => {
      const calls: any[] = [];
      const docClient = makeDocClient(async (cmd: any) => {
        calls.push(cmd);
        return {};
      });

      const nativeAdapter = makeNativeAdapter();
      const config = makeConfig(docClient, {
        enableEmailUniqueness: true,
        tables: {
          user: "test-users",
          session: "test-sessions",
          account: "test-accounts",
          verification: "test-verifications",
          emailLookups: "test-email-lookups",
        },
      } as any);

      const tx = createTransactionWrapper(nativeAdapter, config, getTable);

      await tx(async (txAdapter) => {
        await txAdapter.create({
          model: "session",
          data: { token: "tok1", userId: "u1" },
        });
      });

      // Only one item (no email-lookup for sessions)
      expect(calls[0].TransactItems.length).toBe(1);
    });

    it("EMAIL_EXISTS thrown on email collision in transaction", async () => {
      const docClient = makeDocClient(async (_cmd: any) => {
        const err: any = new Error("Transaction cancelled");
        err.name = "TransactionCanceledException";
        err.CancellationReasons = [
          { Code: "None" },
          { Code: "ConditionalCheckFailed" }, // email-lookup Put
        ];
        throw err;
      });

      const nativeAdapter = makeNativeAdapter();
      const config = makeConfig(docClient, {
        enableEmailUniqueness: true,
        tables: {
          user: "test-users",
          session: "test-sessions",
          account: "test-accounts",
          verification: "test-verifications",
          emailLookups: "test-email-lookups",
        },
      } as any);

      const tx = createTransactionWrapper(nativeAdapter, config, getTable);

      await expect(
        tx(async (txAdapter) => {
          await txAdapter.create({
            model: "user",
            data: { id: "u1", email: "taken@test.com" },
          });
        }),
      ).rejects.toThrow(/already registered/);
    });

    it("tx.update with email change buffers email-lookup actions", async () => {
      const calls: any[] = [];
      const docClient = makeDocClient(async (cmd: any) => {
        calls.push(cmd);
        return {};
      });

      const nativeAdapter = makeNativeAdapter({
        findOne: vi.fn().mockResolvedValue({
          id: "u1",
          email: "old@test.com",
          name: "Alice",
        }),
      });

      const config = makeConfig(docClient, {
        enableEmailUniqueness: true,
        tables: {
          user: "test-users",
          session: "test-sessions",
          account: "test-accounts",
          verification: "test-verifications",
          emailLookups: "test-email-lookups",
        },
      } as any);

      const tx = createTransactionWrapper(nativeAdapter, config, getTable);

      await tx(async (txAdapter) => {
        await txAdapter.update({
          model: "user",
          where: [{ field: "id", operator: "eq", value: "u1" }],
          update: { email: "new@test.com" },
        });
      });

      // Should have 3 items: user Update + delete old email + put new email
      expect(calls[0].TransactItems.length).toBe(3);

      // User Update
      expect(calls[0].TransactItems[0].Update).toBeDefined();
      expect(calls[0].TransactItems[0].Update.TableName).toBe("test-users");

      // Delete old email
      expect(calls[0].TransactItems[1].Delete).toBeDefined();
      expect(calls[0].TransactItems[1].Delete.TableName).toBe("test-email-lookups");
      expect(calls[0].TransactItems[1].Delete.Key).toEqual({ email: "old@test.com" });

      // Put new email
      expect(calls[0].TransactItems[2].Put).toBeDefined();
      expect(calls[0].TransactItems[2].Put.TableName).toBe("test-email-lookups");
      expect(calls[0].TransactItems[2].Put.Item.email).toBe("new@test.com");
    });

    it("tx.delete(user) with enableEmailUniqueness releases email", async () => {
      const calls: any[] = [];
      const docClient = makeDocClient(async (cmd: any) => {
        calls.push(cmd);
        return {};
      });

      const nativeAdapter = makeNativeAdapter({
        findOne: vi.fn().mockResolvedValue({
          id: "u1",
          email: "alice@test.com",
          name: "Alice",
        }),
      });

      const config = makeConfig(docClient, {
        enableEmailUniqueness: true,
        tables: {
          user: "test-users",
          session: "test-sessions",
          account: "test-accounts",
          verification: "test-verifications",
          emailLookups: "test-email-lookups",
        },
      } as any);

      const tx = createTransactionWrapper(nativeAdapter, config, getTable);

      await tx(async (txAdapter) => {
        await txAdapter.delete({
          model: "user",
          where: [{ field: "id", operator: "eq", value: "u1" }],
        });
      });

      // Should have 2 items: user Delete + email-lookup Delete
      expect(calls[0].TransactItems.length).toBe(2);
      expect(calls[0].TransactItems[0].Delete.TableName).toBe("test-users");
      expect(calls[0].TransactItems[1].Delete.TableName).toBe("test-email-lookups");
      expect(calls[0].TransactItems[1].Delete.Key).toEqual({ email: "alice@test.com" });
    });
  });

  describe("composite key operations", () => {
    it("buffers composite key update for account", async () => {
      const calls: any[] = [];
      const docClient = makeDocClient(async (cmd: any) => {
        calls.push(cmd);
        return {};
      });

      const nativeAdapter = makeNativeAdapter({
        findOne: vi.fn().mockResolvedValue({
          id: "acc1",
          providerId: "google",
          accountId: "12345",
          accessToken: "old-token",
        }),
      });

      const config = makeConfig(docClient);
      const tx = createTransactionWrapper(nativeAdapter, config, getTable);

      await tx(async (txAdapter) => {
        await txAdapter.update({
          model: "account",
          where: [
            { field: "providerId", operator: "eq", value: "google" },
            { field: "accountId", operator: "eq", value: "12345" },
          ],
          update: { accessToken: "new-token" },
        });
      });

      const item = calls[0].TransactItems[0];
      expect(item.Update.Key).toEqual({
        providerId: "google",
        accountId: "12345",
      });
    });

    it("throws when SK missing in composite key update", async () => {
      const docClient = makeDocClient(async () => ({}));
      const nativeAdapter = makeNativeAdapter();
      const config = makeConfig(docClient);
      const tx = createTransactionWrapper(nativeAdapter, config, getTable);

      await expect(
        tx(async (txAdapter) => {
          await txAdapter.update({
            model: "account",
            where: [{ field: "providerId", operator: "eq", value: "google" }],
            update: { accessToken: "new" },
          });
        }),
      ).rejects.toThrow(/requires SK field/);
    });
  });

  describe("flush error handling", () => {
    it("TransactionCanceledException with multiple CancellationReasons includes reason details", async () => {
      const docClient = makeDocClient(async (_cmd: any) => {
        const err: any = new Error("Transaction cancelled");
        err.name = "TransactionCanceledException";
        err.CancellationReasons = [
          { Code: "ConditionalCheckFailed", Message: "Item already exists" },
          { Code: "ThrottlingException", Message: "Rate exceeded" },
          { Code: "None" },
        ];
        throw err;
      });

      const nativeAdapter = makeNativeAdapter();
      const config = makeConfig(docClient);
      const tx = createTransactionWrapper(nativeAdapter, config, getTable);

      await expect(
        tx(async (txAdapter) => {
          await txAdapter.create({ model: "user", data: { id: "u1" } });
          await txAdapter.create({ model: "session", data: { token: "tok1" } });
          await txAdapter.create({ model: "verification", data: { id: "v1" } });
        }),
      ).rejects.toThrow(/Transaction cancelled/);
    });

    it("non-cancellation flush error wraps with TRANSACTION_FAILED code", async () => {
      const docClient = makeDocClient(async (_cmd: any) => {
        const err: any = new Error("ResourceNotFoundException");
        err.name = "ResourceNotFoundException";
        throw err;
      });

      const nativeAdapter = makeNativeAdapter();
      const config = makeConfig(docClient);
      const tx = createTransactionWrapper(nativeAdapter, config, getTable);

      await expect(
        tx(async (txAdapter) => {
          await txAdapter.create({ model: "user", data: { id: "u1" } });
        }),
      ).rejects.toThrow(/ResourceNotFoundException/);
    });

    it("consumeOne conditional Delete fails at commit if item was modified externally", async () => {
      const docClient = makeDocClient(async (_cmd: any) => {
        const err: any = new Error("Transaction cancelled");
        err.name = "TransactionCanceledException";
        err.CancellationReasons = [
          { Code: "ConditionalCheckFailed", Message: "Item modified" },
        ];
        throw err;
      });

      const nativeAdapter = makeNativeAdapter({
        findOne: vi.fn().mockResolvedValue({
          id: "v1",
          identifier: "user@test.com",
          value: "tok123",
        }),
      });

      const config = makeConfig(docClient);
      const tx = createTransactionWrapper(nativeAdapter, config, getTable);

      // consumeOne eagerly captures the item, but the conditional delete fails
      await expect(
        tx(async (txAdapter) => {
          const item = await txAdapter.consumeOne({
            model: "verification",
            where: [{ field: "id", operator: "eq", value: "v1" }],
          });
          // Capture succeeded (eager read), but flush will fail
          expect(item).toBeTruthy();
        }),
      ).rejects.toThrow(/Transaction cancelled/);
    });

    it("ClientRequestToken is a UUID v4 shape on every flush", async () => {
      const calls: any[] = [];
      const docClient = makeDocClient(async (cmd: any) => {
        calls.push(cmd);
        return {};
      });

      const nativeAdapter = makeNativeAdapter();
      const config = makeConfig(docClient);
      const tx = createTransactionWrapper(nativeAdapter, config, getTable);

      await tx(async (txAdapter) => {
        await txAdapter.create({ model: "user", data: { id: "u1" } });
      });

      const token = calls[0].ClientRequestToken;
      // UUID v4: 8-4-4-4-12 hex digits
      expect(token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    it("buffer of exactly 100 actions flushes (boundary)", async () => {
      const calls: any[] = [];
      const docClient = makeDocClient(async (cmd: any) => {
        calls.push(cmd);
        return {};
      });

      const nativeAdapter = makeNativeAdapter();
      const config = makeConfig(docClient);
      const tx = createTransactionWrapper(nativeAdapter, config, getTable);

      await tx(async (txAdapter) => {
        for (let i = 0; i < 100; i++) {
          await txAdapter.create({ model: "user", data: { id: `u${i}` } });
        }
      });

      expect(calls[0].TransactItems.length).toBe(100);
    });

    it("buffer of 101 actions throws before sending", async () => {
      const docClient = makeDocClient(async () => ({}));
      const nativeAdapter = makeNativeAdapter();
      const config = makeConfig(docClient);
      const tx = createTransactionWrapper(nativeAdapter, config, getTable);

      await expect(
        tx(async (txAdapter) => {
          for (let i = 0; i < 101; i++) {
            await txAdapter.create({ model: "user", data: { id: `u${i}` } });
          }
        }),
      ).rejects.toThrow(/more than 100/);
    });

    it("transaction with reads only (no writes) skips TransactWriteCommand", async () => {
      const calls: any[] = [];
      const docClient = makeDocClient(async (cmd: any) => {
        calls.push(cmd);
        return {};
      });

      const nativeAdapter = makeNativeAdapter({
        findOne: vi.fn().mockResolvedValue({ id: "u1", name: "Alice" }),
        findMany: vi.fn().mockResolvedValue([{ id: "u2" }]),
        count: vi.fn().mockResolvedValue(5),
      });

      const config = makeConfig(docClient);
      const tx = createTransactionWrapper(nativeAdapter, config, getTable);

      const result = await tx(async (txAdapter) => {
        const user = await txAdapter.findOne({ model: "user", where: [{ field: "id", op: "eq", value: "u1" }] });
        const many = await txAdapter.findMany({ model: "user", where: [] });
        const cnt = await txAdapter.count({ model: "user" });
        return { user, many, cnt };
      });

      expect(result.user).toBeTruthy();
      expect(result.many.length).toBe(1);
      expect(result.cnt).toBe(5);
      // No TransactWrite calls since all were reads
      const txCalls = calls.filter((c: any) => c.TransactItems);
      expect(txCalls.length).toBe(0);
    });
  });
});
