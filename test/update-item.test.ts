/**
 * Unit tests for src/helpers/update-item.ts
 *
 * Tests buildUpdateExpression (SET clause + attrNames/attrValues builder)
 * and sanitizeForWrite (Date → ISO string, non-mutating copy).
 *
 * Both are pure functions — no AWS SDK mocks needed.
 */

import { describe, it, expect } from "vitest";
import { buildUpdateExpression, sanitizeForWrite } from "../src/helpers/update-item";

// ── buildUpdateExpression ───────────────────────────────────────

describe("buildUpdateExpression", () => {
  it("strips PK field from update — not in setClauses", () => {
    const result = buildUpdateExpression(
      { id: "u1", name: "Alice" },
      "id",
    );

    expect(result.setClauses).toHaveLength(1);
    expect(result.setClauses[0]).toMatch(/#n0 = :v0/);
    expect(result.attrNames["#n0"]).toBe("name");
    expect(result.attrValues[":v0"]).toBe("Alice");
    // attrNames should not reference the PK field
    const nameValues = Object.values(result.attrNames);
    expect(nameValues).not.toContain("id");
  });

  it("strips SK field when provided — not in setClauses", () => {
    const result = buildUpdateExpression(
      { providerId: "google", accountId: "12345", accessToken: "tok" },
      "providerId",
      "accountId",
    );

    expect(result.setClauses).toHaveLength(1);
    expect(result.attrNames["#n0"]).toBe("accessToken");
    expect(result.attrValues[":v0"]).toBe("tok");
    // Neither PK nor SK should appear in attrNames values
    const nameValues = Object.values(result.attrNames);
    expect(nameValues).not.toContain("providerId");
    expect(nameValues).not.toContain("accountId");
  });

  it("converts Date to ISO string in attrValues", () => {
    const date = new Date("2025-06-01T12:00:00.000Z");
    const result = buildUpdateExpression(
      { id: "u1", updatedAt: date, name: "Bob" },
      "id",
    );

    expect(result.setClauses).toHaveLength(2);
    // One of the values should be the ISO string
    const allValues = Object.values(result.attrValues);
    expect(allValues).toContain("2025-06-01T12:00:00.000Z");
    expect(allValues).toContain("Bob");
    // No Date instance should leak through
    const hasDate = allValues.some((v) => v instanceof Date);
    expect(hasDate).toBe(false);
  });

  it("leaves non-Date values unchanged", () => {
    const result = buildUpdateExpression(
      { id: "u1", name: "Alice", age: 30, active: true, tags: ["admin"] },
      "id",
    );

    expect(result.setClauses).toHaveLength(4);
    // All original non-PK values should be present
    expect(result.attrValues).toMatchObject({
      ":v0": "Alice",
      ":v1": 30,
      ":v2": true,
      ":v3": ["admin"],
    });
  });

  it("returns correct attrNames shape (#n0, #n1, ...)", () => {
    const result = buildUpdateExpression(
      { id: "u1", name: "Alice", email: "a@b.com", role: "admin" },
      "id",
    );

    // 3 non-PK fields → #n0, #n1, #n2
    expect(Object.keys(result.attrNames)).toEqual(["#n0", "#n1", "#n2"]);
    expect(result.attrNames["#n0"]).toBe("name");
    expect(result.attrNames["#n1"]).toBe("email");
    expect(result.attrNames["#n2"]).toBe("role");
  });

  it("returns correct setClauses (#nX = :vX pattern)", () => {
    const result = buildUpdateExpression(
      { id: "u1", name: "Alice", email: "a@b.com" },
      "id",
    );

    expect(result.setClauses).toEqual([
      "#n0 = :v0",
      "#n1 = :v1",
    ]);
  });

  it("empty update after stripping → empty setClauses", () => {
    const result = buildUpdateExpression({}, "id");

    expect(result.setClauses).toEqual([]);
    expect(result.attrNames).toEqual({});
    expect(result.attrValues).toEqual({});
  });

  it("update with only PK/SK fields → empty setClauses, empty attrValues", () => {
    const result = buildUpdateExpression(
      { id: "u1", providerId: "google" },
      "id",
      "providerId",
    );

    expect(result.setClauses).toEqual([]);
    expect(result.attrNames).toEqual({});
    expect(result.attrValues).toEqual({});
  });

  it("update with only PK field (no SK) → empty setClauses", () => {
    const result = buildUpdateExpression({ id: "u1" }, "id");

    expect(result.setClauses).toEqual([]);
    expect(result.attrNames).toEqual({});
    expect(result.attrValues).toEqual({});
  });

  it("null values preserved in attrValues", () => {
    const result = buildUpdateExpression(
      { id: "u1", deletedAt: null, name: "Alice" },
      "id",
    );

    expect(result.setClauses).toHaveLength(2);
    expect(result.attrValues[":v0"]).toBeNull();
    expect(result.attrValues[":v1"]).toBe("Alice");
  });

  it("undefined values preserved in attrValues", () => {
    const result = buildUpdateExpression(
      { id: "u1", deletedAt: undefined, name: "Alice" },
      "id",
    );

    expect(result.setClauses).toHaveLength(2);
    expect(result.attrValues[":v0"]).toBeUndefined();
    expect(result.attrValues[":v1"]).toBe("Alice");
  });

  it("handles zero values (0, false, empty string)", () => {
    const result = buildUpdateExpression(
      { id: "u1", count: 0, active: false, tag: "" },
      "id",
    );

    expect(result.setClauses).toHaveLength(3);
    expect(result.attrValues[":v0"]).toBe(0);
    expect(result.attrValues[":v1"]).toBe(false);
    expect(result.attrValues[":v2"]).toBe("");
  });

  it("skField not provided → only PK is stripped", () => {
    const result = buildUpdateExpression(
      { id: "u1", accountId: "12345", accessToken: "tok" },
      "id",
    );

    // accountId is NOT stripped because skField was not passed
    expect(result.setClauses).toHaveLength(2);
    const nameValues = Object.values(result.attrNames);
    expect(nameValues).toContain("accountId");
  });
});

// ── sanitizeForWrite ────────────────────────────────────────────

describe("sanitizeForWrite", () => {
  it("converts Date to ISO string", () => {
    const date = new Date("2025-06-01T12:00:00.000Z");
    const result = sanitizeForWrite({ createdAt: date });

    expect(result.createdAt).toBe("2025-06-01T12:00:00.000Z");
    expect(result.createdAt).not.toBeInstanceOf(Date);
  });

  it("leaves non-Date values untouched", () => {
    const result = sanitizeForWrite({
      name: "Alice",
      age: 30,
      active: true,
      tags: ["admin"],
      meta: { key: "val" },
    });

    expect(result.name).toBe("Alice");
    expect(result.age).toBe(30);
    expect(result.active).toBe(true);
    expect(result.tags).toEqual(["admin"]);
    expect(result.meta).toEqual({ key: "val" });
  });

  it("does not mutate the original object (deep-clone)", () => {
    const date = new Date("2025-06-01T12:00:00.000Z");
    const original = { name: "Alice", createdAt: date };
    const result = sanitizeForWrite(original);

    // Original untouched
    expect(original.createdAt).toBeInstanceOf(Date);
    expect(original.createdAt).toBe(date);
    expect(original.name).toBe("Alice");

    // Result is a distinct object
    expect(result).not.toBe(original);
  });

  it("handles null values", () => {
    const result = sanitizeForWrite({ name: "Alice", deletedAt: null });

    expect(result.deletedAt).toBeNull();
    expect(result.name).toBe("Alice");
  });

  it("handles undefined values", () => {
    const result = sanitizeForWrite({ name: "Alice", deletedAt: undefined });

    expect(result.deletedAt).toBeUndefined();
    expect(result.name).toBe("Alice");
  });

  it("handles multiple Date fields", () => {
    const d1 = new Date("2025-01-01T00:00:00.000Z");
    const d2 = new Date("2025-12-31T23:59:59.000Z");
    const result = sanitizeForWrite({
      name: "Bob",
      createdAt: d1,
      updatedAt: d2,
    });

    expect(result.createdAt).toBe("2025-01-01T00:00:00.000Z");
    expect(result.updatedAt).toBe("2025-12-31T23:59:59.000Z");
    expect(result.name).toBe("Bob");
  });

  it("handles empty object", () => {
    const result = sanitizeForWrite({});
    expect(result).toEqual({});
  });

  // Note: sanitizeForWrite performs a shallow copy (Object.entries).
  // Nested Date objects inside sub-objects are NOT converted.
  // This is intentional — the adapter marshals top-level values.
  it("nested objects are passed through (shallow copy)", () => {
    const nested = { inner: "val", date: new Date("2025-06-01T00:00:00.000Z") };
    const result = sanitizeForWrite({ meta: nested });

    // The nested object is the same reference (shallow copy)
    expect(result.meta).toBe(nested);
    // Inner Date is NOT converted
    expect(result.meta.date).toBeInstanceOf(Date);
  });

  it("Date in nested object is NOT converted (shallow only)", () => {
    const nestedDate = new Date("2025-06-01T00:00:00.000Z");
    const result = sanitizeForWrite({ meta: { date: nestedDate } });

    // The nested object is passed through as-is
    expect(result.meta).toEqual({ date: nestedDate });
    expect((result.meta as any).date).toBeInstanceOf(Date);
  });
});
