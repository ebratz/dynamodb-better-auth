import { describe, it, expect, vi } from "vitest";
import { findOneMethod } from "../src/adapter/methods/find-one";
import type { DynamoDBAdapterConfig } from "../src/types";

function makeDocClient(responses: any | any[]) {
  const respArray = Array.isArray(responses) ? responses : [responses];
  let callIdx = 0;
  return {
    send: vi.fn().mockImplementation(async (_cmd: any) => {
      const r = respArray[callIdx] ?? {};
      callIdx++;
      return r;
    }),
    _callCount: () => callIdx,
  } as any;
}

function makeConfig(overrides: Partial<DynamoDBAdapterConfig> = {}): DynamoDBAdapterConfig {
  return {
    client: {} as any,
    tables: {
      user: "test-users",
      session: "test-sessions",
      account: "test-accounts",
      verification: "test-verifications",
    },
    indexes: {
      user: { email: { indexName: "email-index", hashKey: "email" } },
      session: { userId: { indexName: "userId-index", hashKey: "userId" } },
      account: {
        id: { indexName: "by-id", hashKey: "id", projection: "KEYS_ONLY" },
      },
    },
    ...overrides,
  } as any;
}

describe("findOne", () => {
  it("Tier 1: GetItem by PK", async () => {
    const docClient = makeDocClient({ Item: { id: "u1", email: "a@b.com" } });
    const config = makeConfig();
    const findOne = findOneMethod(docClient, config);

    const result = await findOne({
      model: "user",
      where: [{ field: "id", operator: "eq", value: "u1" }],
    });

    expect(result).toEqual({ id: "u1", email: "a@b.com" });
    expect(docClient.send).toHaveBeenCalled();
  });

  it("Tier 1: GetItem for composite PK (account)", async () => {
    const docClient = makeDocClient({ Item: { providerId: "google", accountId: "12345", id: "acc1" } });
    const config = makeConfig();
    const findOne = findOneMethod(docClient, config);

    const result = await findOne({
      model: "account",
      where: [
        { field: "providerId", operator: "eq", value: "google" },
        { field: "accountId", operator: "eq", value: "12345" },
      ],
    });

    expect(result).toBeTruthy();
    expect(result!.id).toBe("acc1");
  });

  it("Tier 2: Query on GSI", async () => {
    const docClient = makeDocClient({ Items: [{ id: "u1", email: "a@b.com" }] });
    const config = makeConfig();
    const findOne = findOneMethod(docClient, config);

    const result = await findOne({
      model: "user",
      where: [{ field: "email", operator: "eq", value: "a@b.com" }],
    });

    expect(result).toEqual({ id: "u1", email: "a@b.com" });
  });

  it("Tier 2: KEYS_ONLY GSI triggers follow-up GetItem for full row", async () => {
    const docClient = makeDocClient([
      // Query on by-id GSI returns keys only
      { Items: [{ providerId: "google", accountId: "12345" }] },
      // Follow-up GetItem returns full row
      { Item: { id: "acc1", providerId: "google", accountId: "12345", userId: "u1", accessToken: "tok" } },
    ]);
    const config = makeConfig();
    const findOne = findOneMethod(docClient, config);

    const result = await findOne({
      model: "account",
      where: [{ field: "id", operator: "eq", value: "acc1" }],
    });

    expect(result).toBeTruthy();
    expect(result!.accessToken).toBe("tok");
    expect(docClient._callCount()).toBe(2);  // Query + GetItem
  });

  it("Tier 3: Scan + FilterExpression", async () => {
    const docClient = makeDocClient({ Items: [{ id: "u1", name: "Alice" }] });
    const config = makeConfig();
    const findOne = findOneMethod(docClient, config);

    const result = await findOne({
      model: "user",
      where: [{ field: "name", operator: "eq", value: "Alice" }],
    });

    expect(result).toEqual({ id: "u1", name: "Alice" });
  });

  it("Tier 3: returns null when Scan finds no match", async () => {
    const docClient = makeDocClient({ Items: [] });
    const config = makeConfig();
    const findOne = findOneMethod(docClient, config);

    const result = await findOne({
      model: "user",
      where: [{ field: "name", operator: "eq", value: "Nobody" }],
    });

    expect(result).toBeNull();
  });

  it("Tier 3: emits debugLogs warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const docClient = makeDocClient({ Items: [{ id: "u1" }] });
    const config = makeConfig({ debugLogs: true });
    const findOne = findOneMethod(docClient, config);

    await findOne({
      model: "user",
      where: [{ field: "name", operator: "contains", value: "li" }],
    });

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("returns null when not found", async () => {
    const docClient = makeDocClient({});
    const config = makeConfig();
    const findOne = findOneMethod(docClient, config);

    const result = await findOne({
      model: "user",
      where: [{ field: "id", operator: "eq", value: "nonexistent" }],
    });

    expect(result).toBeNull();
  });

  it("Tier 1 client-side filter: matches when extra clause passes", async () => {
    const docClient = makeDocClient({ Item: { id: "u1", status: "active", email: "a@b.com" } });
    const config = makeConfig();
    const findOne = findOneMethod(docClient, config);

    // PK eq + extra field → Tier 1 GetItem with client-side filter
    const result = await findOne({
      model: "user",
      where: [
        { field: "id", operator: "eq", value: "u1" },
        { field: "status", operator: "eq", value: "active" },
      ],
    });

    // Client-side filter passes: status matches
    expect(result).toEqual({ id: "u1", status: "active", email: "a@b.com" });
    expect(docClient.send).toHaveBeenCalled();
  });

  it("Tier 1 client-side filter: rejects when extra clause fails", async () => {
    const docClient = makeDocClient({ Item: { id: "u1", status: "inactive", email: "a@b.com" } });
    const config = makeConfig();
    const findOne = findOneMethod(docClient, config);

    // PK eq + extra field → Tier 1 GetItem with client-side filter
    const result = await findOne({
      model: "user",
      where: [
        { field: "id", operator: "eq", value: "u1" },
        { field: "status", operator: "eq", value: "active" },
      ],
    });

    // Client-side filter fails: status is inactive, not active
    expect(result).toBeNull();
  });
});
