import { describe, it, expect, vi } from "vitest";
import {
  DynamoAdapterError,
  UnsupportedOperatorError,
  UnsupportedOptionError,
  InvalidWhereError,
} from "../src/errors";

describe("errors", () => {
  it("DynamoAdapterError stores code, message, cause", () => {
    const cause = new Error("underlying");
    const err = new DynamoAdapterError("TEST_CODE", "test message", cause);
    expect(err.code).toBe("TEST_CODE");
    expect(err.message).toBe("test message");
    expect(err.cause).toBe(cause);
    expect(err.name).toBe("DynamoAdapterError");
    expect(err).toBeInstanceOf(Error);
  });

  it("UnsupportedOperatorError extends DynamoAdapterError", () => {
    const err = new UnsupportedOperatorError("ends_with");
    expect(err.code).toBe("UNSUPPORTED_OPERATOR");
    expect(err.name).toBe("UnsupportedOperatorError");
    expect(err).toBeInstanceOf(DynamoAdapterError);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("ends_with");
  });

  it("UnsupportedOperatorError accepts optional detail", () => {
    const err = new UnsupportedOperatorError("contains", "case-insensitive not available");
    expect(err.message).toContain("case-insensitive");
    expect(err.message).toContain("contains");
  });

  it("UnsupportedOptionError extends DynamoAdapterError", () => {
    const err = new UnsupportedOptionError("offset");
    expect(err.code).toBe("UNSUPPORTED_OPTION");
    expect(err.name).toBe("UnsupportedOptionError");
    expect(err).toBeInstanceOf(DynamoAdapterError);
    expect(err.message).toContain("offset");
  });

  it("InvalidWhereError extends DynamoAdapterError", () => {
    const err = new InvalidWhereError("missing PK field");
    expect(err.code).toBe("INVALID_WHERE");
    expect(err.name).toBe("InvalidWhereError");
    expect(err).toBeInstanceOf(DynamoAdapterError);
    expect(err.message).toContain("missing PK field");
  });

  it("InvalidWhereError works without detail", () => {
    const err = new InvalidWhereError();
    expect(err.code).toBe("INVALID_WHERE");
    expect(err.message).toBe("Invalid where clause.");
  });

  it("errors can be caught via instanceof DynamoAdapterError", () => {
    const errors = [
      new UnsupportedOperatorError("ends_with"),
      new UnsupportedOptionError("offset"),
      new InvalidWhereError("bad"),
      new DynamoAdapterError("SOME_CODE", "some msg"),
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(DynamoAdapterError);
    }
  });
});
