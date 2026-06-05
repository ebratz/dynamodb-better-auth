import { describe, it, expect } from "vitest";
import { assertTransactionCapacity } from "../src/helpers/assert-capacity";

describe("assertTransactionCapacity", () => {
  it("passes when within limit (buffer 50 + extra 49 = 99)", () => {
    const buffer = Array(50).fill({});
    expect(() => assertTransactionCapacity(buffer, 49)).not.toThrow();
  });

  it("passes at exact limit (buffer 50 + extra 50 = 100)", () => {
    const buffer = Array(50).fill({});
    expect(() => assertTransactionCapacity(buffer, 50)).not.toThrow();
  });

  it("throws when over limit (buffer 50 + extra 51 = 101)", () => {
    const buffer = Array(50).fill({});
    expect(() => assertTransactionCapacity(buffer, 51)).toThrow(
      "Cannot buffer more than 100 actions",
    );
  });

  it("uses custom max parameter", () => {
    const buffer = Array(5).fill({});
    expect(() => assertTransactionCapacity(buffer, 5, 10)).not.toThrow();
    expect(() => assertTransactionCapacity(buffer, 6, 10)).toThrow(
      "Cannot buffer more than 100 actions",
    );
  });

  it("allows extra = 0 regardless of buffer size at limit", () => {
    const buffer = Array(100).fill({});
    expect(() => assertTransactionCapacity(buffer, 0)).not.toThrow();
  });

  it("throws when buffer is exactly max and extra > 0", () => {
    const buffer = Array(100).fill({});
    expect(() => assertTransactionCapacity(buffer, 1)).toThrow();
  });

  it("passes for empty buffer with extra within limit", () => {
    expect(() => assertTransactionCapacity([], 50)).not.toThrow();
  });

  it("passes for empty buffer with extra at limit", () => {
    expect(() => assertTransactionCapacity([], 100)).not.toThrow();
  });

  it("throws with DynamoAdapterError code TRANSACTION_FAILED", () => {
    const buffer = Array(50).fill({});
    try {
      assertTransactionCapacity(buffer, 51);
    } catch (err: any) {
      expect(err.code).toBe("TRANSACTION_FAILED");
      expect(err.name).toBe("DynamoAdapterError");
    }
  });
});
