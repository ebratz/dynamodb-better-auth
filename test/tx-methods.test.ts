/**
 * Direct unit tests for extracted tx-* handler modules.
 *
 * Each handler takes (ctx: TransactionContext, args) and pushes actions
 * to ctx.writeBuffer. No AWS SDK calls are made by handlers — they only
 * populate the buffer and return values. This file tests each handler
 * in isolation against its documented contract.
 */

import { describe, it, expect, vi } from "vitest";
import type { TransactionContext, TransactionFactoryHelpers } from "../src/adapter/tx-types";
import type { DynamoDBAdapterConfig } from "../src/types";

// Mock the AWS SDK to align with transaction.test.ts — the tx-* handlers
// transitively import email-uniqueness.ts which imports @aws-sdk/lib-dynamodb.
// Without this mock, the real module leaks into the module cache and breaks
// transaction.test.ts when the full suite runs.
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  TransactWriteCommand: vi.fn().mockImplementation((input: any) => ({
    ...input,
    _type: "TransactWriteCommand",
  })),
  DynamoDBDocumentClient: {
    from: vi.fn().mockImplementation((client: any) => client),
  },
}));

import { txCreate } from "../src/adapter/tx-create";
import { txUpdate } from "../src/adapter/tx-update";
import { txDelete } from "../src/adapter/tx-delete";
import { txUpdateMany } from "../src/adapter/tx-update-many";
import { txDeleteMany } from "../src/adapter/tx-delete-many";
import { txConsumeOne } from "../src/adapter/tx-consume-one";

// ── Helpers ────────────────────────────────────────────────────

function identityHelpers(): TransactionFactoryHelpers {
  return {
    transformInput: async (data) => data as Record<string, unknown>,
    transformOutput: async (data) => data as Record<string, unknown>,
    getDefaultModelName: (model) => model,
  };
}

function getTable(model: string): string {
  return `test-${model}s`;
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

function makeCtx(overrides: Partial<{
  writeBuffer: any[];
  findOneResult: any;
  findManyResult: any[];
  config: Partial<DynamoDBAdapterConfig>;
  helpers: TransactionFactoryHelpers;
}> = {}): TransactionContext {
  const findOneFn = vi.fn().mockResolvedValue(
    "findOneResult" in overrides ? overrides.findOneResult : null,
  );
  const findManyFn = vi.fn().mockResolvedValue(overrides.findManyResult ?? []);

  return {
    writeBuffer: overrides.writeBuffer ?? [],
    nativeAdapter: {
      findOne: findOneFn,
      findMany: findManyFn,
      count: vi.fn().mockResolvedValue(0),
    },
    config: makeConfig(overrides.config),
    getTable,
    getHelpers: () => overrides.helpers ?? identityHelpers(),
    hasEmailUniqueness: { value: false },
  };
}

const emailUniquenessConfig = () =>
  makeConfig({
    enableEmailUniqueness: true,
    tables: {
      user: "test-users",
      session: "test-sessions",
      account: "test-accounts",
      verification: "test-verifications",
      emailLookups: "test-email-lookups",
    },
  });

// ── Tests ──────────────────────────────────────────────────────

describe("tx-methods", () => {
  // ══════════════════════════════════════════════════════════════
  // tx-create
  // ══════════════════════════════════════════════════════════════
  describe("txCreate", () => {
    it("pushes a single Put item with correct TableName, Item, ConditionExpression", async () => {
      const ctx = makeCtx();

      const result = await txCreate(ctx, {
        model: "user",
        data: { id: "u1", email: "a@b.com", name: "Alice" },
      });

      expect(result).toEqual({ id: "u1", email: "a@b.com", name: "Alice" });
      expect(ctx.writeBuffer.length).toBe(1);

      const put = ctx.writeBuffer[0].Put;
      expect(put.TableName).toBe("test-users");
      expect(put.Item).toEqual({ id: "u1", email: "a@b.com", name: "Alice" });
      expect(put.ConditionExpression).toBe("attribute_not_exists(#pk)");
      expect(put.ExpressionAttributeNames).toEqual({ "#pk": "id" });
    });

    it("pushes email-lookup Put when enableEmailUniqueness + model=user + data.email", async () => {
      const ctx = makeCtx({ config: emailUniquenessConfig() });

      await txCreate(ctx, {
        model: "user",
        data: { id: "u1", email: "Alice@Example.com", name: "Alice" },
      });

      // User Put + email-lookup Put
      expect(ctx.writeBuffer.length).toBe(2);
      expect(ctx.writeBuffer[0].Put.TableName).toBe("test-users");

      const emailPut = ctx.writeBuffer[1].Put;
      expect(emailPut.TableName).toBe("test-email-lookups");
      expect(emailPut.Item.email).toBe("alice@example.com");
      expect(emailPut.Item.userId).toBe("u1");
      expect(emailPut.ConditionExpression).toContain("attribute_not_exists");
    });

    it("sets hasEmailUniqueness.value = true when applicable", async () => {
      const ctx = makeCtx({ config: emailUniquenessConfig() });

      await txCreate(ctx, {
        model: "user",
        data: { id: "u1", email: "x@y.com" },
      });

      expect(ctx.hasEmailUniqueness.value).toBe(true);
    });

    it("throws TRANSACTION_FAILED when buffer capacity exceeded", async () => {
      // Pre-fill buffer to 100
      const writeBuffer = new Array(100).fill({ Placeholder: true });
      const ctx = makeCtx({ writeBuffer });

      await expect(
        txCreate(ctx, { model: "user", data: { id: "u1", name: "New" } }),
      ).rejects.toThrow(/more than 100/);
    });

    it("does NOT push email-lookup when model is not user", async () => {
      const ctx = makeCtx({ config: emailUniquenessConfig() });

      await txCreate(ctx, {
        model: "session",
        data: { token: "tok1", userId: "u1" },
      });

      expect(ctx.writeBuffer.length).toBe(1);
      expect(ctx.writeBuffer[0].Put.TableName).toBe("test-sessions");
    });

    it("calls transformInput and transformOutput with correct args", async () => {
      const transformInput = vi.fn().mockImplementation(async (data: any) => ({
        ...data, _transformed: true,
      }));
      const transformOutput = vi.fn().mockImplementation(async (data: any) => ({
        ...data, _outputTransformed: true,
      }));
      const helpers: TransactionFactoryHelpers = {
        ...identityHelpers(),
        transformInput,
        transformOutput,
      };

      const ctx = makeCtx({ helpers });
      const result = await txCreate(ctx, {
        model: "user",
        data: { id: "u1", name: "Alice" },
        select: ["id", "name"],
      });

      expect(transformInput).toHaveBeenCalledWith(
        { id: "u1", name: "Alice" },
        "user",
        "create",
        true, // forceAllowId default
      );
      expect(transformOutput).toHaveBeenCalledWith(
        expect.objectContaining({ _transformed: true }),
        "user",
        ["id", "name"],
      );
      expect(result).toEqual({ id: "u1", name: "Alice", _transformed: true, _outputTransformed: true });
    });
  });

  // ══════════════════════════════════════════════════════════════
  // tx-update
  // ══════════════════════════════════════════════════════════════
  describe("txUpdate", () => {
    const preState = { id: "u1", name: "OldName", email: "old@test.com" };
    const where = [{ field: "id", operator: "eq", value: "u1" }];

    it("reads preState via findOne and pushes an Update with SET clauses and ConditionExpression", async () => {
      const ctx = makeCtx({ findOneResult: { ...preState } });

      const result = await txUpdate(ctx, {
        model: "user",
        where,
        update: { name: "NewName" },
      });

      expect(ctx.nativeAdapter.findOne).toHaveBeenCalledWith({ model: "user", where });
      expect(ctx.writeBuffer.length).toBe(1);

      const upd = ctx.writeBuffer[0].Update;
      expect(upd.TableName).toBe("test-users");
      expect(upd.Key).toEqual({ id: "u1" });
      expect(upd.UpdateExpression).toContain("SET");
      expect(upd.ConditionExpression).toBe("attribute_exists(#pk)");

      // Return value merges preState + update
      expect(result).toEqual({ id: "u1", name: "NewName", email: "old@test.com" });
    });

    it("handles email change: pushes Update + email-lookup Delete + email-lookup Put", async () => {
      const ctx = makeCtx({
        findOneResult: { ...preState },
        config: emailUniquenessConfig(),
      });

      await txUpdate(ctx, {
        model: "user",
        where,
        update: { email: "new@test.com" },
      });

      // 3 items: user Update + delete old email + put new email
      expect(ctx.writeBuffer.length).toBe(3);

      expect(ctx.writeBuffer[0].Update.TableName).toBe("test-users");
      expect(ctx.writeBuffer[1].Delete.TableName).toBe("test-email-lookups");
      expect(ctx.writeBuffer[1].Delete.Key).toEqual({ email: "old@test.com" });
      expect(ctx.writeBuffer[2].Put.TableName).toBe("test-email-lookups");
      expect(ctx.writeBuffer[2].Put.Item.email).toBe("new@test.com");
    });

    it("sets hasEmailUniqueness.value = true on email change", async () => {
      const ctx = makeCtx({
        findOneResult: { ...preState },
        config: emailUniquenessConfig(),
      });

      await txUpdate(ctx, {
        model: "user",
        where,
        update: { email: "new@test.com" },
      });

      expect(ctx.hasEmailUniqueness.value).toBe(true);
    });

    it("returns null and buffers nothing when preState is null", async () => {
      const ctx = makeCtx({ findOneResult: null });

      const result = await txUpdate(ctx, {
        model: "user",
        where,
        update: { name: "NewName" },
      });

      // Missing row: null, no doomed conditional Update buffered.
      expect(result).toBeNull();
      expect(ctx.writeBuffer.length).toBe(0);
    });

    it("returns null and buffers nothing when preState is undefined", async () => {
      const ctx = makeCtx({ findOneResult: undefined });

      const result = await txUpdate(ctx, {
        model: "user",
        where,
        update: { name: "NewName" },
      });

      expect(result).toBeNull();
      expect(ctx.writeBuffer.length).toBe(0);
    });

    it("throws TRANSACTION_FAILED when buffer capacity exceeded", async () => {
      const writeBuffer = new Array(100).fill({ Placeholder: true });
      const ctx = makeCtx({ writeBuffer, findOneResult: { ...preState } });

      await expect(
        txUpdate(ctx, { model: "user", where, update: { name: "N" } }),
      ).rejects.toThrow(/more than 100/);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // tx-delete
  // ══════════════════════════════════════════════════════════════
  describe("txDelete", () => {
    const where = [{ field: "id", operator: "eq", value: "u1" }];

    it("pushes a Delete item with correct Key", async () => {
      const ctx = makeCtx();

      await txDelete(ctx, { model: "user", where });

      expect(ctx.writeBuffer.length).toBe(1);
      expect(ctx.writeBuffer[0].Delete.TableName).toBe("test-users");
      expect(ctx.writeBuffer[0].Delete.Key).toEqual({ id: "u1" });
    });

    it("pushes email-lookup Delete when enableEmailUniqueness + model=user + user has email", async () => {
      const ctx = makeCtx({
        findOneResult: { id: "u1", email: "bob@test.com" },
        config: emailUniquenessConfig(),
      });

      await txDelete(ctx, { model: "user", where });

      // User Delete + email-lookup Delete
      expect(ctx.writeBuffer.length).toBe(2);
      expect(ctx.writeBuffer[0].Delete.TableName).toBe("test-users");
      expect(ctx.writeBuffer[1].Delete.TableName).toBe("test-email-lookups");
      expect(ctx.writeBuffer[1].Delete.Key).toEqual({ email: "bob@test.com" });
    });

    it("sets hasEmailUniqueness.value = true when model is user", async () => {
      const ctx = makeCtx({
        findOneResult: { id: "u1", email: "a@b.com" },
        config: emailUniquenessConfig(),
      });

      await txDelete(ctx, { model: "user", where });

      expect(ctx.hasEmailUniqueness.value).toBe(true);
    });

    it("does NOT push email-lookup when findOne returns user without email", async () => {
      const ctx = makeCtx({
        findOneResult: { id: "u1", name: "NoEmail" },
        config: emailUniquenessConfig(),
      });

      await txDelete(ctx, { model: "user", where });

      // Only user Delete (buildEmailUniquenessActions returns [] when no email)
      expect(ctx.writeBuffer.length).toBe(1);
      expect(ctx.writeBuffer[0].Delete.TableName).toBe("test-users");
    });

    it("throws TRANSACTION_FAILED when buffer capacity exceeded", async () => {
      const writeBuffer = new Array(100).fill({ Placeholder: true });
      const ctx = makeCtx({ writeBuffer });

      await expect(
        txDelete(ctx, { model: "user", where }),
      ).rejects.toThrow(/more than 100/);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // tx-update-many
  // ══════════════════════════════════════════════════════════════
  describe("txUpdateMany", () => {
    const items = [
      { id: "u1", name: "Alice", role: "user" },
      { id: "u2", name: "Bob", role: "user" },
    ];

    it("reads items via findMany (limit: 1001) and pushes one Update per item with attribute_exists guard", async () => {
      const ctx = makeCtx({ findManyResult: items });

      const count = await txUpdateMany(ctx, {
        model: "user",
        where: [{ field: "role", operator: "eq", value: "user" }],
        update: { role: "admin" },
      });

      expect(count).toBe(2);
      expect(ctx.nativeAdapter.findMany).toHaveBeenCalledWith({
        model: "user",
        where: [{ field: "role", operator: "eq", value: "user" }],
        limit: 1001,
      });
      expect(ctx.writeBuffer.length).toBe(2);

      // Each item gets its own Update, guarded against upsert-resurrection
      expect(ctx.writeBuffer[0].Update.Key).toEqual({ id: "u1" });
      expect(ctx.writeBuffer[0].Update.TableName).toBe("test-users");
      expect(ctx.writeBuffer[0].Update.UpdateExpression).toContain("SET");
      expect(ctx.writeBuffer[0].Update.ConditionExpression).toBe("attribute_exists(#pk)");
      expect(ctx.writeBuffer[0].Update.ExpressionAttributeNames).toMatchObject({ "#pk": "id" });

      expect(ctx.writeBuffer[1].Update.Key).toEqual({ id: "u2" });
    });

    it("returns 0 when findMany returns empty array", async () => {
      const ctx = makeCtx({ findManyResult: [] });

      const count = await txUpdateMany(ctx, {
        model: "user",
        where: [{ field: "role", operator: "eq", value: "nobody" }],
        update: { role: "admin" },
      });

      expect(count).toBe(0);
      expect(ctx.writeBuffer.length).toBe(0);
    });

    it("returns items.length for the count", async () => {
      const ctx = makeCtx({ findManyResult: items });

      const count = await txUpdateMany(ctx, {
        model: "user",
        where: [],
        update: { flag: true },
      });

      expect(count).toBe(2);
    });

    it("throws TRANSACTION_FAILED when buffer + items.length > 100", async () => {
      const writeBuffer = new Array(98).fill({ Placeholder: true });
      const ctx = makeCtx({ writeBuffer, findManyResult: items }); // 98 + 2 = 100 OK

      // 98 + 2 = 100, which is exactly at limit. assertTransactionCapacity checks > 100.
      // Let's test with 99 + 2 = 101
      const writeBuffer2 = new Array(99).fill({ Placeholder: true });
      const ctx2 = makeCtx({ writeBuffer: writeBuffer2, findManyResult: items });

      await expect(
        txUpdateMany(ctx2, { model: "user", where: [], update: { x: true } }),
      ).rejects.toThrow(/more than 100/);
    });

    it("throws TOO_MANY_ITEMS when findMany returns more than maxUpdateManyItems (1001)", async () => {
      const manyItems = Array.from({ length: 1001 }, (_, i) => ({ id: `u${i}` }));
      const ctx = makeCtx({ findManyResult: manyItems });

      await expect(
        txUpdateMany(ctx, {
          model: "user",
          where: [{ field: "role", operator: "eq", value: "user" }],
          update: { role: "admin" },
        }),
      ).rejects.toMatchObject({ code: "TOO_MANY_ITEMS" });

      // Guard fires before any Update is pushed.
      expect(ctx.writeBuffer.length).toBe(0);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // tx-delete-many
  // ══════════════════════════════════════════════════════════════
  describe("txDeleteMany", () => {
    const items = [
      { id: "u1", name: "Alice" },
      { id: "u2", name: "Bob" },
      { id: "u3", name: "Charlie" },
    ];

    it("returns 0 immediately for empty where", async () => {
      const ctx = makeCtx();

      const count = await txDeleteMany(ctx, {
        model: "user",
        where: [],
      });

      expect(count).toBe(0);
      // Must not have called findMany
      expect(ctx.nativeAdapter.findMany).not.toHaveBeenCalled();
      expect(ctx.writeBuffer.length).toBe(0);
    });

    it("returns 0 immediately for undefined where", async () => {
      const ctx = makeCtx();

      const count = await txDeleteMany(ctx, {
        model: "user",
        where: undefined as any,
      });

      expect(count).toBe(0);
      expect(ctx.nativeAdapter.findMany).not.toHaveBeenCalled();
    });

    it("reads items via findMany and pushes one Delete per item", async () => {
      const ctx = makeCtx({ findManyResult: items });

      const count = await txDeleteMany(ctx, {
        model: "user",
        where: [{ field: "name", operator: "contains", value: "li" }],
      });

      expect(count).toBe(3);
      expect(ctx.writeBuffer.length).toBe(3);

      expect(ctx.writeBuffer[0].Delete.TableName).toBe("test-users");
      expect(ctx.writeBuffer[0].Delete.Key).toEqual({ id: "u1" });
      expect(ctx.writeBuffer[1].Delete.Key).toEqual({ id: "u2" });
      expect(ctx.writeBuffer[2].Delete.Key).toEqual({ id: "u3" });
    });

    it("returns 0 when findMany returns empty", async () => {
      const ctx = makeCtx({ findManyResult: [] });

      const count = await txDeleteMany(ctx, {
        model: "user",
        where: [{ field: "role", operator: "eq", value: "nobody" }],
      });

      expect(count).toBe(0);
      expect(ctx.writeBuffer.length).toBe(0);
    });

    it("throws TRANSACTION_FAILED when buffer + items.length > 100", async () => {
      const writeBuffer = new Array(99).fill({ Placeholder: true });
      const ctx = makeCtx({ writeBuffer, findManyResult: items }); // 99 + 3 = 102

      await expect(
        txDeleteMany(ctx, { model: "user", where: [{ field: "x", value: "y" }] }),
      ).rejects.toThrow(/more than 100/);
    });
  });

  // ══════════════════════════════════════════════════════════════
  // tx-consume-one
  // ══════════════════════════════════════════════════════════════
  describe("txConsumeOne", () => {
    const item = { id: "v1", identifier: "user@test.com", value: "tok456" };

    it("reads item eagerly via findOne and returns it", async () => {
      const ctx = makeCtx({ findOneResult: { ...item } });

      const result = await txConsumeOne(ctx, {
        model: "verification",
        where: [{ field: "id", operator: "eq", value: "v1" }],
      });

      expect(result).toEqual(item);
      expect(ctx.nativeAdapter.findOne).toHaveBeenCalledWith({
        model: "verification",
        where: [{ field: "id", operator: "eq", value: "v1" }],
      });
    });

    it("returns null when findOne returns null", async () => {
      const ctx = makeCtx({ findOneResult: null });

      const result = await txConsumeOne(ctx, {
        model: "verification",
        where: [{ field: "id", operator: "eq", value: "nonexistent" }],
      });

      expect(result).toBeNull();
      // No items pushed when nothing found
      expect(ctx.writeBuffer.length).toBe(0);
    });

    it("pushes email-lookup Delete when enableEmailUniqueness + model=user", async () => {
      const userItem = { id: "u1", email: "carol@test.com", name: "Carol" };
      const ctx = makeCtx({
        findOneResult: { ...userItem },
        config: emailUniquenessConfig(),
      });

      await txConsumeOne(ctx, {
        model: "user",
        where: [{ field: "id", operator: "eq", value: "u1" }],
      });

      // email-lookup Delete + user conditional Delete
      expect(ctx.writeBuffer.length).toBe(2);
      expect(ctx.writeBuffer[0].Delete.TableName).toBe("test-email-lookups");
      expect(ctx.writeBuffer[0].Delete.Key).toEqual({ email: "carol@test.com" });
      expect(ctx.writeBuffer[1].Delete.TableName).toBe("test-users");
    });

    it("sets hasEmailUniqueness.value = true on consume of user", async () => {
      const userItem = { id: "u1", email: "a@b.com" };
      const ctx = makeCtx({
        findOneResult: { ...userItem },
        config: emailUniquenessConfig(),
      });

      await txConsumeOne(ctx, {
        model: "user",
        where: [{ field: "id", operator: "eq", value: "u1" }],
      });

      expect(ctx.hasEmailUniqueness.value).toBe(true);
    });

    it("pushes conditional Delete with ConditionExpression attribute_exists", async () => {
      const ctx = makeCtx({ findOneResult: { ...item } });

      await txConsumeOne(ctx, {
        model: "verification",
        where: [{ field: "id", operator: "eq", value: "v1" }],
      });

      expect(ctx.writeBuffer.length).toBe(1);
      const del = ctx.writeBuffer[0].Delete;
      expect(del.TableName).toBe("test-verifications");
      expect(del.Key).toEqual({ id: "v1" });
      expect(del.ConditionExpression).toBe("attribute_exists(#pk)");
      expect(del.ExpressionAttributeNames).toEqual({ "#pk": "id" });
      expect(del.ReturnValuesOnConditionCheckFailure).toBe("ALL_OLD");
    });

    it("throws TRANSACTION_FAILED when buffer capacity exceeded", async () => {
      const writeBuffer = new Array(100).fill({ Placeholder: true });
      const ctx = makeCtx({ writeBuffer, findOneResult: { ...item } });

      await expect(
        txConsumeOne(ctx, {
          model: "verification",
          where: [{ field: "id", operator: "eq", value: "v1" }],
        }),
      ).rejects.toThrow(/more than 100/);
    });

    it("returns the captured item (not the result of the delete)", async () => {
      const ctx = makeCtx({ findOneResult: { ...item } });

      const result = await txConsumeOne(ctx, {
        model: "verification",
        where: [{ field: "id", operator: "eq", value: "v1" }],
      });

      // The handler returns the eagerly-captured item, not a delete result
      expect(result).toEqual(item);
      expect(result!.value).toBe("tok456");
    });
  });
});
