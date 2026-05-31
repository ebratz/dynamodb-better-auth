import { describe, it, expect } from "vitest";
import { buildExpressionNames } from "../src/helpers/expression-names";

describe("buildExpressionNames", () => {
  it("builds names map for given fields", () => {
    const result = buildExpressionNames(["id", "email", "name"]);
    expect(result.names).toEqual({
      "#n0": "id",
      "#n1": "email",
      "#n2": "name",
    });
  });

  it("deduplicates repeated fields", () => {
    const result = buildExpressionNames(["id", "email", "id", "email", "name"]);
    // Still only 3 unique entries
    expect(Object.keys(result.names)).toHaveLength(3);
    expect(result.toRef("id")).toBe("#n0");
    expect(result.toRef("email")).toBe("#n1");
    expect(result.toRef("name")).toBe("#n2");
  });

  it("handles empty array", () => {
    const result = buildExpressionNames([]);
    expect(result.names).toEqual({});
    expect(Object.keys(result.names)).toHaveLength(0);
  });

  it("handles 500+ fields without collision", () => {
    const fields = Array.from({ length: 600 }, (_, i) => `field_${i}`);
    const result = buildExpressionNames(fields);
    const keys = Object.keys(result.names);
    expect(keys).toHaveLength(600);
    // Verify all are #n0 through #n599 (no gaps, no collisions)
    for (let i = 0; i < 600; i++) {
      expect(result.names[`#n${i}`]).toBe(`field_${i}`);
    }
  });

  it("toRef returns the correct placeholder for a known field", () => {
    const result = buildExpressionNames(["email", "createdAt"]);
    expect(result.toRef("email")).toBe("#n0");
    expect(result.toRef("createdAt")).toBe("#n1");
  });

  it("toRef for unknown field creates a new entry on the fly", () => {
    const result = buildExpressionNames(["id"]);
    const ref = result.toRef("newField");
    // Should create #n1 for the unknown field
    expect(ref).toBe("#n1");
    expect(result.names["#n1"]).toBe("newField");
    // #n0 still maps to "id"
    expect(result.names["#n0"]).toBe("id");
  });

  it("toRef never collides with reserved DynamoDB words", () => {
    // All standard DDB reserved words that overlap with Better Auth fields
    const reserved = [
      "name", "token", "value", "data", "user", "users",
      "type", "role", "roles", "key", "keys", "default",
      "condition", "update", "delete", "time", "date",
      "timestamp", "status", "true", "false", "null",
      "order", "group", "path", "comment", "attributes",
      "body", "action", "password", "binary", "begin", "end", "return",
    ];
    const result = buildExpressionNames(reserved);
    // Every result key starts with "#n" — never matches a reserved word
    for (const key of Object.keys(result.names)) {
      expect(key).toMatch(/^#n\d+$/);
    }
    // Every placeholder should map back correctly
    for (const word of reserved) {
      const ref = result.toRef(word);
      expect(ref).toMatch(/^#n\d+$/);
    }
  });

  it("toValueRef generates correct value placeholders", () => {
    const result = buildExpressionNames(["id", "email"]);
    expect(result.toValueRef(0)).toBe(":v0");
    expect(result.toValueRef(1)).toBe(":v1");
    expect(result.toValueRef(5)).toBe(":v5");
    expect(result.toValueRef(99)).toBe(":v99");
  });

  it("toRef for duplicate calls returns same placeholder", () => {
    const result = buildExpressionNames(["id"]);
    const first = result.toRef("id");
    const second = result.toRef("id");
    expect(first).toBe(second);
    expect(first).toBe("#n0");
  });

  it("names are immutable-stable after repeated toRef calls", () => {
    const result = buildExpressionNames(["a", "b"]);
    result.toRef("c");
    result.toRef("d");
    // Original entries preserved
    expect(result.names["#n0"]).toBe("a");
    expect(result.names["#n1"]).toBe("b");
    expect(result.names["#n2"]).toBe("c");
    expect(result.names["#n3"]).toBe("d");
  });
});
