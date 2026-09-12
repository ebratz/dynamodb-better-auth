import { describe, it, expect, vi } from "vitest";
import { resolveQueryPlan, ttlPruneWhere } from "../src/helpers/query-planner";
import { findOneMethod } from "../src/adapter/methods/find-one";
import { findManyMethod } from "../src/adapter/methods/find-many";
import { countMethod } from "../src/adapter/methods/count";
import { deleteMethod } from "../src/adapter/methods/delete";
import { deleteManyMethod } from "../src/adapter/methods/delete-many";
import { updateMethod } from "../src/adapter/methods/update";
import { updateManyMethod } from "../src/adapter/methods/update-many";
import { consumeOneMethod } from "../src/adapter/methods/consume-one";
import { createMethod } from "../src/adapter/methods/create";
import { txCreate } from "../src/adapter/tx-create";
import { txUpdate } from "../src/adapter/tx-update";
import { TTL_GRACE_SECONDS } from "../src/helpers/ttl";
import type { DynamoDBAdapterConfig } from "../src/types";

// All SDK commands the methods under test import must exist at module load.
vi.mock("@aws-sdk/lib-dynamodb", () => {
  const cmd = (name: string) =>
    vi.fn().mockImplementation((input: any) => ({ ...input, _type: name }));
  return {
    GetCommand: cmd("GetCommand"),
    PutCommand: cmd("PutCommand"),
    UpdateCommand: cmd("UpdateCommand"),
    DeleteCommand: cmd("DeleteCommand"),
    QueryCommand: cmd("QueryCommand"),
    ScanCommand: cmd("ScanCommand"),
    BatchWriteCommand: cmd("BatchWriteCommand"),
    BatchGetCommand: cmd("BatchGetCommand"),
    TransactWriteCommand: cmd("TransactWriteCommand"),
  };
});

function makeDocClient(impl: (cmd: any) => Promise<any> = async () => ({})) {
  const calls: any[] = [];
  const send = vi.fn().mockImplementation(async (c: any) => {
    calls.push(c);
    return impl(c);
  });
  return { send, _calls: () => calls } as any;
}

const TTL_CONFIG: DynamoDBAdapterConfig = {
  client: {} as any,
  tables: {
    user: "test-users",
    session: "test-sessions",
    account: "test-accounts",
    verification: "test-verifications",
    rateLimit: "test-ratelimits",
  },
  indexes: {
    user: { email: { indexName: "email-index", hashKey: "email" } },
    session: { userId: { indexName: "userId-index", hashKey: "userId" } },
    verification: {
      identifier: { indexName: "identifier-index", hashKey: "identifier" },
    },
  },
  ttlFields: {
    verification: "expiresAt",
    session: "expiresAt",
    rateLimit: "lastRequest",
  },
};

describe("ttlPruneWhere", () => {
  it("recognises the exact sweep shape", () => {
    expect(
      ttlPruneWhere([{ field: "expiresAt", operator: "lt", value: new Date() }], "expiresAt"),
    ).toBe(true);
    expect(
      ttlPruneWhere([{ field: "expiresAt", operator: "lte", value: new Date() }], "expiresAt"),
    ).toBe(true);
    // default operator (eq) must NOT be treated as a sweep
    expect(
      ttlPruneWhere([{ field: "expiresAt", value: new Date() }], "expiresAt"),
    ).toBe(false);
  });

  it("rejects a model with no declared TTL field", () => {
    expect(
      ttlPruneWhere([{ field: "expiresAt", operator: "lt", value: new Date() }], undefined),
    ).toBe(false);
  });

  it("rejects a sweep with any second clause", () => {
    expect(
      ttlPruneWhere(
        [
          { field: "identifier", operator: "eq", value: "x" },
          { field: "expiresAt", operator: "lt", value: new Date() },
        ],
        "expiresAt",
      ),
    ).toBe(false);
  });

  it("rejects liveness ranges (gt/gte) and other operators", () => {
    expect(
      ttlPruneWhere([{ field: "expiresAt", operator: "gt", value: new Date() }], "expiresAt"),
    ).toBe(false);
    expect(
      ttlPruneWhere([{ field: "expiresAt", operator: "eq", value: new Date() }], "expiresAt"),
    ).toBe(false);
  });

  it("rejects a range on a different field", () => {
    expect(
      ttlPruneWhere([{ field: "createdAt", operator: "lt", value: new Date() }], "expiresAt"),
    ).toBe(false);
  });

  it("rejects an OR-connected clause", () => {
    expect(
      ttlPruneWhere(
        [{ field: "expiresAt", operator: "lt", value: new Date(), connector: "OR" }],
        "expiresAt",
      ),
    ).toBe(false);
  });
});

describe("resolveQueryPlan — TTL prune", () => {
  it("returns a ttlPrune plan for the declared sweep", () => {
    const plan = resolveQueryPlan(
      [{ field: "expiresAt", operator: "lt", value: new Date() }],
      "verification",
      TTL_CONFIG,
    );
    expect(plan.ttlPrune).toBe(true);
    expect(plan.alwaysFalse).toBeFalsy();
  });

  it("does not prune a model with no declared TTL field", () => {
    const plan = resolveQueryPlan(
      [{ field: "createdAt", operator: "lt", value: new Date() }],
      "user",
      TTL_CONFIG,
    );
    expect(plan.ttlPrune).toBeFalsy();
  });

  it("does not prune a sweep that carries a key clause", () => {
    const plan = resolveQueryPlan(
      [
        { field: "identifier", operator: "eq", value: "state-1" },
        { field: "expiresAt", operator: "lt", value: new Date() },
      ],
      "verification",
      TTL_CONFIG,
    );
    expect(plan.ttlPrune).toBeFalsy();
    expect(plan.operation).toBe("query");
  });
});

describe("expiry sweep is answered without a DynamoDB call", () => {
  const sweep = [{ field: "expiresAt", operator: "lt", value: new Date() }];

  it("findMany returns []", async () => {
    const docClient = makeDocClient();
    const result = await findManyMethod(docClient, TTL_CONFIG)({
      model: "verification",
      where: sweep,
      sortBy: { field: "createdAt", direction: "desc" },
      limit: 1,
    });
    expect(result).toEqual([]);
    expect(docClient._calls()).toHaveLength(0);
  });

  it("findOne returns null", async () => {
    const docClient = makeDocClient();
    const result = await findOneMethod(docClient, TTL_CONFIG)({
      model: "verification",
      where: sweep,
    });
    expect(result).toBeNull();
    expect(docClient._calls()).toHaveLength(0);
  });

  it("count returns 0", async () => {
    const docClient = makeDocClient();
    const result = await countMethod(docClient, TTL_CONFIG)({
      model: "verification",
      where: sweep,
    });
    expect(result).toBe(0);
    expect(docClient._calls()).toHaveLength(0);
  });

  it("deleteMany returns 0 (the maxDeleteManyItems cap is never reached)", async () => {
    const docClient = makeDocClient();
    const result = await deleteManyMethod(docClient, TTL_CONFIG)({
      model: "verification",
      where: sweep,
    });
    expect(result).toBe(0);
    expect(docClient._calls()).toHaveLength(0);
  });

  it("updateMany returns 0", async () => {
    const docClient = makeDocClient();
    const result = await updateManyMethod(docClient, TTL_CONFIG)({
      model: "verification",
      where: sweep,
      update: { value: "x" },
    });
    expect(result).toBe(0);
    expect(docClient._calls()).toHaveLength(0);
  });

  it("delete is a no-op", async () => {
    const docClient = makeDocClient();
    await deleteMethod(docClient, TTL_CONFIG)({
      model: "verification",
      where: sweep,
    });
    expect(docClient._calls()).toHaveLength(0);
  });

  it("update returns null", async () => {
    const docClient = makeDocClient();
    const result = await updateMethod(docClient, TTL_CONFIG)({
      model: "verification",
      where: sweep,
      update: { value: "x" },
    });
    expect(result).toBeNull();
    expect(docClient._calls()).toHaveLength(0);
  });

  it("consumeOne returns null", async () => {
    const docClient = makeDocClient();
    const result = await consumeOneMethod(docClient, TTL_CONFIG)({
      model: "verification",
      where: sweep,
    });
    expect(result).toBeNull();
    expect(docClient._calls()).toHaveLength(0);
  });
});

describe("non-prune shapes still hit DynamoDB", () => {
  it("a sweep carrying a key clause is a real Query", async () => {
    const docClient = makeDocClient(async () => ({ Items: [] }));
    await findManyMethod(docClient, TTL_CONFIG)({
      model: "verification",
      where: [
        { field: "identifier", operator: "eq", value: "state-1" },
        { field: "expiresAt", operator: "lt", value: new Date() },
      ],
      sortBy: { field: "createdAt", direction: "desc" },
      limit: 1,
    });
    const calls = docClient._calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]._type).toBe("QueryCommand");
  });

  it("the same range on a non-TTL model falls back to a Scan", async () => {
    const docClient = makeDocClient(async () => ({ Items: [] }));
    await findManyMethod(docClient, TTL_CONFIG)({
      model: "user",
      where: [{ field: "createdAt", operator: "lt", value: new Date() }],
    });
    const calls = docClient._calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]._type).toBe("ScanCommand");
  });

  it("a liveness range on a TTL model is not pruned", async () => {
    const docClient = makeDocClient(async () => ({ Items: [] }));
    await findManyMethod(docClient, TTL_CONFIG)({
      model: "verification",
      where: [{ field: "expiresAt", operator: "gt", value: new Date() }],
    });
    const calls = docClient._calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]._type).toBe("ScanCommand");
  });
});

describe("TTL attribute is written on writes", () => {
  const ISO = "2030-01-01T00:00:00.000Z";
  const expectedTtl = Math.floor(Date.parse(ISO) / 1000) + TTL_GRACE_SECONDS;

  it("create writes the numeric TTL attribute (date field)", async () => {
    const docClient = makeDocClient();
    await createMethod(docClient, TTL_CONFIG)({
      model: "verification",
      data: { id: "v1", identifier: "state", value: "{}", expiresAt: new Date(ISO) },
    });
    const [cmd] = docClient._calls();
    expect(cmd._type).toBe("PutCommand");
    expect(cmd.Item.ttl).toBe(expectedTtl);
  });

  it("create writes the numeric TTL attribute (epoch-ms number field)", async () => {
    const ms = 1_700_000_000_000;
    const docClient = makeDocClient();
    await createMethod(docClient, TTL_CONFIG)({
      model: "rateLimit",
      data: { key: "ip:1", count: 1, lastRequest: ms },
    });
    const [cmd] = docClient._calls();
    expect(cmd.Item.ttl).toBe(ms / 1000 + TTL_GRACE_SECONDS);
  });

  it("update recomputes the TTL attribute on a sliding refresh", async () => {
    const docClient = makeDocClient();
    await updateMethod(docClient, TTL_CONFIG)({
      model: "session",
      where: [{ field: "token", operator: "eq", value: "s1" }],
      update: { expiresAt: new Date(ISO) },
    });
    const [cmd] = docClient._calls();
    expect(cmd._type).toBe("UpdateCommand");
    expect(Object.values(cmd.ExpressionAttributeValues)).toContain(expectedTtl);
  });

  it("updateMany recomputes the TTL attribute for every matched row", async () => {
    const docClient = makeDocClient(async (cmd) => {
      if (cmd._type === "QueryCommand") return { Items: [{ token: "t1" }, { token: "t2" }] };
      return {};
    });
    const updated = await updateManyMethod(docClient, TTL_CONFIG)({
      model: "session",
      where: [{ field: "userId", operator: "eq", value: "u1" }],
      update: { expiresAt: new Date(ISO) },
    });
    expect(updated).toBe(2);
    const updates = docClient._calls().filter((c: any) => c._type === "UpdateCommand");
    expect(updates).toHaveLength(2);
    for (const cmd of updates) {
      expect(Object.values(cmd.ExpressionAttributeValues)).toContain(expectedTtl);
    }
  });
});

// ── Transaction path ────────────────────────────────────────────

function makeTxCtx(config: DynamoDBAdapterConfig, overrides: Record<string, any> = {}) {
  const writeBuffer: any[] = [];
  return {
    writeBuffer,
    nativeAdapter: {
      findOne: vi.fn().mockResolvedValue({ token: "t1", expiresAt: "2020-01-01T00:00:00.000Z" }),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      ...overrides.nativeAdapter,
    },
    config,
    getTable: (m: string) => config.tables[m] ?? `${m}-test`,
    getHelpers: () => ({
      transformInput: async (d: any) => d,
      transformOutput: async (d: any) => d,
      getDefaultModelName: (m: string) => m,
      transformWhereClause: ({ where }: any) => where,
      getModelName: (m: string) => m,
    }),
    hasEmailUniqueness: { value: false },
  } as any;
}

describe("TTL attribute in the transaction path", () => {
  const ISO = "2030-01-01T00:00:00.000Z";
  const expectedTtl = Math.floor(Date.parse(ISO) / 1000) + TTL_GRACE_SECONDS;

  it("txCreate buffers a Put with the TTL attribute", async () => {
    const ctx = makeTxCtx(TTL_CONFIG);
    await txCreate(ctx, {
      model: "verification",
      data: { id: "v1", identifier: "state", expiresAt: new Date(ISO) },
    });
    const put = ctx.writeBuffer.find((a: any) => a.Put);
    expect(put.Put.Item.ttl).toBe(expectedTtl);
  });

  it("txUpdate buffers an Update with the recomputed TTL attribute", async () => {
    const ctx = makeTxCtx(TTL_CONFIG);
    await txUpdate(ctx, {
      model: "session",
      where: [{ field: "token", operator: "eq", value: "t1" }],
      update: { expiresAt: new Date(ISO) },
    });
    const update = ctx.writeBuffer.find((a: any) => a.Update);
    expect(update).toBeDefined();
    expect(Object.values(update.Update.ExpressionAttributeValues)).toContain(expectedTtl);
  });
});
