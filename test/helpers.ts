/**
 * Shared test utilities for DynamoDB adapter tests.
 *
 * Import in test files to eliminate the copy-pasted boilerplate:
 *   - makeMockedSdkCommands() — one-shot setup of all 9 SDK command mocks
 *   - makeDocClient(sendImpl) — full-control mock with command inspection
 *   - makeConfig(overrides) — default DynamoDBAdapterConfig for tests
 */

import { vi } from "vitest";
import type { DynamoDBAdapterConfig } from "../src/types";

// ── Default test tables ─────────────────────────────────────────

export const DEFAULT_TABLES: DynamoDBAdapterConfig["tables"] = {
  user: "test-users",
  session: "test-sessions",
  account: "test-accounts",
  verification: "test-verifications",
};

// ── SDK command mocks ───────────────────────────────────────────

/**
 * Register mock implementations for all 9 DynamoDB SDK command classes.
 * Each mock is a pass-through stub: `{ ...input, _type: "CommandName" }`.
 *
 * Call once per test file, near the top. Must be at module scope because
 * `vi.mock` is hoisted. If your file only needs a subset, import only the
 * commands you need from `@aws-sdk/lib-dynamodb` and vi.mock them manually.
 */
export function makeMockedSdkCommands() {
  vi.mock("@aws-sdk/lib-dynamodb", () => ({
    GetCommand: vi.fn().mockImplementation((input: any) => ({
      ...input,
      _type: "GetCommand",
    })),
    PutCommand: vi.fn().mockImplementation((input: any) => ({
      ...input,
      _type: "PutCommand",
    })),
    UpdateCommand: vi.fn().mockImplementation((input: any) => ({
      ...input,
      _type: "UpdateCommand",
    })),
    DeleteCommand: vi.fn().mockImplementation((input: any) => ({
      ...input,
      _type: "DeleteCommand",
    })),
    QueryCommand: vi.fn().mockImplementation((input: any) => ({
      ...input,
      _type: "QueryCommand",
    })),
    ScanCommand: vi.fn().mockImplementation((input: any) => ({
      ...input,
      _type: "ScanCommand",
    })),
    BatchWriteCommand: vi.fn().mockImplementation((input: any) => ({
      ...input,
      _type: "BatchWriteCommand",
    })),
    BatchGetCommand: vi.fn().mockImplementation((input: any) => ({
      ...input,
      _type: "BatchGetCommand",
    })),
    TransactWriteCommand: vi.fn().mockImplementation((input: any) => ({
      ...input,
      _type: "TransactWriteCommand",
    })),
  }));
}

// ── DocClient mocks ─────────────────────────────────────────────

/**
 * Full-control docClient mock. Pass a handler that receives every
 * command and returns a response. The returned object has `send`,
 * `_calls`, and `_callCount` for inspection.
 *
 * Usage:
 *   const docClient = makeDocClient(async (cmd: any) => {
 *     if (cmd._type === "QueryCommand") return { Items: [...] };
 *     if (cmd._type === "UpdateCommand") return { Attributes: {...} };
 *     return {};
 *   });
 */
export function makeDocClient(
  sendImpl: (cmd: any) => Promise<any>,
): { send: ReturnType<typeof vi.fn>; _calls: () => any[]; _callCount: () => number } {
  const calls: any[] = [];
  const send = vi.fn().mockImplementation(async (cmd: any) => {
    calls.push(cmd);
    return sendImpl(cmd);
  });
  return {
    send,
    _calls: () => calls,
    _callCount: () => calls.length,
  };
}

/**
 * Sequential-playback docClient mock. Pass an array of response
 * objects (or functions). Each call to `send` consumes the next
 * entry. Useful when the exact sequence of DDB operations is known.
 *
 * If a function is provided, it receives the command and returns
 * a response — this lets you return `{ Items: [...], LastEvaluatedKey: ... }`
 * based on the command type.
 *
 * Usage:
 *   const docClient = makeDocClientWithResponses([
 *     { Items: [{ id: "u1" }], LastEvaluatedKey: { id: "u1" } },
 *     { Items: [{ id: "u2" }] },
 *   ]);
 */
export function makeDocClientWithResponses(
  responses: (any | ((cmd: any) => any))[],
): {
  send: ReturnType<typeof vi.fn>;
  _calls: () => any[];
  _callCount: () => number;
} {
  let callIdx = 0;
  const calls: any[] = [];
  const send = vi.fn().mockImplementation(async (cmd: any) => {
    calls.push(cmd);
    const respOrFn = responses[callIdx] ?? { Items: [] };
    callIdx++;
    return typeof respOrFn === "function" ? respOrFn(cmd) : respOrFn;
  });
  return {
    send,
    _calls: () => calls,
    _callCount: () => callIdx,
  };
}

// ── Config factory ──────────────────────────────────────────────

/**
 * Default adapter config for unit tests. Tables are pre-populated
 * with standard names. Override any field as needed.
 */
export function makeConfig(
  overrides: Partial<DynamoDBAdapterConfig> = {},
): DynamoDBAdapterConfig {
  return {
    client: {} as any,
    tables: { ...DEFAULT_TABLES },
    ...overrides,
  } as DynamoDBAdapterConfig;
}

// ── Native adapter stub for transaction tests ───────────────────

/**
 * Minimal native-methods bag used by transaction tests.
 * Only the methods exercised by transaction.ts need to be defined;
 * stub the rest with `vi.fn()`.
 */
export function makeNativeAdapter(overrides: Record<string, any> = {}) {
  return {
    create: vi.fn().mockResolvedValue({}),
    findOne: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
    count: vi.fn().mockResolvedValue(0),
    update: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue(0),
    delete: vi.fn().mockResolvedValue(undefined),
    deleteMany: vi.fn().mockResolvedValue(0),
    consumeOne: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

/**
 * Helper to get the table name for a model (used by transaction tests).
 * Defaults to `${model}-test` if not found.
 */
export function makeGetTable(
  mapping: Record<string, string> = {},
): (model: string) => string {
  return (model: string) => mapping[model] ?? `${model}-test`;
}
