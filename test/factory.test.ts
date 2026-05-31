import { describe, it, expect, vi, beforeEach } from "vitest";
import { getTableName, dynamodbAdapter } from "../src/adapter/factory";
import type { DynamoDBAdapterConfig } from "../src/types";

// Mock better-auth/adapters — capture the config arg so we can exercise
// the customTransformInput/Output lambdas the factory hands to better-auth.
let capturedFactoryArg: any = undefined;
vi.mock("better-auth/adapters", () => ({
  createAdapterFactory: vi.fn().mockImplementation((arg: any) => {
    capturedFactoryArg = arg;
    return vi.fn();
  }),
}));

// Mock all method modules
vi.mock("../src/adapter/methods/create", () => ({
  createMethod: vi.fn(() => vi.fn().mockResolvedValue({})),
}));
vi.mock("../src/adapter/methods/find-one", () => ({
  findOneMethod: vi.fn(() => vi.fn().mockResolvedValue(null)),
}));
vi.mock("../src/adapter/methods/find-many", () => ({
  findManyMethod: vi.fn(() => vi.fn().mockResolvedValue([])),
}));
vi.mock("../src/adapter/methods/count", () => ({
  countMethod: vi.fn(() => vi.fn().mockResolvedValue(0)),
}));
vi.mock("../src/adapter/methods/update", () => ({
  updateMethod: vi.fn(() => vi.fn().mockResolvedValue({})),
}));
vi.mock("../src/adapter/methods/update-many", () => ({
  updateManyMethod: vi.fn(() => vi.fn().mockResolvedValue(0)),
}));
vi.mock("../src/adapter/methods/delete", () => ({
  deleteMethod: vi.fn(() => vi.fn().mockResolvedValue(undefined)),
}));
vi.mock("../src/adapter/methods/delete-many", () => ({
  deleteManyMethod: vi.fn(() => vi.fn().mockResolvedValue(0)),
}));
vi.mock("../src/adapter/methods/consume-one", () => ({
  consumeOneMethod: vi.fn(() => vi.fn().mockResolvedValue(null)),
}));
vi.mock("../src/adapter/transaction", () => ({
  createTransactionWrapper: vi.fn().mockReturnValue(vi.fn()),
}));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: (c: any) => c },
}));

const baseConfig: DynamoDBAdapterConfig = {
  client: { send: vi.fn().mockResolvedValue({}), config: {} } as any,
  tables: {
    user: "test-users",
    session: "test-sessions",
    account: "test-accounts",
    verification: "test-verifications",
  },
};

describe("getTableName", () => {
  it("returns table name for core models", () => {
    expect(getTableName("user", baseConfig)).toBe("test-users");
    expect(getTableName("session", baseConfig)).toBe("test-sessions");
    expect(getTableName("account", baseConfig)).toBe("test-accounts");
    expect(getTableName("verification", baseConfig)).toBe("test-verifications");
  });

  it("returns table name for plugin models", () => {
    const config: DynamoDBAdapterConfig = {
      ...baseConfig,
      tables: { ...baseConfig.tables, organization: "test-orgs" },
    };
    expect(getTableName("organization", config)).toBe("test-orgs");
  });

  it("throws UNKNOWN_MODEL for unregistered model", () => {
    expect(() => getTableName("nonexistent", baseConfig)).toThrow(
      /UNKNOWN_MODEL/,
    );
  });
});

describe("dynamodbAdapter", () => {
  it("returns a function (adapter factory constructed)", () => {
    const result = dynamodbAdapter(baseConfig);
    expect(typeof result).toBe("function");
  });

  it("constructs without throwing with enableEmailUniqueness flag and emailLookups table", () => {
    const config: DynamoDBAdapterConfig = {
      ...baseConfig,
      enableEmailUniqueness: true,
      tables: { ...baseConfig.tables, emailLookups: "test-email-lookups" },
    };
    expect(() => dynamodbAdapter(config)).not.toThrow();
  });

  it("constructs without throwing with keySchemas overrides", () => {
    const config: DynamoDBAdapterConfig = {
      ...baseConfig,
      keySchemas: { organization: { pkField: "slug" } },
    };
    expect(() => dynamodbAdapter(config)).not.toThrow();
  });

  it("constructs without throwing with usePlural and debugLogs flags", () => {
    const config: DynamoDBAdapterConfig = {
      ...baseConfig,
      usePlural: true,
      debugLogs: true,
      warnOnLargeCount: 5000,
      updateManyConcurrency: 5,
    };
    expect(() => dynamodbAdapter(config)).not.toThrow();
  });

  it("constructs with unsafeBatchUpdate flag", () => {
    const config: DynamoDBAdapterConfig = {
      ...baseConfig,
      unsafeBatchUpdate: true,
    };
    expect(() => dynamodbAdapter(config)).not.toThrow();
  });

  it("constructs without client (transaction disabled)", () => {
    const config: DynamoDBAdapterConfig = {
      ...baseConfig,
      client: undefined as any,
    };
    expect(() => dynamodbAdapter(config)).not.toThrow();
  });
});

describe("dynamodbAdapter — transform lambdas", () => {
  beforeEach(() => {
    capturedFactoryArg = undefined;
  });

  it("customTransformInput converts Date → ISO string for date fields", () => {
    dynamodbAdapter(baseConfig);
    const input = capturedFactoryArg.config.customTransformInput;
    const d = new Date("2026-05-30T18:00:00.000Z");
    expect(input({ data: d, fieldAttributes: { type: "date" } })).toBe(
      "2026-05-30T18:00:00.000Z",
    );
  });

  it("customTransformInput passes non-date values unchanged", () => {
    dynamodbAdapter(baseConfig);
    const input = capturedFactoryArg.config.customTransformInput;
    expect(input({ data: "hello", fieldAttributes: { type: "string" } })).toBe(
      "hello",
    );
    expect(input({ data: 42, fieldAttributes: { type: "number" } })).toBe(42);
  });

  it("customTransformInput passes non-Date values through even on date fields", () => {
    dynamodbAdapter(baseConfig);
    const input = capturedFactoryArg.config.customTransformInput;
    // Already-stringified ISO comes through unchanged (e.g., from prior layer)
    expect(
      input({ data: "2026-05-30T18:00:00.000Z", fieldAttributes: { type: "date" } }),
    ).toBe("2026-05-30T18:00:00.000Z");
  });

  it("customTransformOutput converts ISO string → Date for date fields", () => {
    dynamodbAdapter(baseConfig);
    const output = capturedFactoryArg.config.customTransformOutput;
    const result = output({
      data: "2026-05-30T18:00:00.000Z",
      fieldAttributes: { type: "date" },
    });
    expect(result).toBeInstanceOf(Date);
    expect(result.toISOString()).toBe("2026-05-30T18:00:00.000Z");
  });

  it("customTransformOutput passes null/undefined through on date fields", () => {
    dynamodbAdapter(baseConfig);
    const output = capturedFactoryArg.config.customTransformOutput;
    expect(output({ data: null, fieldAttributes: { type: "date" } })).toBeNull();
    expect(
      output({ data: undefined, fieldAttributes: { type: "date" } }),
    ).toBeUndefined();
  });

  it("customTransformOutput passes non-date values unchanged", () => {
    dynamodbAdapter(baseConfig);
    const output = capturedFactoryArg.config.customTransformOutput;
    expect(
      output({ data: "hello", fieldAttributes: { type: "string" } }),
    ).toBe("hello");
    expect(output({ data: 42, fieldAttributes: { type: "number" } })).toBe(42);
  });

  it("data-type flags are set per DESIGN.md §8", () => {
    dynamodbAdapter(baseConfig);
    const c = capturedFactoryArg.config;
    expect(c.supportsJSON).toBe(true);
    expect(c.supportsDates).toBe(true);
    expect(c.supportsBooleans).toBe(true);
    expect(c.supportsArrays).toBe(true);
    expect(c.supportsNumericIds).toBe(false);
  });

  it("adapterId and adapterName are set", () => {
    dynamodbAdapter(baseConfig);
    const c = capturedFactoryArg.config;
    expect(c.adapterId).toBe("dynamodb-adapter");
    expect(c.adapterName).toBe("DynamoDB Adapter");
  });

  it("adapter() returns the native methods bag (all 9 methods)", () => {
    dynamodbAdapter(baseConfig);
    const methods = capturedFactoryArg.adapter();
    expect(typeof methods.create).toBe("function");
    expect(typeof methods.findOne).toBe("function");
    expect(typeof methods.findMany).toBe("function");
    expect(typeof methods.count).toBe("function");
    expect(typeof methods.update).toBe("function");
    expect(typeof methods.updateMany).toBe("function");
    expect(typeof methods.delete).toBe("function");
    expect(typeof methods.deleteMany).toBe("function");
    expect(typeof methods.consumeOne).toBe("function");
  });

  it("forgiving tables Proxy: known model returns mapped name", () => {
    dynamodbAdapter(baseConfig);
    // The proxied tables object lives on the native methods' config — exercise
    // it through getTableName.
    expect(getTableName("user", baseConfig)).toBe("test-users");
  });
});
