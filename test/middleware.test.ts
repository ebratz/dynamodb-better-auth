/**
 * Middleware extension tests.
 *
 * Verifies that DynamoAdapterMiddleware hooks fire in the correct
 * order with the correct arguments for each adapter operation.
 */

import { describe, it, expect, vi } from "vitest";
import { createMethod } from "../src/adapter/methods/create";
import { findOneMethod } from "../src/adapter/methods/find-one";
import { findManyMethod } from "../src/adapter/methods/find-many";
import { updateMethod } from "../src/adapter/methods/update";
import { deleteMethod } from "../src/adapter/methods/delete";
import { countMethod } from "../src/adapter/methods/count";
import { applyMiddleware } from "../src/helpers/apply-middleware";
import type { DynamoAdapterMiddleware } from "../src/types";

// ── Test helpers ────────────────────────────────────────────────

interface CallRecord {
  hook: string;
  args: Record<string, unknown>;
}

/**
 * Creates a test middleware that records all hook invocations.
 * Each hook pushes a CallRecord onto the shared log array.
 */
function makeAuditMiddleware(log: CallRecord[]): DynamoAdapterMiddleware {
  return {
    name: "TestAudit",

    onBeforeCreate(args) {
      log.push({ hook: "onBeforeCreate", args: { ...args } });
    },
    onAfterCreate(args) {
      log.push({ hook: "onAfterCreate", args: { ...args } });
    },

    onBeforeUpdate(args) {
      log.push({ hook: "onBeforeUpdate", args: { ...args } });
    },
    onAfterUpdate(args) {
      log.push({ hook: "onAfterUpdate", args: { ...args } });
    },

    onBeforeDelete(args) {
      log.push({ hook: "onBeforeDelete", args: { ...args } });
    },
    onAfterDelete(args) {
      log.push({ hook: "onAfterDelete", args: { ...args } });
    },

    onAfterFindOne(args) {
      log.push({ hook: "onAfterFindOne", args: { ...args } });
    },
    onAfterFindMany(args) {
      log.push({ hook: "onAfterFindMany", args: { ...args } });
    },
    onAfterCount(args) {
      log.push({ hook: "onAfterCount", args: { ...args } });
    },
  };
}

function makeMockDocClient() {
  const calls: any[] = [];
  const mock = {
    send: vi.fn(async (cmd: any) => {
      calls.push(cmd.constructor.name);
      // Return minimal response to satisfy method logic
      return { Item: { id: "u1", email: "test@test.com" }, Items: [], Count: 0 };
    }),
    _calls: () => [...calls],
  };
  return mock;
}

function makeConfig() {
  return {
    client: {} as any,
    tables: { user: "test-users", session: "test-sessions", account: "test-accounts", verification: "test-verifications" },
    extensions: [] as DynamoAdapterMiddleware[],
  };
}

// ── Tests ───────────────────────────────────────────────────────

describe("applyMiddleware", () => {
  it("returns original function when no extensions configured", () => {
    const fn = async (args: any) => args;
    const wrapped = applyMiddleware([], "Test", fn);
    expect(wrapped).toBe(fn);
  });

  it("returns original function when no hooks match operation", () => {
    const log: CallRecord[] = [];
    const middleware = makeAuditMiddleware(log);
    const fn = async (args: any) => args;
    const wrapped = applyMiddleware([middleware], "NonExistent", fn);
    // Should still be the original since no hooks match this operation
    expect(wrapped).toBe(fn);
  });

  it("calls before hook, then fn, then after hook", async () => {
    const log: CallRecord[] = [];
    const middleware = makeAuditMiddleware(log);

    const fn = vi.fn(async (args: any) => ({ id: "result-1" }));
    const wrapped = applyMiddleware([middleware], "Create", fn);

    const result = await wrapped({ model: "user", data: { email: "x@y.com" } });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ id: "result-1" });

    // Hooks fired in correct order
    expect(log[0]!.hook).toBe("onBeforeCreate");
    expect(log[1]!.hook).toBe("onAfterCreate");

    // Before hook received original args
    expect(log[0]!.args.model).toBe("user");
    expect(log[0]!.args.data).toEqual({ email: "x@y.com" });

    // After hook received original args + result
    expect(log[1]!.args.result).toEqual({ id: "result-1" });
  });

  it("allows before hook to modify args (multi-tenancy pattern)", async () => {
    const log: CallRecord[] = [];
    const tenantMiddleware: DynamoAdapterMiddleware = {
      name: "TenantEnricher",
      onBeforeCreate(args) {
        return { data: { ...args.data, tenantId: "t-123" } };
      },
    };

    const fn = vi.fn(async (args: any) => args.data);
    const wrapped = applyMiddleware([tenantMiddleware], "Create", fn);

    const result = await wrapped({ model: "user", data: { email: "x@y.com" } });

    // fn should receive modified args with tenantId
    expect(fn).toHaveBeenCalledWith({
      model: "user",
      data: { email: "x@y.com", tenantId: "t-123" },
    });
    expect(result).toEqual({ email: "x@y.com", tenantId: "t-123" });
  });

  it("runs hooks from multiple middleware in array order", async () => {
    const order: string[] = [];
    const mw1: DynamoAdapterMiddleware = {
      name: "First",
      onBeforeCreate() { order.push("mw1/before"); },
      onAfterCreate() { order.push("mw1/after"); },
    };
    const mw2: DynamoAdapterMiddleware = {
      name: "Second",
      onBeforeCreate() { order.push("mw2/before"); },
      onAfterCreate() { order.push("mw2/after"); },
    };

    const fn = vi.fn(async (args: any) => ({ id: "x" }));
    const wrapped = applyMiddleware([mw1, mw2], "Create", fn);

    await wrapped({ model: "user", data: {} });
    expect(order).toEqual([
      "mw1/before", "mw2/before",
      // fn runs here
      "mw1/after", "mw2/after",
    ]);
  });

  it("handles async before hooks", async () => {
    const mw: DynamoAdapterMiddleware = {
      name: "AsyncEnricher",
      onBeforeCreate: async (args) => {
        await new Promise((r) => setTimeout(r, 1));
        return { data: { ...args.data, enriched: true } };
      },
    };

    const fn = vi.fn(async (args: any) => args.data);
    const wrapped = applyMiddleware([mw], "Create", fn);

    const result = await wrapped({ model: "user", data: { email: "x@y.com" } });
    expect(result).toEqual({ email: "x@y.com", enriched: true });
  });
});

describe("middleware integration with adapter methods", () => {
  it("create method fires create hooks", async () => {
    const config = makeConfig();
    const log: CallRecord[] = [];
    config.extensions = [makeAuditMiddleware(log)];

    const mockDoc = makeMockDocClient();
    const create = createMethod(mockDoc as any, config);
    const wrapped = applyMiddleware(config.extensions, "Create", create);

    await wrapped({ model: "user", data: { id: "u1", email: "test@test.com" } });

    // Before + after + original calls
    expect(log.map((l) => l.hook)).toEqual(["onBeforeCreate", "onAfterCreate"]);
  });

  it("findOne method fires after-findOne hook with result", async () => {
    const config = makeConfig();
    const log: CallRecord[] = [];
    config.extensions = [makeAuditMiddleware(log)];

    const mockDoc = makeMockDocClient();
    const findOne = findOneMethod(mockDoc as any, config);
    const wrapped = applyMiddleware(config.extensions, "FindOne", findOne);

    const result = await wrapped({
      model: "user",
      where: [{ field: "id", operator: "eq", value: "u1" }],
    });

    expect(log).toHaveLength(1);
    expect(log[0]!.hook).toBe("onAfterFindOne");
    expect(result).toBeDefined();
  });

  it("findMany hook fires with result array", async () => {
    const config = makeConfig();
    const log: CallRecord[] = [];
    config.extensions = [makeAuditMiddleware(log)];

    const mockDoc = makeMockDocClient();
    mockDoc.send = vi.fn(async () => ({
      Items: [
        { id: "u1", name: "Alice" },
        { id: "u2", name: "Bob" },
      ],
    }));

    const findMany = findManyMethod(mockDoc as any, config);
    const wrapped = applyMiddleware(config.extensions, "FindMany", findMany);

    const result = await wrapped({
      model: "user",
      where: [{ field: "status", operator: "eq", value: "active" }],
    });

    expect(result).toHaveLength(2);
    expect(log).toHaveLength(1);
    expect(log[0]!.hook).toBe("onAfterFindMany");
    expect(log[0]!.args.result).toEqual(result);
  });

  it("count hook fires with numeric result", async () => {
    const config = makeConfig();
    const log: CallRecord[] = [];
    config.extensions = [makeAuditMiddleware(log)];

    const mockDoc = makeMockDocClient();
    mockDoc.send = vi.fn(async () => ({ Count: 42, ScannedCount: 42 }));

    const count = countMethod(mockDoc as any, config);
    const wrapped = applyMiddleware(config.extensions, "Count", count);

    const result = await wrapped({
      model: "user",
      where: [{ field: "status", operator: "eq", value: "active" }],
    });

    expect(result).toBe(42);
    expect(log).toHaveLength(1);
    expect(log[0]!.hook).toBe("onAfterCount");
    expect(log[0]!.args.result).toBe(42);
  });

  it("delete hooks fire with result (null when not found)", async () => {
    const config = makeConfig();
    const log: CallRecord[] = [];
    config.extensions = [makeAuditMiddleware(log)];

    const mockDoc = makeMockDocClient();
    mockDoc.send = vi.fn(async () => ({})); // No Item returned

    const del = deleteMethod(mockDoc as any, config);
    const wrapped = applyMiddleware(config.extensions, "Delete", del);

    const result = await wrapped({
      model: "user",
      where: [{ field: "id", operator: "eq", value: "u-nonexistent" }],
    });

    // DeleteCommand returns Attributes only when item existed;
    // undefined means no item was found.
    expect(result).toBeUndefined();
    expect(log.length).toBeGreaterThanOrEqual(1);
  });

  it("update hooks fire with before/after sequence", async () => {
    const config = makeConfig();
    const log: CallRecord[] = [];
    config.extensions = [makeAuditMiddleware(log)];

    const mockDoc = makeMockDocClient();
    mockDoc.send = vi.fn(async (cmd: any) => {
      if (cmd.constructor.name === "GetCommand") {
        return { Item: { id: "u1", name: "Old" } };
      }
      return { Attributes: { id: "u1", name: "New" } };
    });

    const update = updateMethod(mockDoc as any, config);
    const wrapped = applyMiddleware(config.extensions, "Update", update);

    const result = await wrapped({
      model: "user",
      where: [{ field: "id", operator: "eq", value: "u1" }],
      update: { name: "New" },
    });

    expect(result).toBeDefined();
    // Before hook called before update, after hook called after
    expect(log[0]!.hook).toBe("onBeforeUpdate");
    expect(log[1]!.hook).toBe("onAfterUpdate");
  });
});
