/**
 * Unit tests for src/adapter/tx-key-builder.ts
 *
 * Tests buildTxKey — resolves a DynamoDB Key from Better Auth where
 * constraints for use inside transaction operations.
 *
 * Pure function — no AWS SDK mocks needed.
 */

import { describe, it, expect } from "vitest";
import { buildTxKey } from "../src/adapter/tx-key-builder";
import { DynamoAdapterError } from "../src/errors";
import type { KeySchema } from "../src/types";

// ── Builders ────────────────────────────────────────────────────

function simpleSchema(pkField = "id"): KeySchema {
  return { pkField };
}

function compositeSchema(pkField = "providerId", skField = "accountId"): KeySchema {
  return { pkField, skField };
}

// ── Tests ───────────────────────────────────────────────────────

describe("buildTxKey", () => {
  // ── Simple PK models ──────────────────────────────────────────

  it("simple PK where → returns { [pkField]: value }", () => {
    const key = buildTxKey(
      [{ field: "id", operator: "eq", value: "u1" }],
      simpleSchema(),
      "user",
    );

    expect(key).toEqual({ id: "u1" });
  });

  it("simple PK with implicit eq (no operator) → returns key", () => {
    const key = buildTxKey(
      [{ field: "id", value: "u1" }],
      simpleSchema(),
      "user",
    );

    expect(key).toEqual({ id: "u1" });
  });

  it("simple PK with custom pkField name", () => {
    const key = buildTxKey(
      [{ field: "token", operator: "eq", value: "tok-abc" }],
      simpleSchema("token"),
      "session",
    );

    expect(key).toEqual({ token: "tok-abc" });
  });

  // ── Composite PK+SK models ────────────────────────────────────

  it("composite PK+SK → returns { [pkField]: value, [skField]: value }", () => {
    const key = buildTxKey(
      [
        { field: "providerId", operator: "eq", value: "google" },
        { field: "accountId", operator: "eq", value: "12345" },
      ],
      compositeSchema(),
      "account",
    );

    expect(key).toEqual({
      providerId: "google",
      accountId: "12345",
    });
  });

  it("composite PK+SK with implicit eq (no operator)", () => {
    const key = buildTxKey(
      [
        { field: "providerId", value: "google" },
        { field: "accountId", value: "12345" },
      ],
      compositeSchema(),
      "account",
    );

    expect(key).toEqual({
      providerId: "google",
      accountId: "12345",
    });
  });

  it("composite PK+SK where fields are in reversed order", () => {
    // buildTxKey uses Array.find, so order of where entries doesn't matter
    const key = buildTxKey(
      [
        { field: "accountId", operator: "eq", value: "12345" },
        { field: "providerId", operator: "eq", value: "google" },
      ],
      compositeSchema(),
      "account",
    );

    expect(key).toEqual({
      providerId: "google",
      accountId: "12345",
    });
  });

  // ── Multiple where clauses (picks the eq one) ─────────────────

  it("multiple where clauses → picks the eq PK one", () => {
    // Both have PK field; one is "ne", one is "eq". The eq one wins.
    const key = buildTxKey(
      [
        { field: "id", operator: "ne", value: "wrong" },
        { field: "id", operator: "eq", value: "u1" },
      ],
      simpleSchema(),
      "user",
    );

    expect(key).toEqual({ id: "u1" });
  });

  it("extra non-PK where clauses are ignored", () => {
    const key = buildTxKey(
      [
        { field: "id", operator: "eq", value: "u1" },
        { field: "email", operator: "eq", value: "a@b.com" },
        { field: "name", operator: "contains", value: "Alice" },
      ],
      simpleSchema(),
      "user",
    );

    // Only PK matters; extras ignored
    expect(key).toEqual({ id: "u1" });
  });

  // ── Error: missing PK ─────────────────────────────────────────

  it("missing PK → throws DynamoAdapterError INVALID_WHERE", () => {
    expect(() =>
      buildTxKey(
        [{ field: "email", operator: "eq", value: "a@b.com" }],
        simpleSchema(),
        "user",
      ),
    ).toThrow(DynamoAdapterError);

    expect(() =>
      buildTxKey(
        [{ field: "email", operator: "eq", value: "a@b.com" }],
        simpleSchema(),
        "user",
      ),
    ).toThrow('requires PK field "id"');
  });

  it("empty where array → throws INVALID_WHERE", () => {
    expect(() =>
      buildTxKey([], simpleSchema(), "user"),
    ).toThrow(DynamoAdapterError);
    expect(() =>
      buildTxKey([], simpleSchema(), "user"),
    ).toThrow(/requires PK field/);
  });

  // ── Error: composite model missing SK ─────────────────────────

  it("composite model missing SK → throws DynamoAdapterError INVALID_WHERE", () => {
    expect(() =>
      buildTxKey(
        [{ field: "providerId", operator: "eq", value: "google" }],
        compositeSchema(),
        "account",
      ),
    ).toThrow(DynamoAdapterError);

    expect(() =>
      buildTxKey(
        [{ field: "providerId", operator: "eq", value: "google" }],
        compositeSchema(),
        "account",
      ),
    ).toThrow('requires SK field "accountId"');
  });

  // ── Error: non-eq PK operator ─────────────────────────────────

  it("non-eq PK operator → throws (pkEq find returns undefined)", () => {
    // PK field present but operator is "ne" — find() skips it
    expect(() =>
      buildTxKey(
        [{ field: "id", operator: "ne", value: "u1" }],
        simpleSchema(),
        "user",
      ),
    ).toThrow(DynamoAdapterError);
    expect(() =>
      buildTxKey(
        [{ field: "id", operator: "ne", value: "u1" }],
        simpleSchema(),
        "user",
      ),
    ).toThrow(/requires PK field/);
  });

  it("PK with 'contains' operator → throws", () => {
    expect(() =>
      buildTxKey(
        [{ field: "id", operator: "contains", value: "u1" }],
        simpleSchema(),
        "user",
      ),
    ).toThrow(DynamoAdapterError);
    expect(() =>
      buildTxKey(
        [{ field: "id", operator: "contains", value: "u1" }],
        simpleSchema(),
        "user",
      ),
    ).toThrow(/requires PK field/);
  });

  it("PK with 'gt' operator → throws", () => {
    expect(() =>
      buildTxKey(
        [{ field: "id", operator: "gt", value: 5 }],
        simpleSchema(),
        "user",
      ),
    ).toThrow(DynamoAdapterError);
    expect(() =>
      buildTxKey(
        [{ field: "id", operator: "gt", value: 5 }],
        simpleSchema(),
        "user",
      ),
    ).toThrow(/requires PK field/);
  });

  // ── Edge cases ────────────────────────────────────────────────

  it("composite model: non-eq SK operator → throws INVALID_WHERE", () => {
    expect(() =>
      buildTxKey(
        [
          { field: "providerId", operator: "eq", value: "google" },
          { field: "accountId", operator: "ne", value: "12345" },
        ],
        compositeSchema(),
        "account",
      ),
    ).toThrow(DynamoAdapterError);
    expect(() =>
      buildTxKey(
        [
          { field: "providerId", operator: "eq", value: "google" },
          { field: "accountId", operator: "ne", value: "12345" },
        ],
        compositeSchema(),
        "account",
      ),
    ).toThrow(/requires SK field/);
  });

  it("handles numeric PK values", () => {
    const key = buildTxKey(
      [{ field: "id", operator: "eq", value: 42 }],
      simpleSchema(),
      "user",
    );

    expect(key).toEqual({ id: 42 });
  });

  it("handles boolean PK values", () => {
    const key = buildTxKey(
      [{ field: "active", operator: "eq", value: true }],
      simpleSchema("active"),
      "flag",
    );

    expect(key).toEqual({ active: true });
  });
});
