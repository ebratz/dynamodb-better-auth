/**
 * Type-safety smoke tests for DynamoDBAdapterConfig.
 *
 * Verifies that the config interface accepts all documented shapes
 * at both compile-time and runtime. Catches config drift before
 * integration tests run.
 */

import { describe, it, expect } from "vitest";
import type {
  DynamoDBAdapterConfig,
  GsiDeclaration,
  KeySchemaOverride,
  AdapterLogger,
} from "../src/types";

describe("DynamoDBAdapterConfig type-safety", () => {
  it("tables accepts all required core models", () => {
    const config: DynamoDBAdapterConfig = {
      client: {} as any,
      tables: {
        user: "Users",
        session: "Sessions",
        account: "Accounts",
        verification: "Verifications",
      },
    };
    expect(config.tables.user).toBe("Users");
    expect(config.tables.session).toBe("Sessions");
  });

  it("tables accepts optional emailLookups and plugin models", () => {
    const config: DynamoDBAdapterConfig = {
      client: {} as any,
      tables: {
        user: "U",
        session: "S",
        account: "A",
        verification: "V",
        emailLookups: "EmailLookups",
        organization: "Orgs",
        customPlugin: "Custom",
      },
    };
    expect(config.tables.emailLookups).toBe("EmailLookups");
    expect(config.tables.organization).toBe("Orgs");
    expect(config.tables.customPlugin).toBe("Custom");
  });

  it("indexes accepts GSI declaration with projection: ALL", () => {
    const gsi: GsiDeclaration = {
      indexName: "email-index",
      hashKey: "email",
      projection: "ALL",
    };
    expect(gsi.projection).toBe("ALL");
  });

  it("indexes accepts GSI declaration with projection: KEYS_ONLY", () => {
    const gsi: GsiDeclaration = {
      indexName: "by-id",
      hashKey: "id",
      projection: "KEYS_ONLY",
    };
    expect(gsi.projection).toBe("KEYS_ONLY");
  });

  it("indexes accepts GSI declaration with projection: { include }", () => {
    const gsi: GsiDeclaration = {
      indexName: "name-index",
      hashKey: "name",
      rangeKey: "createdAt",
      projection: { include: ["email", "status"] },
    };
    expect(gsi.projection).toEqual({ include: ["email", "status"] });
    expect(gsi.rangeKey).toBe("createdAt");
  });

  it("indexes accepts model-level GSI map", () => {
    const config: DynamoDBAdapterConfig = {
      client: {} as any,
      tables: { user: "U", session: "S", account: "A", verification: "V" },
      indexes: {
        user: {
          email: { indexName: "email-index", hashKey: "email" },
          status: { indexName: "status-index", hashKey: "status", rangeKey: "createdAt" },
        },
        session: {
          userId: { indexName: "userId-index", hashKey: "userId" },
        },
      },
    };
    expect(config.indexes?.user?.email?.indexName).toBe("email-index");
    expect(config.indexes?.session?.userId?.indexName).toBe("userId-index");
  });

  it("keySchemas accepts { pkField, skField? } overrides", () => {
    const override: KeySchemaOverride = { pkField: "tenantId", skField: "entityId" };
    expect(override.pkField).toBe("tenantId");
    expect(override.skField).toBe("entityId");

    const pkOnly: KeySchemaOverride = { pkField: "orgId" };
    expect(pkOnly.pkField).toBe("orgId");
    expect(pkOnly.skField).toBeUndefined();
  });

  it("keySchemas accepts model → override map in config", () => {
    const config: DynamoDBAdapterConfig = {
      client: {} as any,
      tables: { user: "U", session: "S", account: "A", verification: "V" },
      keySchemas: {
        user: { pkField: "customId" },
        session: { pkField: "tenantId", skField: "sessionId" },
      },
    };
    expect(config.keySchemas?.user?.pkField).toBe("customId");
    expect(config.keySchemas?.session?.skField).toBe("sessionId");
  });

  it("logger accepts a custom AdapterLogger implementation", () => {
    const messages: string[] = [];
    const customLogger: AdapterLogger = {
      warn: (msg) => { messages.push(`WARN:${msg}`); },
      debug: (msg) => { messages.push(`DEBUG:${msg}`); },
    };

    const config: DynamoDBAdapterConfig = {
      client: {} as any,
      tables: { user: "U", session: "S", account: "A", verification: "V" },
      logger: customLogger,
    };

    config.logger!.warn("test-warn");
    config.logger!.debug!("test-debug");
    expect(messages).toEqual(["WARN:test-warn", "DEBUG:test-debug"]);
  });

  it("extensions accepts middleware array", () => {
    const auditLog: any[] = [];
    const config: DynamoDBAdapterConfig = {
      client: {} as any,
      tables: { user: "U", session: "S", account: "A", verification: "V" },
      extensions: [
        {
          name: "audit",
          onAfterCreate: async (args) => {
            auditLog.push({ op: "create", model: args.model });
          },
        },
        {
          name: "multi-tenant",
          onBeforeCreate: async (args) => ({
            ...args.data,
            tenantId: "t1",
          }),
        },
      ],
    };

    expect(config.extensions?.length).toBe(2);
    expect(config.extensions![0]!.name).toBe("audit");
    expect(config.extensions![1]!.name).toBe("multi-tenant");
  });

  it("safety limits accept custom values", () => {
    const config: DynamoDBAdapterConfig = {
      client: {} as any,
      tables: { user: "U", session: "S", account: "A", verification: "V" },
      maxUpdateManyItems: 500,
      maxDeleteManyItems: 200,
      updateManyConcurrency: 5,
    };
    expect(config.maxUpdateManyItems).toBe(500);
    expect(config.maxDeleteManyItems).toBe(200);
    expect(config.updateManyConcurrency).toBe(5);
  });

  it("safety limits accept zero (disabled)", () => {
    const config: DynamoDBAdapterConfig = {
      client: {} as any,
      tables: { user: "U", session: "S", account: "A", verification: "V" },
      maxUpdateManyItems: 0,
      maxDeleteManyItems: 0,
    };
    expect(config.maxUpdateManyItems).toBe(0);
    expect(config.maxDeleteManyItems).toBe(0);
  });
});
