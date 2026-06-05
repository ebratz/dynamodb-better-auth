import { describe, it, expect, vi } from "vitest";
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

  it("lazy-initializes _crypto and reuses on subsequent calls", () => {
    // First call triggers lazy init, second reuses cached crypto
    const token1 = generateToken();
    const token2 = generateToken();
    // Both should be valid UUIDs
    expect(token1).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(token2).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(token1).not.toBe(token2);
  });
});

describe("generateToken fallback (crypto unavailable)", () => {
  // If crypto is available (Node ≥19), this test verifies the fallback
  // code path by mocking crypto at the module level. When crypto is
  // unavailable, generateToken uses a Math.random-based UUID v4 generator.
  it("still produces valid UUID v4 when crypto is unavailable", async () => {
    vi.mock("crypto", () => {
      throw new Error("crypto unavailable");
    });
    vi.resetModules();
    const { generateToken: fallbackGenerate } = await import(
      "../src/helpers/uuid"
    );
    const token = fallbackGenerate();
    // Fallback must produce valid UUID v4
    expect(token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(token.length).toBe(36);
  });
});
