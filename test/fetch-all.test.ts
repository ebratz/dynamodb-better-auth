/**
 * Unit tests for fetchAllByPlan — shared paginated fetch helper.
 */

import { describe, it, expect, vi } from "vitest";
import { fetchAllByPlan } from "../src/helpers/fetch-all";
import type { FetchAllPlan } from "../src/helpers/fetch-all";

// Mock the SDK
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  QueryCommand: vi.fn().mockImplementation((input: any) => ({
    ...input,
    _type: "QueryCommand",
  })),
  ScanCommand: vi.fn().mockImplementation((input: any) => ({
    ...input,
    _type: "ScanCommand",
  })),
}));

describe("fetchAllByPlan", () => {
  // ── Query path ───────────────────────────────────────────

  it("Query: single page with items", async () => {
    const items = [{ id: "u1" }, { id: "u2" }];
    const calls: any[] = [];
    const docClient = {
      send: vi.fn().mockImplementation(async (cmd: any) => {
        calls.push(cmd);
        return { Items: items };
      }),
    };

    const plan: FetchAllPlan = {
      operation: "query",
      indexName: "email-index",
      keyCondition: "#n0 = :v0",
      expressionAttributeNames: { "#n0": "email" },
      expressionAttributeValues: { ":v0": "a@b.com" },
    };

    const result = await fetchAllByPlan(docClient as any, "test-users", plan);

    expect(result).toEqual(items);
    expect(calls).toHaveLength(1);
    expect(calls[0].IndexName).toBe("email-index");
    expect(calls[0].KeyConditionExpression).toBe("#n0 = :v0");
  });

  it("Query: paginated across ExclusiveStartKey", async () => {
    const page1 = [{ id: "u1" }, { id: "u2" }];
    const page2 = [{ id: "u3" }, { id: "u4" }];

    const calls: any[] = [];
    const docClient = {
      send: vi.fn().mockImplementation(async (cmd: any) => {
        calls.push(cmd);
        if (calls.length === 1) {
          return { Items: page1, LastEvaluatedKey: { id: "u2" } };
        }
        return { Items: page2 };
      }),
    };

    const plan: FetchAllPlan = {
      operation: "query",
      indexName: "email-index",
      keyCondition: "#n0 = :v0",
      expressionAttributeNames: { "#n0": "email" },
      expressionAttributeValues: { ":v0": "a@b.com" },
    };

    const result = await fetchAllByPlan(docClient as any, "test-users", plan);

    expect(result).toHaveLength(4);
    expect(result[0]).toEqual(page1[0]);
    expect(result[3]).toEqual(page2[1]);
    expect(calls).toHaveLength(2);
    expect(calls[1].ExclusiveStartKey).toEqual({ id: "u2" });
  });

  it("Query: enforces limit — stops early", async () => {
    const calls: any[] = [];
    const docClient = {
      send: vi.fn().mockImplementation(async (cmd: any) => {
        calls.push(cmd);
        return {
          Items: Array.from({ length: cmd.Limit }, (_, i) => ({ id: `u${i}` })),
        };
      }),
    };

    const plan: FetchAllPlan = {
      operation: "query",
      indexName: "email-index",
      keyCondition: "#n0 = :v0",
      expressionAttributeNames: { "#n0": "email" },
      expressionAttributeValues: { ":v0": "a@b.com" },
      limit: 3,
    };

    const result = await fetchAllByPlan(docClient as any, "test-users", plan);

    expect(result).toHaveLength(3);
    expect(calls).toHaveLength(1);
    expect(calls[0].Limit).toBe(3);
  });

  it("Query: passes scanIndexForward when specified", async () => {
    const calls: any[] = [];
    const docClient = {
      send: vi.fn().mockImplementation(async (cmd: any) => {
        calls.push(cmd);
        return { Items: [] };
      }),
    };

    const plan: FetchAllPlan = {
      operation: "query",
      indexName: "email-index",
      keyCondition: "#n0 = :v0",
      expressionAttributeNames: { "#n0": "email" },
      expressionAttributeValues: { ":v0": "a@b.com" },
      scanIndexForward: false,
    };

    await fetchAllByPlan(docClient as any, "test-users", plan);

    expect(calls[0].ScanIndexForward).toBe(false);
  });

  it("Query: does NOT pass scanIndexForward when not specified", async () => {
    const calls: any[] = [];
    const docClient = {
      send: vi.fn().mockImplementation(async (cmd: any) => {
        calls.push(cmd);
        return { Items: [] };
      }),
    };

    const plan: FetchAllPlan = {
      operation: "query",
      indexName: "email-index",
      keyCondition: "#n0 = :v0",
      expressionAttributeNames: { "#n0": "email" },
      expressionAttributeValues: { ":v0": "a@b.com" },
    };

    await fetchAllByPlan(docClient as any, "test-users", plan);

    expect(calls[0].ScanIndexForward).toBeUndefined();
  });

  it("Query: includes optional FilterExpression", async () => {
    const calls: any[] = [];
    const docClient = {
      send: vi.fn().mockImplementation(async (cmd: any) => {
        calls.push(cmd);
        return { Items: [{ id: "u1" }] };
      }),
    };

    const plan: FetchAllPlan = {
      operation: "query",
      indexName: "email-index",
      keyCondition: "#n0 = :v0",
      filterExpression: "#n1 = :v1",
      expressionAttributeNames: { "#n0": "email", "#n1": "status" },
      expressionAttributeValues: { ":v0": "a@b.com", ":v1": "active" },
    };

    await fetchAllByPlan(docClient as any, "test-users", plan);

    expect(calls[0].FilterExpression).toBe("#n1 = :v1");
  });

  it("Query: empty result returns []", async () => {
    const docClient = {
      send: vi.fn().mockImplementation(async () => ({ Items: [] })),
    };

    const plan: FetchAllPlan = {
      operation: "query",
      indexName: "email-index",
      keyCondition: "#n0 = :v0",
      expressionAttributeNames: { "#n0": "email" },
      expressionAttributeValues: { ":v0": "no-match" },
    };

    const result = await fetchAllByPlan(docClient as any, "test-users", plan);

    expect(result).toEqual([]);
  });

  // ── Scan path ────────────────────────────────────────────

  it("Scan: single page with items", async () => {
    const items = [{ id: "u1", role: "admin" }, { id: "u2", role: "admin" }];
    const calls: any[] = [];
    const docClient = {
      send: vi.fn().mockImplementation(async (cmd: any) => {
        calls.push(cmd);
        return { Items: items };
      }),
    };

    const plan: FetchAllPlan = {
      operation: "scan",
      expressionAttributeNames: { "#n0": "role" },
      expressionAttributeValues: { ":v0": "admin" },
      filterExpression: "#n0 = :v0",
    };

    const result = await fetchAllByPlan(docClient as any, "test-users", plan);

    expect(result).toEqual(items);
    expect(calls).toHaveLength(1);
    expect(calls[0].FilterExpression).toBe("#n0 = :v0");
  });

  it("Scan: paginated across ExclusiveStartKey", async () => {
    const page1 = [{ id: "u1" }, { id: "u2" }];
    const page2 = [{ id: "u3" }];

    const calls: any[] = [];
    const docClient = {
      send: vi.fn().mockImplementation(async (cmd: any) => {
        calls.push(cmd);
        if (calls.length === 1) {
          return { Items: page1, LastEvaluatedKey: { id: "u2" } };
        }
        return { Items: page2 };
      }),
    };

    const plan: FetchAllPlan = {
      operation: "scan",
      filterExpression: "#n0 = :v0",
      expressionAttributeNames: { "#n0": "status" },
      expressionAttributeValues: { ":v0": "active" },
    };

    const result = await fetchAllByPlan(docClient as any, "test-users", plan);

    expect(result).toHaveLength(3);
    expect(calls).toHaveLength(2);
    expect(calls[1].ExclusiveStartKey).toEqual({ id: "u2" });
  });

  it("Scan: enforces limit", async () => {
    const calls: any[] = [];
    const docClient = {
      send: vi.fn().mockImplementation(async (cmd: any) => {
        calls.push(cmd);
        return {
          Items: Array.from({ length: cmd.Limit }, (_, i) => ({ id: `u${i}` })),
        };
      }),
    };

    const plan: FetchAllPlan = {
      operation: "scan",
      filterExpression: "#n0 = :v0",
      expressionAttributeNames: { "#n0": "status" },
      expressionAttributeValues: { ":v0": "active" },
      limit: 2,
    };

    const result = await fetchAllByPlan(docClient as any, "test-users", plan);

    expect(result).toHaveLength(2);
    expect(calls).toHaveLength(1);
    expect(calls[0].Limit).toBe(2);
  });

  it("Scan: empty result returns []", async () => {
    const docClient = {
      send: vi.fn().mockImplementation(async () => ({ Items: [] })),
    };

    const plan: FetchAllPlan = {
      operation: "scan",
      filterExpression: "#n0 = :v0",
      expressionAttributeNames: { "#n0": "status" },
      expressionAttributeValues: { ":v0": "inactive" },
    };

    const result = await fetchAllByPlan(docClient as any, "test-users", plan);

    expect(result).toEqual([]);
  });

  // ── Expression safety ────────────────────────────────────

  it("compactExpr: no ExpressionAttributeNames/Values when maps are empty", async () => {
    const calls: any[] = [];
    const docClient = {
      send: vi.fn().mockImplementation(async (cmd: any) => {
        calls.push(cmd);
        return { Items: [{ id: "u1" }] };
      }),
    };

    const plan: FetchAllPlan = {
      operation: "scan",
      expressionAttributeNames: {},
      expressionAttributeValues: {},
    };

    await fetchAllByPlan(docClient as any, "test-users", plan);

    expect(calls[0].ExpressionAttributeNames).toBeUndefined();
    expect(calls[0].ExpressionAttributeValues).toBeUndefined();
  });

  it("compactExpr: with non-empty maps includes them", async () => {
    const calls: any[] = [];
    const docClient = {
      send: vi.fn().mockImplementation(async (cmd: any) => {
        calls.push(cmd);
        return { Items: [] };
      }),
    };

    const plan: FetchAllPlan = {
      operation: "scan",
      expressionAttributeNames: { "#n0": "status" },
      expressionAttributeValues: { ":v0": "active" },
    };

    await fetchAllByPlan(docClient as any, "test-users", plan);

    expect(calls[0].ExpressionAttributeNames).toEqual({ "#n0": "status" });
    expect(calls[0].ExpressionAttributeValues).toEqual({ ":v0": "active" });
  });

  it("Scan: without filterExpression omits FilterExpression from command", async () => {
    const calls: any[] = [];
    const docClient = {
      send: vi.fn().mockImplementation(async (cmd: any) => {
        calls.push(cmd);
        return { Items: [{ id: "u1" }] };
      }),
    };

    const plan: FetchAllPlan = {
      operation: "scan",
      expressionAttributeNames: {},
      expressionAttributeValues: {},
    };

    await fetchAllByPlan(docClient as any, "test-users", plan);

    expect(calls[0].FilterExpression).toBeUndefined();
  });

  it("Scan: single page — only one send call for non-paginated result", async () => {
    const docClient = {
      send: vi.fn().mockImplementation(async () => ({
        Items: [{ id: "u1" }],
      })),
    };

    const plan: FetchAllPlan = {
      operation: "scan",
      expressionAttributeNames: {},
      expressionAttributeValues: {},
    };

    const result = await fetchAllByPlan(docClient as any, "test-users", plan);

    expect(result).toHaveLength(1);
    expect(docClient.send).toHaveBeenCalledTimes(1);
  });
});
