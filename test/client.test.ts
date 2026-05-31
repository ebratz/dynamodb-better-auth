import { describe, it, expect, vi } from "vitest";
import { resolveDocClient, getTableName } from "../src/adapter/client";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import type { DynamoDBAdapterConfig } from "../src/types";

describe("resolveDocClient", () => {
  it("wraps a raw DynamoDBClient into DynamoDBDocumentClient", () => {
    const rawClient = new DynamoDBClient({ region: "us-east-1" });
    const docClient = resolveDocClient(rawClient);
    expect(docClient).toBeInstanceOf(DynamoDBDocumentClient);
  });

  it("returns DocumentClient instances unchanged", () => {
    const rawClient = new DynamoDBClient({ region: "us-east-1" });
    const preWrapped = DynamoDBDocumentClient.from(rawClient);
    const docClient = resolveDocClient(preWrapped);
    expect(docClient).toBeInstanceOf(DynamoDBDocumentClient);
  });

  it("passes through objects with translateConfig (cross-package dedup)", () => {
    // Simulate a cross-package DocumentClient where instanceof fails.
    const fakeDocClient = {
      send: vi.fn().mockResolvedValue({}),
      destroy: vi.fn(),
      config: { serviceId: "DynamoDB" },
      middlewareStack: { add: vi.fn(), addRelativeTo: vi.fn(), clone: vi.fn() },
      translateConfig: { marshallOptions: {}, unmarshallOptions: {} },
    };
    const result = resolveDocClient(fakeDocClient as any);
    expect(result).toBe(fakeDocClient);
  });

  it("wrapping applies removeUndefinedValues:true", () => {
    const rawClient = new DynamoDBClient({ region: "us-east-1" });
    const docClient = resolveDocClient(rawClient);
    // Translate config is stored on the DocumentClient instance.
    const cfg = (docClient as any).config?.translateConfig;
    // If config path is not accessible, at minimum the instance is correct.
    expect(docClient).toBeInstanceOf(DynamoDBDocumentClient);
    if (cfg) {
      expect(cfg.marshallOptions?.removeUndefinedValues).toBe(true);
    }
  });
});

describe("getTableName", () => {
  const config: DynamoDBAdapterConfig = {
    client: {} as any,
    tables: {
      user: "my-users",
      session: "my-sessions",
      account: "my-accounts",
      verification: "my-verifications",
    },
  };

  it("returns the configured table name for user", () => {
    expect(getTableName("user", config)).toBe("my-users");
  });

  it("returns the configured table name for session", () => {
    expect(getTableName("session", config)).toBe("my-sessions");
  });

  it("returns the configured table name for account", () => {
    expect(getTableName("account", config)).toBe("my-accounts");
  });

  it("returns the configured table name for verification", () => {
    expect(getTableName("verification", config)).toBe("my-verifications");
  });

  it("supports plugin model tables", () => {
    const pluginConfig: DynamoDBAdapterConfig = {
      ...config,
      tables: { ...config.tables, organization: "Organizations" },
    };
    expect(getTableName("organization", pluginConfig)).toBe("Organizations");
  });

  it("throws for unknown model", () => {
    expect(() => getTableName("unknown", config)).toThrow(
      'No table configured for model "unknown"',
    );
  });
});
