import { describe, expect, it, vi } from "vitest";
import { measureLatency } from "../src/helpers/metrics";
import { validateConfig } from "../src/helpers/validate-config";
import { sanitizeForWrite } from "../src/helpers/update-item";
import { withTtlAttribute } from "../src/helpers/ttl";
import type { DynamoDBAdapterConfig } from "../src/types";
import { dynamodbAdapter } from "../src/adapter/factory";
import type { TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";

const config = { tables: { user: "users", session: "sessions", account: "accounts", verification: "verifications" } } as DynamoDBAdapterConfig;

describe("audit configuration and extension regressions", () => {
  it("isolates transaction transforms when a factory is reused", async () => {
    const send = vi.fn(async (_command: { input: TransactWriteCommandInput }) => ({}));
    const factory = dynamodbAdapter({ ...config, client: { send, config: { translateConfig: {} } } as unknown as DynamoDBAdapterConfig["client"] });
    const first = factory({ user: { fields: { name: "displayName" } } });
    factory({ user: { fields: { name: "fullName" } } });
    await first.transaction(tx => tx.create({ model: "user", data: { name: "First", email: "first@test.com" } }));
    const item = send.mock.calls[0]?.[0].input.TransactItems?.[0]?.Put?.Item;
    expect(item).toMatchObject({ displayName: "First" });
    expect(item).not.toHaveProperty("fullName");
  });
  it.each([0, -1, 1.5, NaN, Infinity])("rejects invalid update concurrency %s", concurrency => {
    expect(() => validateConfig({ ...config, updateManyConcurrency: concurrency })).toThrow("updateManyConcurrency");
  });
  it("does not turn a committed operation into a failure when metrics throws", async () => {
    const metrics = vi.fn(() => { throw new Error("metrics unavailable"); });
    await expect(measureLatency(metrics, "create", "user", async () => ({ id: "committed" }))).resolves.toEqual({ id: "committed" });
    expect(metrics).toHaveBeenCalledTimes(1);
  });
  it("preserves the database error when metrics throws", async () => {
    const error = new Error("database failure");
    await expect(measureLatency(() => { throw new Error("metrics failure"); }, "create", "user", async () => { throw error; })).rejects.toBe(error);
  });
  it("serializes nested dates without changing the input or binary values", () => {
    const date = new Date("2026-09-12T00:00:00Z");
    const binary = new Uint8Array([1, 2]);
    const input = { nested: { list: [date] }, binary };
    expect(sanitizeForWrite(input)).toEqual({ nested: { list: [date.toISOString()] }, binary });
    expect(input.nested.list[0]).toBe(date);
  });
  it("disables an existing TTL when the expiry is cleared", () => {
    expect(withTtlAttribute({ ...config, ttlFields: { session: "expiresAt" } }, "session", { expiresAt: null })).toEqual({ expiresAt: null, ttl: null });
  });
});
