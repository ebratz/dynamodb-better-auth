import { describe, it, expect } from "vitest";
import { convertWhereClause } from "../src/helpers/where-converter";
import type { ConversionOptions } from "../src/types";

const baseOpts: ConversionOptions = {
  model: "user",
  getFieldName: ({ field }) => field,
  getFieldAttributes: () => ({}),
};

function conv(where: any[], opts?: Partial<ConversionOptions>) {
  return convertWhereClause(where, { ...baseOpts, ...opts });
}

describe("convertWhereClause", () => {
  // ── Empty / trivial ──────────────────────────────────────────
  it("returns empty expression for empty where", () => {
    const result = conv([]);
    expect(result.expression).toBe("");
    expect(result.expressionAttributeNames).toEqual({});
    expect(result.expressionAttributeValues).toEqual({});
    expect(result.needsClientSideFilter).toBe(false);
  });

  // ── eq ───────────────────────────────────────────────────────
  it("eq operator", () => {
    const result = conv([{ field: "id", operator: "eq", value: "u1" }]);
    expect(result.expression).toBe("#n0 = :v0");
    expect(result.expressionAttributeNames).toEqual({ "#n0": "id" });
    expect(result.expressionAttributeValues).toEqual({ ":v0": "u1" });
  });

  it("defaults operator to eq", () => {
    const result = conv([{ field: "email", value: "x@y.com" }]);
    expect(result.expression).toBe("#n0 = :v0");
    expect(result.expressionAttributeValues[":v0"]).toBe("x@y.com");
  });

  // ── ne ───────────────────────────────────────────────────────
  it("ne operator", () => {
    const result = conv([{ field: "status", operator: "ne", value: "deleted" }]);
    expect(result.expression).toBe("#n0 <> :v0");
  });

  // ── comparison operators ─────────────────────────────────────
  it("gt operator", () => {
    const result = conv([{ field: "age", operator: "gt", value: 18 }]);
    expect(result.expression).toBe("#n0 > :v0");
  });

  it("gte operator", () => {
    const result = conv([{ field: "age", operator: "gte", value: 18 }]);
    expect(result.expression).toBe("#n0 >= :v0");
  });

  it("lt operator", () => {
    const result = conv([{ field: "age", operator: "lt", value: 65 }]);
    expect(result.expression).toBe("#n0 < :v0");
  });

  it("lte operator", () => {
    const result = conv([{ field: "age", operator: "lte", value: 65 }]);
    expect(result.expression).toBe("#n0 <= :v0");
  });

  // ── in ───────────────────────────────────────────────────────
  it("in operator", () => {
    const result = conv([{ field: "role", operator: "in", value: ["admin", "mod"] }]);
    expect(result.expression).toBe("#n0 IN (:v0, :v1)");
    expect(result.expressionAttributeValues[":v0"]).toBe("admin");
    expect(result.expressionAttributeValues[":v1"]).toBe("mod");
  });

  it("in operator with empty array", () => {
    const result = conv([{ field: "role", operator: "in", value: [] }]);
    expect(result.expression).toBe("#n0 IN ()");
    expect(result.expressionAttributeValues).toEqual({});
  });

  it("in operator with exactly 100 values", () => {
    const vals = Array.from({ length: 100 }, (_, i) => `val_${i}`);
    const result = conv([{ field: "tag", operator: "in", value: vals }]);
    // Single IN, not chunked
    expect(result.expression).toMatch(/^#n\d+ IN \(/);
    expect(result.expression).not.toContain(" OR ");
    expect(result.chunked).toBeUndefined();
    expect(Object.keys(result.expressionAttributeValues)).toHaveLength(100);
  });

  it("in operator chunks >100 values with OR", () => {
    const vals = Array.from({ length: 250 }, (_, i) => `val_${i}`);
    const result = conv([{ field: "tag", operator: "in", value: vals }]);
    expect(result.expression).toContain(" OR ");
    expect(result.chunked).toBe(true);
    // 250 values → 3 chunks (100 + 100 + 50)
    expect(Object.keys(result.expressionAttributeValues)).toHaveLength(250);
  });

  // ── not_in ───────────────────────────────────────────────────
  it("not_in operator", () => {
    const result = conv([{ field: "status", operator: "not_in", value: ["deleted", "banned"] }]);
    expect(result.expression).toBe("NOT (#n0 IN (:v0, :v1))");
    expect(result.expressionAttributeValues[":v0"]).toBe("deleted");
    expect(result.expressionAttributeValues[":v1"]).toBe("banned");
  });

  it("not_in with >100 values AND-joins NOT-IN blocks", () => {
    const vals = Array.from({ length: 250 }, (_, i) => `val_${i}`);
    const result = conv([{ field: "tag", operator: "not_in", value: vals }]);
    expect(result.expression).toContain(" AND ");
    expect(result.expression).toContain("NOT (");
    expect(result.chunked).toBe(true);
  });

  // ── between ──────────────────────────────────────────────────
  it("between operator with two values", () => {
    const result = conv([{ field: "age", operator: "between", value: [18, 65] }]);
    expect(result.expression).toBe("#n0 BETWEEN :v0 AND :v1");
    expect(result.expressionAttributeValues[":v0"]).toBe(18);
    expect(result.expressionAttributeValues[":v1"]).toBe(65);
  });

  it("between throws when value is not a 2-element array", () => {
    expect(() =>
      conv([{ field: "age", operator: "between", value: [18] }]),
    ).toThrow(/requires exactly 2 values/);
  });

  it("between throws when value is a 3-element array", () => {
    expect(() =>
      conv([{ field: "age", operator: "between", value: [10, 20, 30] }]),
    ).toThrow(/requires exactly 2 values/);
  });

  it("between throws when value is a single non-array value", () => {
    expect(() =>
      conv([{ field: "age", operator: "between", value: 42 as any }]),
    ).toThrow(/requires exactly 2 values/);
  });

  // ── contains / starts_with ───────────────────────────────────
  it("contains operator", () => {
    const result = conv([{ field: "name", operator: "contains", value: "john" }]);
    expect(result.expression).toBe("contains(#n0, :v0)");
    expect(result.expressionAttributeValues[":v0"]).toBe("john");
  });

  it("starts_with operator", () => {
    const result = conv([{ field: "email", operator: "starts_with", value: "admin@" }]);
    expect(result.expression).toBe("begins_with(#n0, :v0)");
    expect(result.expressionAttributeValues[":v0"]).toBe("admin@");
  });

  // ── ends_with → throw ────────────────────────────────────────
  it("ends_with throws UnsupportedOperatorError", () => {
    expect(() =>
      conv([{ field: "email", operator: "ends_with", value: ".com" }]),
    ).toThrow(/ends_with/);
  });

  // ── insensitive mode → throw ─────────────────────────────────
  it("insensitive mode throws UnsupportedOperatorError", () => {
    expect(() =>
      conv([{ field: "email", operator: "eq", value: "X@Y.com", mode: "insensitive" }]),
    ).toThrow(/insensitive/);
  });

  // ── unknown operator → throw ─────────────────────────────────
  it("unknown operator throws UnsupportedOperatorError", () => {
    expect(() =>
      conv([{ field: "x", operator: "regex" as any, value: ".*" }]),
    ).toThrow(/not in the supported set/);
  });

  // ── AND / OR connector grouping ──────────────────────────────
  it("two AND clauses joined with AND", () => {
    const result = conv([
      { field: "status", operator: "eq", value: "active", connector: "AND" },
      { field: "role", operator: "eq", value: "admin" },
    ]);
    expect(result.expression).toBe("#n0 = :v0 AND #n1 = :v1");
  });

  it("two OR clauses joined with OR", () => {
    const result = conv([
      { field: "role", operator: "eq", value: "admin", connector: "OR" },
      { field: "role", operator: "eq", value: "mod" },
    ]);
    // connector on first clause has no preceding clause to OR-join with.
    // The two clauses form one AND group: (#n0 = :v0) AND (#n0 = :v1).
    // Both reference the same field "role" so they dedupe to #n0.
    expect(result.expression).toBe("#n0 = :v0 AND #n0 = :v1");
  });

  it("mixed AND+OR: OR splits consecutive AND groups", () => {
    const result = conv([
      { field: "status", operator: "eq", value: "active" },             // AND (implied)
      { field: "type", operator: "eq", value: "premium", connector: "OR" },
      { field: "role", operator: "eq", value: "admin" },
    ]);
    // status(AND) forms group 1, the OR on type splits, role(AND) forms group 2.
    // Result: status_group OR (type_group AND role_group)
    expect(result.expression).toBe("#n0 = :v0 OR (#n1 = :v1 AND #n2 = :v2)");
  });

  it("complex expression: A AND (B OR C) — connector on B creates OR group", () => {
    const result = conv([
      { field: "status", operator: "eq", value: "active", connector: "AND" },
      { field: "role", operator: "eq", value: "admin", connector: "OR" }, 
      { field: "email", operator: "contains", value: "@company.com", connector: "AND" },
    ]);
    // status(AND) → group 1, role(OR) splits, email(AND) → group 2.
    // Result: (status) OR (role AND email)
    expect(result.expression).toBe("#n0 = :v0 OR (#n1 = :v1 AND contains(#n2, :v2))");
  });

  // ── Deduplication ────────────────────────────────────────────
  it("deduplicates field references", () => {
    const result = conv([
      { field: "status", operator: "eq", value: "active" },
      { field: "status", operator: "ne", value: "deleted" },
    ]);
    // Both references to "status" use the same #n0
    expect(result.expression).toContain("#n0 = :v0");
    expect(result.expression).toContain("#n0 <> :v1");
    expect(Object.keys(result.expressionAttributeNames)).toHaveLength(1);
  });

  // ── Single clause, no parens ─────────────────────────────────
  it("single clause does not wrap in parens", () => {
    const result = conv([{ field: "id", operator: "eq", value: "u1" }]);
    expect(result.expression).toBe("#n0 = :v0");
    expect(result.expression).not.toContain("(");
  });

  // ── getFieldName transforms field names ──────────────────────
  it("uses getFieldName for field references", () => {
    const result = convertWhereClause(
      [{ field: "userId", operator: "eq", value: "u1" }],
      {
        ...baseOpts,
        getFieldName: ({ field }) => field === "userId" ? "user_id" : field,
      },
    );
    expect(result.expressionAttributeNames["#n0"]).toBe("user_id");
  });
});
