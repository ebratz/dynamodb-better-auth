import { describe, it, expect } from "vitest";
import { shouldLog } from "../src/helpers/debug-log";

describe("shouldLog", () => {
  it("returns true when debugLogs is true", () => {
    expect(shouldLog({ debugLogs: true }, "update")).toBe(true);
  });

  it("returns false when debugLogs is false", () => {
    expect(shouldLog({ debugLogs: false }, "update")).toBe(false);
  });

  it("returns false when debugLogs is undefined", () => {
    expect(shouldLog({}, "update")).toBe(false);
  });

  it("returns false when debugLogs is missing from config", () => {
    expect(shouldLog({} as any, "findOne")).toBe(false);
  });

  it("returns true for matched operation in Record form", () => {
    expect(shouldLog({ debugLogs: { update: true } }, "update")).toBe(true);
  });

  it("returns false when operation explicitly disabled in Record form", () => {
    expect(shouldLog({ debugLogs: { update: false } }, "update")).toBe(false);
  });

  it("returns true when operation not in Record (defaults to true)", () => {
    expect(shouldLog({ debugLogs: { delete: true } }, "findMany")).toBe(true);
  });

  it("returns true for all operations when debugLogs is boolean true", () => {
    const cfg = { debugLogs: true };
    expect(shouldLog(cfg, "update")).toBe(true);
    expect(shouldLog(cfg, "delete")).toBe(true);
    expect(shouldLog(cfg, "findOne")).toBe(true);
  });

  it("returns false for all operations when debugLogs is boolean false", () => {
    const cfg = { debugLogs: false };
    expect(shouldLog(cfg, "update")).toBe(false);
    expect(shouldLog(cfg, "delete")).toBe(false);
    expect(shouldLog(cfg, "findOne")).toBe(false);
  });
});
