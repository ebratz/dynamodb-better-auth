import { describe, it, expect } from "vitest";
import { generateToken } from "../src/helpers/uuid";

describe("generateToken", () => {
  it("returns a UUID v4 string", () => {
    const token = generateToken();
    // UUID v4: 8-4-4-4-12 hex digits, with version 4 and variant bits set
    expect(token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("returns unique tokens on successive calls", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      tokens.add(generateToken());
    }
    expect(tokens.size).toBe(100);
  });

  it("returns a string of exactly 36 characters", () => {
    const token = generateToken();
    expect(token.length).toBe(36);
  });
});
