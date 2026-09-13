import { describe, it, expect, vi } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { deleteManyMethod } from "../src/adapter/methods/delete-many";
import type { DynamoDBAdapterConfig } from "../src/types";

function setup(handler: (name: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>, overrides: Partial<DynamoDBAdapterConfig> = {}) {
  const send = vi.fn((command: { constructor: { name: string }; input: Record<string, unknown> }) => handler(command.constructor.name, command.input));
  const client = { send } as unknown as DynamoDBDocumentClient;
  const config = { client, tables: { user: "users", session: "sessions", account: "accounts", verification: "verifications" }, ...overrides };
  return { send, remove: deleteManyMethod(client, config) };
}
const where = [{ field: "name", operator: "eq", value: "A" }];
const rows = [{ id: "1", name: "A" }, { id: "2", name: "A" }];

describe("conditional deleteMany", () => {
  it("counts deleted preimages and puts predicates on every delete", async () => {
    const { remove, send } = setup(async (name, input) => name === "ScanCommand" ? { Items: rows } : { Attributes: input.Key });
    expect(await remove({ model: "user", where })).toBe(2);
    const deletes = send.mock.calls.map(([c]) => c).filter(c => c.constructor.name === "DeleteCommand");
    expect(deletes).toHaveLength(2);
    for (const command of deletes) {
      expect(command.input.ConditionExpression).toContain("attribute_exists");
      expect(Object.values(command.input.ExpressionAttributeNames as object)).toContain("name");
      expect(command.input.ReturnValues).toBe("ALL_OLD");
    }
  });
  it("does not count concurrently changed or deleted rows", async () => {
    let writes = 0;
    const { remove } = setup(async name => {
      if (name === "ScanCommand") return { Items: rows };
      if (++writes === 1) throw Object.assign(new Error("changed"), { name: "ConditionalCheckFailedException" });
      return { Attributes: rows[1] };
    });
    expect(await remove({ model: "user", where })).toBe(1);
  });
  it("supports empty predicates for framework cleanup", async () => {
    const { remove } = setup(async name => name === "ScanCommand" ? { Items: rows } : { Attributes: rows[0] });
    expect(await remove({ model: "user", where: [] })).toBe(2);
  });
  it("returns zero for an empty table", async () => {
    const { remove } = setup(async () => ({ Items: [] }));
    expect(await remove({ model: "user" })).toBe(0);
  });
  it("propagates infrastructure errors after partial progress", async () => {
    let writes = 0;
    const { remove } = setup(async name => {
      if (name === "ScanCommand") return { Items: rows };
      if (++writes === 2) throw new Error("service unavailable");
      return { Attributes: rows[0] };
    });
    await expect(remove({ model: "user", where })).rejects.toThrow("service unavailable");
    expect(writes).toBe(2);
  });
  it("enforces the item limit before writing", async () => {
    const { remove, send } = setup(async () => ({ Items: rows }), { maxDeleteManyItems: 1 });
    await expect(remove({ model: "user", where })).rejects.toMatchObject({ code: "TOO_MANY_ITEMS" });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("handles a primary-key selection", async () => {
    const { remove } = setup(async name => name === "GetCommand" ? { Item: rows[0] } : { Attributes: rows[0] });
    expect(await remove({ model: "user", where: [{ field: "id", value: "1" }] })).toBe(1);
  });
  it("paginates filtered scans before conditional deletion", async () => {
    let pages = 0;
    const { remove } = setup(async name => name === "ScanCommand" ? (++pages === 1 ? { Items: [], LastEvaluatedKey: { id: "0" } } : { Items: rows }) : { Attributes: rows[0] });
    expect(await remove({ model: "user", where })).toBe(2);
    expect(pages).toBe(2);
  });
});
