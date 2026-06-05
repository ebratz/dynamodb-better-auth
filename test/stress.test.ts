/**
 * Stress tests — push adapter methods to their limits.
 *
 * Tests pagination, batching, concurrency, chunking, and error
 * aggregation at scale using programmatically generated mock data.
 * No DynamoDB Local required — all tests mock the SDK.
 */

import { describe, it, expect, vi } from "vitest";

import { findManyMethod } from "../src/adapter/methods/find-many";
import { deleteManyMethod } from "../src/adapter/methods/delete-many";
import { updateManyMethod } from "../src/adapter/methods/update-many";
import { findOneMethod } from "../src/adapter/methods/find-one";
import { convertWhereClause } from "../src/helpers/where-converter";
import { resolveKEYS_ONLY } from "../src/helpers/batch-get";
import type { ConversionOptions } from "../src/types";

// ── SDK mock ────────────────────────────────────────────────────

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  GetCommand: vi.fn().mockImplementation((input: any) => ({ ...input, _type: "GetCommand" })),
  PutCommand: vi.fn().mockImplementation((input: any) => ({ ...input, _type: "PutCommand" })),
  UpdateCommand: vi.fn().mockImplementation((input: any) => ({ ...input, _type: "UpdateCommand" })),
  DeleteCommand: vi.fn().mockImplementation((input: any) => ({ ...input, _type: "DeleteCommand" })),
  QueryCommand: vi.fn().mockImplementation((input: any) => ({ ...input, _type: "QueryCommand" })),
  ScanCommand: vi.fn().mockImplementation((input: any) => ({ ...input, _type: "ScanCommand" })),
  BatchGetCommand: vi.fn().mockImplementation((input: any) => ({ ...input, _type: "BatchGetCommand" })),
  BatchWriteCommand: vi.fn().mockImplementation((input: any) => ({ ...input, _type: "BatchWriteCommand" })),
}));

// ── Helpers ────────────────────────────────────────────────────

function makeConfig(overrides: Record<string, any> = {}) {
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

const baseConvOpts: ConversionOptions = {
  model: "user",
  getFieldName: ({ field }) => field,
  getFieldAttributes: () => ({}),
};

// ── Tests ──────────────────────────────────────────────────────

describe("stress", () => {
  // ══════════════════════════════════════════════════════════════
  // 1. updateMany with 500 items + concurrency=10
  // ══════════════════════════════════════════════════════════════
  it("updateMany with 500 items and concurrency=10 processes all", async () => {
    const items = Array.from({ length: 500 }, (_, i) => ({
      id: `u${i}`,
      name: `User ${i}`,
    }));

    const updateCalls: any[] = [];
    const docClient = {
      send: vi.fn().mockImplementation(async (cmd: any) => {
        if (cmd._type === "QueryCommand") {
          return { Items: items };
        }
        if (cmd._type === "UpdateCommand") {
          updateCalls.push(cmd);
          return { Attributes: {} };
        }
        return {};
      }),
    } as any;

    const config = makeConfig({
      updateManyConcurrency: 10,
      indexes: {
        user: { role: { indexName: "role-index", hashKey: "role" } },
      },
    });
    const updateMany = updateManyMethod(docClient, config);

    const count = await updateMany({
      model: "user",
      where: [{ field: "role", operator: "eq", value: "user" }],
      update: { role: "admin" },
    });

    expect(count).toBe(500);
    expect(updateCalls.length).toBe(500);
    // Verify all 500 keys are unique
    const ids = updateCalls.map((c: any) => c.Key.id);
    expect(new Set(ids).size).toBe(500);
  });

  // ══════════════════════════════════════════════════════════════
  // 2. findMany paginating through 200 items (Tier 3 Scan)
  // ══════════════════════════════════════════════════════════════
  it("findMany paginates through 200 Scan items (10 per page)", async () => {
    const PAGE_SIZE = 10;
    const TOTAL = 200;
    const allItems = Array.from({ length: TOTAL }, (_, i) => ({
      id: `u${i}`,
      name: `User ${i}`,
    }));

    let page = 0;
    const scanCalls: any[] = [];
    const docClient = {
      send: vi.fn().mockImplementation(async (cmd: any) => {
        if (cmd._type === "ScanCommand") {
          scanCalls.push(cmd);
          const start = page * PAGE_SIZE;
          const slice = allItems.slice(start, start + PAGE_SIZE);
          page++;
          const hasMore = start + PAGE_SIZE < TOTAL;
          return {
            Items: slice,
            ...(hasMore ? { LastEvaluatedKey: { id: `u${start + PAGE_SIZE - 1}` } } : {}),
          };
        }
        return { Items: [] };
      }),
    } as any;

    const config = makeConfig();
    const findMany = findManyMethod(docClient, config);

    const result = await findMany({
      model: "user",
      where: [{ field: "name", operator: "contains", value: "User" }],
      limit: 200,
    });

    expect(result.length).toBe(TOTAL);
    expect(scanCalls.length).toBe(TOTAL / PAGE_SIZE); // 20 pages
  });

  // ══════════════════════════════════════════════════════════════
  // 3. deleteMany with 200 keys across 8 BatchWrite chunks
  // ══════════════════════════════════════════════════════════════
  it("deleteMany chunks 200 keys into 8 BatchWrite calls", async () => {
    const TOTAL = 200;
    const BATCH = 25;
    const items = Array.from({ length: TOTAL }, (_, i) => ({
      id: `u${i}`,
      name: `User ${i}`,
    }));

    const batchWrites: any[] = [];
    const docClient = {
      send: vi.fn().mockImplementation(async (cmd: any) => {
        if (cmd._type === "ScanCommand" || cmd._type === "QueryCommand") {
          return { Items: items };
        }
        if (cmd._type === "BatchWriteCommand") {
          batchWrites.push(cmd);
          return { UnprocessedItems: {} };
        }
        return {};
      }),
    } as any;

    const config = makeConfig();
    const deleteMany = deleteManyMethod(docClient, config);

    const count = await deleteMany({
      model: "user",
      where: [{ field: "name", operator: "starts_with", value: "User" }],
    });

    expect(count).toBe(TOTAL);
    expect(batchWrites.length).toBe(Math.ceil(TOTAL / BATCH)); // 8 chunks
    // First chunk has 25, last has 200 - 7*25 = 25 (exact)
    const keysInChunks = batchWrites.map(
      (bw: any) => bw.RequestItems["test-users"].length,
    );
    expect(keysInChunks[0]).toBe(25);
    expect(keysInChunks[7]).toBe(25);
    const totalKeysInChunks = keysInChunks.reduce((a: number, b: number) => a + b, 0);
    expect(totalKeysInChunks).toBe(TOTAL);
  });

  // ══════════════════════════════════════════════════════════════
  // 4. 100 concurrent findOne calls
  // ══════════════════════════════════════════════════════════════
  it("100 concurrent findOne calls complete without errors", async () => {
    const CONCURRENT = 100;
    const items = Array.from({ length: CONCURRENT }, (_, i) => ({
      id: `u${i}`,
      name: `User ${i}`,
    }));

    // Seed items so every query finds exactly one
    const docClient = {
      send: vi.fn().mockImplementation(async (cmd: any) => {
        if (cmd._type === "QueryCommand") {
          // Match by id pattern (simplified: return first item)
          const keyId = cmd.ExpressionAttributeValues?.[":v0"] ?? "";
          const found = items.find((it: any) => it.id === keyId) ?? null;
          return { Items: found ? [found] : [] };
        }
        return {};
      }),
    } as any;

    const config = makeConfig({
      indexes: {
        user: { name: { indexName: "name-idx", hashKey: "name" } },
      },
    });
    const findOne = findOneMethod(docClient, config);

    // Fire 100 parallel calls
    const promises = Array.from({ length: CONCURRENT }, (_, i) =>
      findOne({
        model: "user",
        where: [{ field: "name", operator: "eq", value: `u${i}` }],
      }),
    );

    const results = await Promise.all(promises);
    expect(results.length).toBe(CONCURRENT);
    // Each result should be non-null
    for (const r of results) {
      expect(r).not.toBeNull();
    }
  });

  // ══════════════════════════════════════════════════════════════
  // 5. KEYS_ONLY BatchGet with 250 items (3 chunks)
  // ══════════════════════════════════════════════════════════════
  it("resolveKEYS_ONLY chunks 250 items into 3 BatchGet calls", async () => {
    const TOTAL = 250;
    const gsiItems = Array.from({ length: TOTAL }, (_, i) => ({
      id: `u${i}`,
      providerId: "google",
      accountId: `acc${i}`,
    }));
    const fullItems = Array.from({ length: TOTAL }, (_, i) => ({
      id: `u${i}`,
      providerId: "google",
      accountId: `acc${i}`,
      userId: `usr${i}`,
      accessToken: `tok${i}`,
    }));

    const batchGetCalls: any[] = [];
    const docClient = {
      send: vi.fn().mockImplementation(async (cmd: any) => {
        if (cmd._type === "BatchGetCommand") {
          batchGetCalls.push(cmd);
          const keys = cmd.RequestItems["test-accounts"].Keys;
          // Return the matching full items
          const matched = fullItems.filter((fi: any) =>
            keys.some(
              (k: any) => k.providerId === fi.providerId && k.accountId === fi.accountId,
            ),
          );
          return { Responses: { "test-accounts": matched } };
        }
        return {};
      }),
    } as any;

    const result = await resolveKEYS_ONLY(
      docClient as any,
      "test-accounts",
      { pkField: "providerId", skField: "accountId" },
      gsiItems,
    );

    expect(result.length).toBe(TOTAL);
    // 250 keys → 3 batches: 100 + 100 + 50
    expect(batchGetCalls.length).toBe(3);
    expect(batchGetCalls[0].RequestItems["test-accounts"].Keys.length).toBe(100);
    expect(batchGetCalls[1].RequestItems["test-accounts"].Keys.length).toBe(100);
    expect(batchGetCalls[2].RequestItems["test-accounts"].Keys.length).toBe(50);
  });

  // ══════════════════════════════════════════════════════════════
  // 6. updateMany AggregateError with 50 items, 10 failures
  // ══════════════════════════════════════════════════════════════
  it("updateMany AggregateError with 50 items and 10 failures", async () => {
    const TOTAL = 50;
    const FAIL = 10;
    const items = Array.from({ length: TOTAL }, (_, i) => ({
      id: `u${i}`,
      name: `User ${i}`,
    }));

    let callCount = 0;
    const docClient = {
      send: vi.fn().mockImplementation(async (cmd: any) => {
        if (cmd._type === "QueryCommand") {
          return { Items: items };
        }
        if (cmd._type === "UpdateCommand") {
          callCount++;
          // Every 5th call fails
          if (callCount % 5 === 0) {
            throw new Error(`ThrottlingException on item ${callCount}`);
          }
          return { Attributes: {} };
        }
        return {};
      }),
    } as any;

    const config = makeConfig({
      updateManyConcurrency: 10,
      indexes: {
        user: { role: { indexName: "role-index", hashKey: "role" } },
      },
    });
    const updateMany = updateManyMethod(docClient, config);

    await expect(
      updateMany({
        model: "user",
        where: [{ field: "role", operator: "eq", value: "user" }],
        update: { role: "admin" },
      }),
    ).rejects.toThrow(AggregateError);

    try {
      await updateMany({
        model: "user",
        where: [{ field: "role", operator: "eq", value: "user" }],
        update: { role: "admin" },
      });
    } catch (err: any) {
      expect(err).toBeInstanceOf(AggregateError);
      expect(err.errors.length).toBe(FAIL);
      expect(err.message).toContain(`${FAIL} of ${TOTAL}`);
    }
  });

  // ══════════════════════════════════════════════════════════════
  // 7. IN clause with 250 values (3 chunks of 100+100+50)
  // ══════════════════════════════════════════════════════════════
  it("IN clause chunks 250 values into OR-joined groups", () => {
    const vals = Array.from({ length: 250 }, (_, i) => `val_${i}`);
    const result = convertWhereClause(
      [{ field: "tag", operator: "in", value: vals }],
      baseConvOpts,
    );

    // Expression should use OR to join 3 chunks (100 + 100 + 50)
    expect(result.expression).toContain(" OR ");
    expect(result.chunked).toBe(true);
    // All 250 values must have placeholders
    expect(Object.keys(result.expressionAttributeValues)).toHaveLength(250);

    // Expression should contain exactly 2 " OR " separators (3 groups)
    const orCount = (result.expression.match(/ OR /g) ?? []).length;
    expect(orCount).toBe(2);
  });

  // ══════════════════════════════════════════════════════════════
  // 8. findMany scan pagination with LastEvaluatedKey boundary
  // ══════════════════════════════════════════════════════════════
  it("findMany stops pagination when LastEvaluatedKey is absent", async () => {
    const items = Array.from({ length: 15 }, (_, i) => ({ id: `u${i}` }));

    let page = 0;
    const scanCalls: any[] = [];
    const docClient = {
      send: vi.fn().mockImplementation(async (cmd: any) => {
        if (cmd._type === "ScanCommand") {
          scanCalls.push(cmd);
          page++;
          if (page === 1) {
            return { Items: items.slice(0, 10), LastEvaluatedKey: { id: "u9" } };
          }
          // Second page: last 5 items, no LastEvaluatedKey
          return { Items: items.slice(10) };
        }
        return { Items: [] };
      }),
    } as any;

    const config = makeConfig();
    const findMany = findManyMethod(docClient, config);

    const result = await findMany({
      model: "user",
      limit: 20,
    });

    expect(result.length).toBe(15);
    expect(scanCalls.length).toBe(2);
    // Second call should have ExclusiveStartKey set
    expect(scanCalls[1].ExclusiveStartKey).toEqual({ id: "u9" });
  });
});
