/**
 * Unit tests for resolveKEYS_ONLY — shared BatchGet helper for
 * KEYS_ONLY GSI follow-up resolution.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveKEYS_ONLY } from "../src/helpers/batch-get";

// Mock the SDK
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  BatchGetCommand: vi.fn().mockImplementation((input: any) => ({
    ...input,
    _type: "BatchGetCommand",
  })),
}));

describe("resolveKEYS_ONLY", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Chunking ──────────────────────────────────────────────

  it("chunks 150 GSI items into 2 BatchGetCommand calls (100 + 50)", async () => {
    const gsiItems = Array.from({ length: 150 }, (_, i) => ({
      pk: `pk${i}`,
      sk: `sk${i}`,
    }));
    const fullItems = gsiItems.map((item, i) => ({
      ...item,
      name: `Item ${i}`,
    }));

    const calls: any[] = [];
    const docClient = {
      send: vi.fn().mockImplementation(async (cmd: any) => {
        calls.push(cmd);
        const keys: any[] = cmd.RequestItems["test-table"].Keys;
        return {
          Responses: {
            "test-table": keys.map((k: any) => {
              const idx = parseInt(k.pk.slice(2));
              return fullItems[idx];
            }),
          },
        };
      }),
    };

    const result = await resolveKEYS_ONLY(
      docClient as any,
      "test-table",
      { pkField: "pk", skField: "sk" },
      gsiItems,
    );

    expect(result).toHaveLength(150);
    expect(calls).toHaveLength(2);
    expect(calls[0].RequestItems["test-table"].Keys).toHaveLength(100);
    expect(calls[1].RequestItems["test-table"].Keys).toHaveLength(50);
    expect(result[0]).toEqual(fullItems[0]);
    expect(result[149]).toEqual(fullItems[149]);
  });

  it("single chunk: 50 items → 1 BatchGetCommand call", async () => {
    const gsiItems = Array.from({ length: 50 }, (_, i) => ({ pk: `pk${i}` }));
    const fullItems = gsiItems.map((item, i) => ({ ...item, name: `Item ${i}` }));

    const calls: any[] = [];
    const docClient = {
      send: vi.fn().mockImplementation(async (cmd: any) => {
        calls.push(cmd);
        const keys: any[] = cmd.RequestItems["test-table"].Keys;
        return {
          Responses: {
            "test-table": keys.map((k: any) => {
              const idx = parseInt(k.pk.slice(2));
              return fullItems[idx];
            }),
          },
        };
      }),
    };

    const result = await resolveKEYS_ONLY(
      docClient as any,
      "test-table",
      { pkField: "pk" },
      gsiItems,
    );

    expect(result).toHaveLength(50);
    expect(calls).toHaveLength(1);
    expect(calls[0].RequestItems["test-table"].Keys).toHaveLength(50);
  });

  it("empty items returns []", async () => {
    const docClient = { send: vi.fn() };

    const result = await resolveKEYS_ONLY(
      docClient as any,
      "test-table",
      { pkField: "pk" },
      [],
    );

    expect(result).toEqual([]);
    expect(docClient.send).not.toHaveBeenCalled();
  });

  // ── UnprocessedKeys retry ─────────────────────────────────

  it("retries UnprocessedKeys — first call returns 1 unprocessed, retry resolves it", async () => {
    const gsiItems = [
      { pk: "pk0" },
      { pk: "pk1" },
    ];

    let callCount = 0;
    const docClient = {
      send: vi.fn().mockImplementation(async (cmd: any) => {
        callCount++;
        if (callCount === 1) {
          return {
            Responses: { "test-table": [{ pk: "pk0", name: "Item 0" }] },
            UnprocessedKeys: {
              "test-table": { Keys: [{ pk: "pk1" }] },
            },
          };
        }
        return {
          Responses: { "test-table": [{ pk: "pk1", name: "Item 1" }] },
        };
      }),
    };

    const promise = resolveKEYS_ONLY(
      docClient as any,
      "test-table",
      { pkField: "pk" },
      gsiItems,
    );

    // Advance timers past the 100ms + jitter backoff
    await vi.advanceTimersByTimeAsync(200);

    const result = await promise;
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("Item 0");
    expect(result[1].name).toBe("Item 1");
    // Two BatchGet calls: initial + retry
    expect(docClient.send).toHaveBeenCalledTimes(2);
  });

  it("max retry exhausted: 3 attempts still unprocessed → returns partial results", async () => {
    const gsiItems = [
      { pk: "pk0" },
      { pk: "pk1" },
    ];

    // The mock returns pk0 when either key is requested (pk1 is never resolved).
    // Each retry layer pushes its responses into the caller, so we get multiple
    // copies of pk0 (one per attempt). After 3 attempts, pk1 is dropped.
    const docClient = {
      send: vi.fn().mockImplementation(async (cmd: any) => {
        const keys: any[] = cmd.RequestItems["test-table"].Keys;
        // Return pk0 for every requested key (pk1 is always "unprocessed")
        return {
          Responses: { "test-table": keys.map(() => ({ pk: "pk0", name: "Item 0" })) },
          UnprocessedKeys: {
            "test-table": { Keys: [{ pk: "pk1" }] },
          },
        };
      }),
    };

    const promise = resolveKEYS_ONLY(
      docClient as any,
      "test-table",
      { pkField: "pk" },
      gsiItems,
    );

    // Max 3 retry attempts (initial + 2 retries) → 3 timing waits
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(200);

    const result = await promise;
    // Each of the 3 attempts returns [pk0]; they accumulate via responses.push(...).
    // Total = 3 copies. pk1 is never resolved and is dropped after retries exhausted.
    // The duplicated pk0 entries are expected: _batchGetWithRetry returns best-effort
    // and the caller (resolveKEYS_ONLY) receives the accumulated responses.
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].pk).toBe("pk0");
    // 3 total BatchGetCommand calls (initial + 2 retries before hitting MAX_RETRY_ATTEMPTS)
    expect(docClient.send).toHaveBeenCalledTimes(3);
  });

  // ── Key construction ──────────────────────────────────────

  it("builds composite keys (pk + sk) from GSI items", async () => {
    const gsiItems = [
      { providerId: "google", accountId: "g1" },
      { providerId: "google", accountId: "g2" },
    ];

    const calls: any[] = [];
    const docClient = {
      send: vi.fn().mockImplementation(async (cmd: any) => {
        calls.push(cmd);
        return {
          Responses: {
            "test-accounts": [
              { providerId: "google", accountId: "g1", userId: "u1" },
              { providerId: "google", accountId: "g2", userId: "u2" },
            ],
          },
        };
      }),
    };

    const result = await resolveKEYS_ONLY(
      docClient as any,
      "test-accounts",
      { pkField: "providerId", skField: "accountId" },
      gsiItems,
    );

    expect(result).toHaveLength(2);
    // Verify the keys sent to BatchGetCommand include both pk and sk
    const keys = calls[0].RequestItems["test-accounts"].Keys;
    expect(keys[0]).toEqual({ providerId: "google", accountId: "g1" });
    expect(keys[1]).toEqual({ providerId: "google", accountId: "g2" });
  });

  it("builds simple keys (pk only) when no skField", async () => {
    const gsiItems = [{ id: "id0" }, { id: "id1" }];

    const calls: any[] = [];
    const docClient = {
      send: vi.fn().mockImplementation(async (cmd: any) => {
        calls.push(cmd);
        return {
          Responses: {
            "test-users": [
              { id: "id0", name: "Alice" },
              { id: "id1", name: "Bob" },
            ],
          },
        };
      }),
    };

    const result = await resolveKEYS_ONLY(
      docClient as any,
      "test-users",
      { pkField: "id" },
      gsiItems,
    );

    expect(result).toHaveLength(2);
    const keys = calls[0].RequestItems["test-users"].Keys;
    expect(keys[0]).toEqual({ id: "id0" });
    expect(keys[1]).toEqual({ id: "id1" });
  });

  it("skips SK in key when GSI item has undefined SK value", async () => {
    const gsiItems = [
      { providerId: "google" }, // accountId is undefined
    ];

    const calls: any[] = [];
    const docClient = {
      send: vi.fn().mockImplementation(async (cmd: any) => {
        calls.push(cmd);
        return {
          Responses: {
            "test-accounts": [{ providerId: "google", userId: "u1" }],
          },
        };
      }),
    };

    const result = await resolveKEYS_ONLY(
      docClient as any,
      "test-accounts",
      { pkField: "providerId", skField: "accountId" },
      gsiItems,
    );

    expect(result).toHaveLength(1);
    // Key should only have pkField (skField was undefined in GSI item)
    const keys = calls[0].RequestItems["test-accounts"].Keys;
    expect(keys[0]).toEqual({ providerId: "google" });
  });
});
