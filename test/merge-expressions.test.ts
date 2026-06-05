import { describe, it, expect } from "vitest";
import { mergeKeyAndFilterExpressions } from "../src/helpers/merge-expressions";

describe("mergeKeyAndFilterExpressions", () => {
  it("returns key condition unchanged when no filter is provided", () => {
    const kc = {
      expression: "#n0 = :v0",
      expressionAttributeNames: { "#n0": "email" },
      expressionAttributeValues: { ":v0": "a@b.com" },
    };

    const result = mergeKeyAndFilterExpressions(kc);

    expect(result.keyCondition).toBe("#n0 = :v0");
    expect(result.filterExpression).toBe("");
    expect(result.names).toEqual({ "#n0": "email" });
    expect(result.values).toEqual({ ":v0": "a@b.com" });
  });

  it("returns key condition unchanged when filter has empty expression", () => {
    const kc = {
      expression: "#n0 = :v0",
      expressionAttributeNames: { "#n0": "email" },
      expressionAttributeValues: { ":v0": "a@b.com" },
    };
    const filter = {
      expression: "",
      expressionAttributeNames: {},
      expressionAttributeValues: {},
    };

    const result = mergeKeyAndFilterExpressions(kc, filter);

    expect(result.keyCondition).toBe("#n0 = :v0");
    expect(result.filterExpression).toBe("");
    expect(result.names).toEqual({ "#n0": "email" });
  });

  it("merges non-colliding filter names and values into the combined map", () => {
    const kc = {
      expression: "#n0 = :v0",
      expressionAttributeNames: { "#n0": "email" },
      expressionAttributeValues: { ":v0": "a@b.com" },
    };
    const filter = {
      expression: "#n1 = :v1",
      expressionAttributeNames: { "#n1": "status" },
      expressionAttributeValues: { ":v1": "active" },
    };

    const result = mergeKeyAndFilterExpressions(kc, filter);

    expect(result.keyCondition).toBe("#n0 = :v0");
    expect(result.filterExpression).toBe("#n1 = :v1");
    expect(result.names).toEqual({ "#n0": "email", "#n1": "status" });
    expect(result.values).toEqual({ ":v0": "a@b.com", ":v1": "active" });
  });

  it("remaps colliding #nX placeholder to a fresh slot in the filter expression", () => {
    // Both key condition and filter produce #n0, but for different fields.
    const kc = {
      expression: "#n0 = :v0",
      expressionAttributeNames: { "#n0": "email" },
      expressionAttributeValues: { ":v0": "a@b.com" },
    };
    const filter = {
      expression: "#n0 = :v1",
      expressionAttributeNames: { "#n0": "status" },
      expressionAttributeValues: { ":v1": "active" },
    };

    const result = mergeKeyAndFilterExpressions(kc, filter);

    // Key condition stays the same
    expect(result.keyCondition).toBe("#n0 = :v0");

    // Filter expression should have #n0 → #n1 remapped
    expect(result.filterExpression).toBe("#n1 = :v1");

    // Merged names: #n0 = email, #n1 = status
    expect(result.names).toEqual({ "#n0": "email", "#n1": "status" });

    // Merged values: :v0 and :v1 both preserved
    expect(result.values).toEqual({ ":v0": "a@b.com", ":v1": "active" });
  });

  it("preserves same-field same-placeholder (identity collision — no remap needed)", () => {
    const kc = {
      expression: "#n0 = :v0",
      expressionAttributeNames: { "#n0": "email" },
      expressionAttributeValues: { ":v0": "a@b.com" },
    };
    // Same field "email" also appears in filter — same placeholder, no collision.
    const filter = {
      expression: "#n0 AND #n1 = :v1",
      expressionAttributeNames: { "#n0": "email", "#n1": "status" },
      expressionAttributeValues: { ":v1": "active" },
    };

    const result = mergeKeyAndFilterExpressions(kc, filter);

    // #n0 = email is in both; no remap needed. #n1 = status is new.
    expect(result.names).toEqual({ "#n0": "email", "#n1": "status" });
    expect(result.values).toEqual({ ":v0": "a@b.com", ":v1": "active" });
  });
});
