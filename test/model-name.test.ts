/**
 * Model-name normalization (usePlural / modelName mapping).
 *
 * better-auth applies getModelName BEFORE calling adapter methods, so the
 * adapter receives mapped names ("users", "sessions"). Config maps and the
 * hardcoded core key schemas are keyed by DEFAULT names — every lookup must
 * normalize through the registered resolver.
 */

import { describe, it, expect } from "vitest";
import {
  registerModelNameResolver,
  toDefaultModelName,
} from "../src/helpers/model-name";
import { getKeySchema } from "../src/helpers/key-builder";
import { getTableName } from "../src/adapter/client";
import { findGsiForField } from "../src/helpers/gsi-resolver";
import type { DynamoDBAdapterConfig } from "../src/types";

function makeConfig(): DynamoDBAdapterConfig {
  return {
    client: {} as any,
    tables: {
      user: "app-users",
      session: "app-sessions",
      account: "app-accounts",
      verification: "app-verifications",
    },
    indexes: {
      session: {
        userId: { indexName: "userId-index", hashKey: "userId" },
      },
    },
  };
}

/** Mimics better-auth's getDefaultModelName with usePlural: true. */
function pluralResolver(model: string): string {
  return model.endsWith("s") ? model.slice(0, -1) : model;
}

describe("toDefaultModelName", () => {
  it("is identity when no resolver is registered", () => {
    const config = makeConfig();
    expect(toDefaultModelName(config, "sessions")).toBe("sessions");
  });

  it("applies the registered resolver", () => {
    const config = makeConfig();
    registerModelNameResolver(config, pluralResolver);
    expect(toDefaultModelName(config, "sessions")).toBe("session");
    expect(toDefaultModelName(config, "user")).toBe("user");
  });

  it("falls back to the raw name when the resolver throws", () => {
    const config = makeConfig();
    registerModelNameResolver(config, () => {
      throw new Error("model not in schema");
    });
    expect(toDefaultModelName(config, "emailLookups")).toBe("emailLookups");
  });
});

describe("usePlural round-trip through config lookups", () => {
  it("getKeySchema resolves the session PK through a plural name", () => {
    const config = makeConfig();
    registerModelNameResolver(config, pluralResolver);
    // Without normalization this degraded to { pkField: "id" } — the
    // session table's actual PK is "token".
    expect(getKeySchema("sessions", config)).toEqual({ pkField: "token" });
  });

  it("getTableName resolves the configured table through a plural name", () => {
    const config = makeConfig();
    registerModelNameResolver(config, pluralResolver);
    expect(getTableName("sessions", config)).toBe("app-sessions");
  });

  it("findGsiForField resolves GSIs through a plural name", () => {
    const config = makeConfig();
    registerModelNameResolver(config, pluralResolver);
    expect(findGsiForField("sessions", "userId", config)?.indexName).toBe(
      "userId-index",
    );
  });

  it("rateLimit core schema resolves PK 'key'", () => {
    const config = makeConfig();
    expect(getKeySchema("rateLimit", config)).toEqual({ pkField: "key" });
  });
});
