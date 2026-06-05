import { describe, it, expect } from "vitest";
import { resolveFilter } from "../src/helpers/query-planner";

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
  };
}

describe("resolveFilter", () => {
  it("returns expression for eq operator", () => {
    const result = resolveFilter(
      [{ field: "status", operator: "eq", value: "active" }],
      "user",
      makeConfig(),
    );
    expect(result!.expression).toBe("#n0 = :v0");
    expect(result!.expressionAttributeNames).toEqual({ "#n0": "status" });
    expect(result!.expressionAttributeValues).toEqual({ ":v0": "active" });
  });

  it("returns expression for in operator with array", () => {
    const result = resolveFilter(
      [{ field: "role", operator: "in", value: ["admin", "mod"] }],
      "user",
      makeConfig(),
    );
    expect(result!.expression).toBe("#n0 IN (:v0, :v1)");
    expect(result!.expressionAttributeValues).toEqual({
      ":v0": "admin",
      ":v1": "mod",
    });
  });

  it("returns expression with AND connectors", () => {
    const result = resolveFilter(
      [
        { field: "a", value: 1, connector: "AND" as const },
        { field: "b", value: 2, connector: "AND" as const },
      ],
      "user",
      makeConfig(),
    );
    expect(result!.expression).toContain("AND");
    expect(result!.expressionAttributeNames).toEqual({
      "#n0": "a",
      "#n1": "b",
    });
  });

  it("returns expression with OR connectors", () => {
    const result = resolveFilter(
      [
        { field: "role", value: "admin" },
        { field: "role", value: "mod", connector: "OR" as const },
      ],
      "user",
      makeConfig(),
    );
    // Two clauses on the same field "role" — both use #n0.
    // Without preceding AND group, OR connector on second clause
    // still forms two AND groups joined by OR: role=admin OR role=mod
    expect(result!.expression).toContain("OR");
  });

  it("returns undefined for empty where array", () => {
    expect(resolveFilter([], "user", makeConfig())).toBeUndefined();
  });

  it("returns undefined for null/undefined where", () => {
    expect(resolveFilter(null as any, "user", makeConfig())).toBeUndefined();
    expect(resolveFilter(undefined as any, "user", makeConfig())).toBeUndefined();
  });

  it("returns expression for not_in operator", () => {
    const result = resolveFilter(
      [{ field: "role", operator: "not_in", value: ["banned"] }],
      "user",
      makeConfig(),
    );
    expect(result!.expression).toContain("NOT");
    expect(result!.expression).toContain("IN");
    expect(result!.expressionAttributeValues[":v0"]).toBe("banned");
  });

  it("returns expression for between operator", () => {
    const result = resolveFilter(
      [{ field: "age", operator: "between", value: [18, 65] }],
      "user",
      makeConfig(),
    );
    expect(result!.expression).toContain("BETWEEN");
    expect(result!.expressionAttributeValues[":v0"]).toBe(18);
    expect(result!.expressionAttributeValues[":v1"]).toBe(65);
  });

  it("returns expression for contains operator", () => {
    const result = resolveFilter(
      [{ field: "name", operator: "contains", value: "john" }],
      "user",
      makeConfig(),
    );
    expect(result!.expression).toBe("contains(#n0, :v0)");
  });

  it("returns expression for starts_with operator", () => {
    const result = resolveFilter(
      [{ field: "email", operator: "starts_with", value: "admin@" }],
      "user",
      makeConfig(),
    );
    expect(result!.expression).toBe("begins_with(#n0, :v0)");
  });

  it("returns expression for gt operator", () => {
    const result = resolveFilter(
      [{ field: "age", operator: "gt", value: 18 }],
      "user",
      makeConfig(),
    );
    expect(result!.expression).toBe("#n0 > :v0");
  });

  it("returns expression for ne operator", () => {
    const result = resolveFilter(
      [{ field: "status", operator: "ne", value: "deleted" }],
      "user",
      makeConfig(),
    );
    expect(result!.expression).toBe("#n0 <> :v0");
  });
});
