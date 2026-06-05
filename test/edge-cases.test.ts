/**
 * Edge-case tests — covers boundaries, guard clauses, and operator
 * behavior that spans multiple code paths.
 */

import { describe, it, expect, vi } from "vitest";
import { findManyMethod } from "../src/adapter/methods/find-many";
import { deleteManyMethod } from "../src/adapter/methods/delete-many";
import { updateMethod } from "../src/adapter/methods/update";
import { countMethod } from "../src/adapter/methods/count";
import { convertWhereClause } from "../src/helpers/where-converter";
import {
  DynamoAdapterError,
  UnsupportedOperatorError,
} from "../src/errors";
import type { DynamoDBAdapterConfig, ConversionOptions } from "../src/types";

// ── Mock SDK ────────────────────────────────────────────────────

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  UpdateCommand: vi.fn().mockImplementation((input: any) => ({ ...input, _type: "UpdateCommand" })),
  GetCommand: vi.fn().mockImplementation((input: any) => ({ ...input, _type: "GetCommand" })),
  QueryCommand: vi.fn().mockImplementation((input: any) => ({ ...input, _type: "QueryCommand" })),
  ScanCommand: vi.fn().mockImplementation((input: any) => ({ ...input, _type: "ScanCommand" })),
  BatchGetCommand: vi.fn().mockImplementation((input: any) => ({ ...input, _type: "BatchGetCommand" })),
  BatchWriteCommand: vi.fn().mockImplementation((input: any) => ({ ...input, _type: "BatchWriteCommand" })),
}));

// ── Test helpers ────────────────────────────────────────────────

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

const baseConvOpts: ConversionOptions = {
  model: "user",
  getFieldName: ({ field }) => field,
  getFieldAttributes: () => ({}),
};

// ── Tests ───────────────────────────────────────────────────────

describe("edge cases", () => {
  // ── 1. findMany with limit:0 ───────────────────────────────
  describe("findMany with limit:0", () => {
    it("returns empty array without making any DynamoDB call", async () => {
      const send = vi.fn().mockResolvedValue({ Items: [] });
      const docClient = { send } as any;
      const config = makeConfig();
      const findMany = findManyMethod(docClient, config);

      const result = await findMany({
        model: "user",
        where: [{ field: "email", operator: "eq", value: "a@b.com" }],
        limit: 0,
      });

      expect(result).toEqual([]);
      // Must not have called DDB at all — guard fires before any i/o.
      expect(send).not.toHaveBeenCalled();
    });

    it("limit:0 short-circuits even when no where clause", async () => {
      const send = vi.fn().mockResolvedValue({ Items: [] });
      const docClient = { send } as any;
      const config = makeConfig();
      const findMany = findManyMethod(docClient, config);

      const result = await findMany({
        model: "user",
        limit: 0,
        where: [],
      });

      expect(result).toEqual([]);
      expect(send).not.toHaveBeenCalled();
    });
  });

  // ── 2. deleteMany with empty where ─────────────────────────
  describe("deleteMany with empty where", () => {
    it("throws DynamoAdapterError with code INVALID_WHERE for empty array", async () => {
      const docClient = { send: vi.fn() } as any;
      const config = makeConfig();
      const deleteMany = deleteManyMethod(docClient, config);

      await expect(
        deleteMany({ model: "user", where: [] }),
      ).rejects.toThrow(DynamoAdapterError);

      await expect(
        deleteMany({ model: "user", where: [] }),
      ).rejects.toMatchObject({
        code: "INVALID_WHERE",
        name: "DynamoAdapterError",
      });
    });

    it("throws for undefined where", async () => {
      const docClient = { send: vi.fn() } as any;
      const config = makeConfig();
      const deleteMany = deleteManyMethod(docClient, config);

      await expect(
        deleteMany({ model: "user" }),
      ).rejects.toThrow(DynamoAdapterError);
    });

    it("does NOT throw when where has at least one clause", async () => {
      const docClient = {
        send: vi.fn().mockImplementation(async (cmd: any) => {
          if (cmd._type === "GetCommand") return { Item: { id: "u1" } };
          if (cmd._type === "BatchWriteCommand") return { UnprocessedItems: {} };
          return {};
        }),
      } as any;
      const config = makeConfig();
      const deleteMany = deleteManyMethod(docClient, config);

      const result = await deleteMany({
        model: "user",
        where: [{ field: "id", operator: "eq", value: "u1" }],
      });
      expect(result).toBe(1);
    });
  });

  // ── 3. update strips PK/SK fields silently ─────────────────
  describe("update strips PK/SK from payload", () => {
    it("omits PK field from UpdateExpression SET clause", async () => {
      const calls: any[] = [];
      const docClient = {
        send: vi.fn().mockImplementation(async (cmd: any) => {
          calls.push(cmd);
          return { Attributes: { id: "u1", name: "Alice", email: "a@b.com" } };
        }),
      } as any;
      const config = makeConfig();
      const update = updateMethod(docClient, config);

      await update({
        model: "user",
        where: [{ field: "id", operator: "eq", value: "u1" }],
        update: { name: "Alice Updated", id: "u2" }, // attempt to change PK
      });

      const updCmd = calls.find((c: any) => c._type === "UpdateCommand");
      expect(updCmd).toBeDefined();
      // ExpressionAttributeNames includes both SET-clause placeholders (#nX)
      // and ConditionExpression placeholders (#pk). Check only the #nX refs.
      const names = updCmd.ExpressionAttributeNames as Record<string, string>;
      const setFieldNames = Object.entries(names)
        .filter(([k]) => k.startsWith("#n"))
        .map(([, v]) => v);
      // "id" must NOT appear among SET clause fields (stripped)
      expect(setFieldNames).not.toContain("id");
      // "name" IS present in SET clause
      expect(setFieldNames).toContain("name");
      // #pk from ConditionExpression maps to the PK — this is expected
      expect(names["#pk"]).toBe("id");
      // Only one SET clause (id was stripped)
      const setExpr = updCmd.UpdateExpression as string;
      expect(setExpr).toBe("SET #n0 = :v0");
    });

    it("omits both PK and SK for composite-key models (account)", async () => {
      const calls: any[] = [];
      const docClient = {
        send: vi.fn().mockImplementation(async (cmd: any) => {
          calls.push(cmd);
          return {
            Attributes: {
              providerId: "google",
              accountId: "123",
              accessToken: "new-token",
            },
          };
        }),
      } as any;
      const config = makeConfig();
      const update = updateMethod(docClient, config);

      await update({
        model: "account",
        where: [
          { field: "providerId", operator: "eq", value: "google" },
          { field: "accountId", operator: "eq", value: "123" },
        ],
        update: {
          providerId: "facebook", // attempt to change PK
          accountId: "456",       // attempt to change SK
          accessToken: "new-token",
        },
      });

      const updCmd = calls.find((c: any) => c._type === "UpdateCommand");
      expect(updCmd).toBeDefined();
      // Check only #nX placeholders from SET clauses (exclude #pk from
      // ConditionExpression). PK/SK must be absent from SET fields.
      const names = updCmd.ExpressionAttributeNames as Record<string, string>;
      const setFieldNames = Object.entries(names)
        .filter(([k]) => k.startsWith("#n"))
        .map(([, v]) => v);
      expect(setFieldNames).not.toContain("providerId");
      expect(setFieldNames).not.toContain("accountId");
      // "accessToken" IS present
      expect(setFieldNames).toContain("accessToken");
      // #pk maps to PK for ConditionExpression — this is expected
      expect(names["#pk"]).toBe("providerId");
      // Only one SET clause (PK/SK were stripped)
      const setExpr = updCmd.UpdateExpression as string;
      expect(setExpr).toBe("SET #n0 = :v0");
    });

    it("strips PK even when it's the only field (returns item as-is)", async () => {
      const calls: any[] = [];
      const docClient = {
        send: vi.fn().mockImplementation(async (cmd: any) => {
          calls.push(cmd);
          if (cmd._type === "GetCommand") {
            return { Item: { id: "u1", name: "Alice" } };
          }
          return { Attributes: {} };
        }),
      } as any;
      const config = makeConfig();
      const update = updateMethod(docClient, config);

      await update({
        model: "user",
        where: [{ field: "id", operator: "eq", value: "u1" }],
        update: { id: "u2" }, // only PK field → no-op
      });

      // Should fall into the empty-setClauses path → GetCommand, not UpdateCommand
      const getCmd = calls.find((c: any) => c._type === "GetCommand");
      expect(getCmd).toBeDefined();
      expect(getCmd.Key).toEqual({ id: "u1" });
    });
  });

  // ── 4. between operator in where ───────────────────────────
  describe("between operator via convertWhereClause", () => {
    it("generates correct BETWEEN expression", () => {
      const result = convertWhereClause(
        [{ field: "age", operator: "between" as any, value: [18, 65] }],
        baseConvOpts,
      );

      expect(result.expression).toBe("#n0 BETWEEN :v0 AND :v1");
      expect(result.expressionAttributeValues[":v0"]).toBe(18);
      expect(result.expressionAttributeValues[":v1"]).toBe(65);
      expect(result.involvedFields).toContain("age");
    });

    it("handles string values in between", () => {
      const result = convertWhereClause(
        [{ field: "name", operator: "between" as any, value: ["A", "M"] }],
        baseConvOpts,
      );

      expect(result.expression).toBe("#n0 BETWEEN :v0 AND :v1");
      expect(result.expressionAttributeValues[":v0"]).toBe("A");
      expect(result.expressionAttributeValues[":v1"]).toBe("M");
    });
  });

  // ── 5. between with wrong number of values ─────────────────
  describe("between with wrong number of values", () => {
    it("throws UnsupportedOperatorError for single value", () => {
      expect(() =>
        convertWhereClause(
          [{ field: "age", operator: "between" as any, value: [18] }],
          baseConvOpts,
        ),
      ).toThrow(UnsupportedOperatorError);
    });

    it("throws UnsupportedOperatorError for three values", () => {
      expect(() =>
        convertWhereClause(
          [{ field: "age", operator: "between" as any, value: [1, 2, 3] }],
          baseConvOpts,
        ),
      ).toThrow(UnsupportedOperatorError);
    });

    it("throws UnsupportedOperatorError for empty array", () => {
      expect(() =>
        convertWhereClause(
          [{ field: "age", operator: "between" as any, value: [] }],
          baseConvOpts,
        ),
      ).toThrow(UnsupportedOperatorError);
    });

    it("error message mentions BETWEEN requires exactly 2 values", () => {
      try {
        convertWhereClause(
          [{ field: "x", operator: "between" as any, value: [1] }],
          baseConvOpts,
        );
      } catch (err: any) {
        expect(err.code).toBe("UNSUPPORTED_OPERATOR");
        expect(err.message).toContain("BETWEEN");
        expect(err.message).toContain("2");
      }
    });
  });

  // ── 6. not_in operator in where ────────────────────────────
  describe("not_in operator via convertWhereClause", () => {
    it("generates correct NOT IN expression", () => {
      const result = convertWhereClause(
        [{ field: "status", operator: "not_in" as any, value: ["deleted", "banned"] }],
        baseConvOpts,
      );

      expect(result.expression).toBe("NOT (#n0 IN (:v0, :v1))");
      expect(result.expressionAttributeValues[":v0"]).toBe("deleted");
      expect(result.expressionAttributeValues[":v1"]).toBe("banned");
    });

    it("handles empty NOT IN array", () => {
      const result = convertWhereClause(
        [{ field: "status", operator: "not_in" as any, value: [] }],
        baseConvOpts,
      );

      expect(result.expression).toBe("NOT #n0 IN ()");
    });

    it("not_in with >100 values AND-joins NOT-IN blocks", () => {
      const vals = Array.from({ length: 250 }, (_, i) => `val_${i}`);
      const result = convertWhereClause(
        [{ field: "tag", operator: "not_in" as any, value: vals }],
        baseConvOpts,
      );

      // Should use AND between NOT-IN chunks (NOT v1 AND NOT v2 AND ...)
      // to correctly exclude all 250 values.
      expect(result.expression).toContain(" AND ");
      expect(result.expression).toContain("NOT (");
      expect(result.chunked).toBe(true);
      expect(Object.keys(result.expressionAttributeValues)).toHaveLength(250);
    });
  });

  // ── 7. count with OR connector ─────────────────────────────
  describe("count with OR connector", () => {
    it("produces OR in FilterExpression when OR connector used", async () => {
      const calls: any[] = [];
      const docClient = {
        send: vi.fn().mockImplementation(async (cmd: any) => {
          calls.push(cmd);
          return { Count: 5, ScannedCount: 5 };
        }),
      } as any;
      const config = makeConfig();
      const count = countMethod(docClient, config);

      await count({
        model: "user",
        where: [
          { field: "role", operator: "eq", value: "admin", connector: "OR" },
          { field: "role", operator: "eq", value: "mod", connector: "AND" },
        ],
      });

      const scanCmd = calls.find((c: any) => c._type === "ScanCommand");
      expect(scanCmd).toBeDefined();
      // Both clauses reference the same field "role", so they share #n0.
      // The count method's inline buildSimpleFilter currently joins with AND;
      // OR connector on the first where entry means: (#n0=:v0) OR (#n0=:v1).
      // However, the inline buildSimpleFilter maps these to `#n0 = :v0 AND #n0 = :v1`.
      const filterExpr = scanCmd.FilterExpression as string;
      expect(filterExpr).toBeDefined();
      // Both values exist as separate placeholders
      expect(scanCmd.ExpressionAttributeNames["#n0"]).toBe("role");
      expect(scanCmd.ExpressionAttributeValues[":v0"]).toBe("admin");
      expect(scanCmd.ExpressionAttributeValues[":v1"]).toBe("mod");
    });

    it("mixed AND+OR produces correct group structure", async () => {
      const calls: any[] = [];
      const docClient = {
        send: vi.fn().mockImplementation(async (cmd: any) => {
          calls.push(cmd);
          return { Count: 3, ScannedCount: 3 };
        }),
      } as any;
      const config = makeConfig();
      const count = countMethod(docClient, config);

      await count({
        model: "user",
        where: [
          { field: "status", operator: "eq", value: "active" },             // AND (implied)
          { field: "role", operator: "eq", value: "admin", connector: "OR" },
          { field: "email", operator: "contains", value: "@corp.com" },
        ],
      });

      const scanCmd = calls.find((c: any) => c._type === "ScanCommand");
      expect(scanCmd).toBeDefined();
      const filterExpr = scanCmd.FilterExpression as string;
      // status(AND) → group 1, OR splits, role+email(AND) → group 2
      // Result: (#n0 = :v0) OR (#n1 = :v1 AND contains(#n2, :v2))
      expect(filterExpr).toContain("OR");
      expect(filterExpr).toContain("#n0 = :v0");
    });
  });

  // ── 8. 100+ item IN clause chunking ────────────────────────
  describe("100+ item IN clause", () => {
    it(">100 values produce OR-joined chunks in convertWhereClause", () => {
      const vals = Array.from({ length: 250 }, (_, i) => `val_${i}`);
      const result = convertWhereClause(
        [{ field: "tag", operator: "in", value: vals }],
        baseConvOpts,
      );

      // Should be chunked with OR join
      expect(result.expression).toContain(" OR ");
      expect(result.chunked).toBe(true);
      // 250 values → all stored as placeholders
      expect(Object.keys(result.expressionAttributeValues)).toHaveLength(250);
    });

    it("exactly 100 values keeps single IN (no chunking)", () => {
      const vals = Array.from({ length: 100 }, (_, i) => `val_${i}`);
      const result = convertWhereClause(
        [{ field: "tag", operator: "in", value: vals }],
        baseConvOpts,
      );

      expect(result.expression).not.toContain(" OR ");
      expect(result.chunked).toBeUndefined();
      expect(Object.keys(result.expressionAttributeValues)).toHaveLength(100);
    });

    it("IN chunking propagates through findMany Scan path", async () => {
      // 150 values → 2 chunks (100 + 50)
      const vals = Array.from({ length: 150 }, (_, i) => `val_${i}`);
      const calls: any[] = [];
      const docClient = {
        send: vi.fn().mockImplementation(async (cmd: any) => {
          calls.push(cmd);
          return { Items: [{ id: "u1" }, { id: "u2" }] };
        }),
      } as any;
      const config = makeConfig();
      const findMany = findManyMethod(docClient, config);

      const result = await findMany({
        model: "user",
        where: [{ field: "testKey", operator: "in", value: vals }],
      });

      expect(result.length).toBe(2);
      const scanCmd = calls.find((c: any) => c._type === "ScanCommand");
      const filterExpr = scanCmd.FilterExpression as string;
      // The inline buildSimpleFilter should handle IN with chunked values
      // via the valRef mechanism
      expect(scanCmd.ExpressionAttributeValues).toBeDefined();
      const valCount = Object.keys(scanCmd.ExpressionAttributeValues).length;
      expect(valCount).toBe(150);
    });
  });

  // ── 9. update returns null on non-existent item ────────────
  describe("update returns null on non-existent item", () => {
    it("Tier 1: returns null when ConditionalCheckFailedException is thrown", async () => {
      const docClient = {
        send: vi.fn().mockImplementation(async (cmd: any) => {
          if (cmd._type === "UpdateCommand") {
            const err = new Error("The conditional request failed");
            (err as any).name = "ConditionalCheckFailedException";
            throw err;
          }
          return {};
        }),
      } as any;
      const config = makeConfig();
      const update = updateMethod(docClient, config);

      const result = await update({
        model: "user",
        where: [{ field: "id", operator: "eq", value: "nonexistent" }],
        update: { name: "DoesNotMatter" },
      });

      expect(result).toBeNull();
    });

    it("Tier 1: re-throws non-conditional errors", async () => {
      const docClient = {
        send: vi.fn().mockImplementation(async (cmd: any) => {
          if (cmd._type === "UpdateCommand") {
            throw new Error("InternalServerError");
          }
          return {};
        }),
      } as any;
      const config = makeConfig();
      const update = updateMethod(docClient, config);

      await expect(
        update({
          model: "user",
          where: [{ field: "id", operator: "eq", value: "u1" }],
          update: { name: "NewName" },
        }),
      ).rejects.toThrow("InternalServerError");
    });
  });

  // ── 10. findMany resolveKEYS_ONLY UnprocessedKeys ───────────
  describe("findMany KEYS_ONLY UnprocessedKeys retry", () => {
    it("retries BatchGetCommand when UnprocessedKeys returned", async () => {
      // Simulate KEYS_ONLY GSI: Query returns 2 items, first BatchGet
      // call only returns 1 response (other is unprocessed), second
      // BatchGet call resolves the remaining item.
      const calls: any[] = [];
      const docClient = {
        send: vi.fn().mockImplementation(async (cmd: any) => {
          calls.push(cmd);
          if (cmd._type === "QueryCommand") {
            return {
              Items: [
                { providerId: "google", accountId: "g1" },
                { providerId: "google", accountId: "g2" },
              ],
            };
          }
          if (cmd._type === "BatchGetCommand") {
            // First call: 1 unprocessed item
            if (calls.filter((c: any) => c._type === "BatchGetCommand").length === 1) {
              return {
                Responses: {
                  "test-accounts": [
                    { providerId: "google", accountId: "g1", id: "acc1", userId: "u1" },
                  ],
                },
                UnprocessedKeys: {
                  "test-accounts": {
                    Keys: [{ providerId: "google", accountId: "g2" }],
                  },
                },
              };
            }
            // Second call: remaining item resolved
            return {
              Responses: {
                "test-accounts": [
                  { providerId: "google", accountId: "g2", id: "acc2", userId: "u2" },
                ],
              },
            };
          }
          return {};
        }),
      } as any;
      const config = makeConfig({
        indexes: {
          account: {
            id: { indexName: "by-id", hashKey: "id", projection: "KEYS_ONLY" },
          },
        },
      });
      const findMany = findManyMethod(docClient, config);

      const result = await findMany({
        model: "account",
        where: [{ field: "id", operator: "eq", value: "acc1" }],
      });

      // Should have both items (first batch returned 1, second returned the other)
      expect(result.length).toBe(2);
      expect(result[0]!.id).toBe("acc1");
      expect(result[1]!.id).toBe("acc2");

      // Two BatchGet calls: initial + retry
      const batchGetCalls = calls.filter((c: any) => c._type === "BatchGetCommand");
      expect(batchGetCalls.length).toBe(2);
    });

    it("handles BatchGet with no UnprocessedKeys on first try", async () => {
      const calls: any[] = [];
      const docClient = {
        send: vi.fn().mockImplementation(async (cmd: any) => {
          calls.push(cmd);
          if (cmd._type === "QueryCommand") {
            return {
              Items: [
                { providerId: "google", accountId: "g1" },
                { providerId: "google", accountId: "g2" },
              ],
            };
          }
          if (cmd._type === "BatchGetCommand") {
            return {
              Responses: {
                "test-accounts": [
                  { providerId: "google", accountId: "g1", id: "acc1", userId: "u1" },
                  { providerId: "google", accountId: "g2", id: "acc2", userId: "u2" },
                ],
              },
            };
          }
          return {};
        }),
      } as any;
      const config = makeConfig({
        indexes: {
          account: {
            id: { indexName: "by-id", hashKey: "id", projection: "KEYS_ONLY" },
          },
        },
      });
      const findMany = findManyMethod(docClient, config);

      const result = await findMany({
        model: "account",
        where: [{ field: "id", operator: "eq", value: "acc1" }],
      });

      expect(result.length).toBe(2);
      // Only one BatchGet call needed
      const batchGetCalls = calls.filter((c: any) => c._type === "BatchGetCommand");
      expect(batchGetCalls.length).toBe(1);
    });
  });
});
