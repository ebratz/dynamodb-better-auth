/**
 * Shared GSI resolution — matches on the declaration's hashKey, never on
 * the config map key (which is a human label).
 */

import { describe, it, expect } from "vitest";
import {
  findGsiForField,
  findGsiByIndexName,
  listGsis,
} from "../src/helpers/gsi-resolver";
import type { DynamoDBAdapterConfig } from "../src/types";

function makeConfig(): DynamoDBAdapterConfig {
  return {
    client: {} as any,
    tables: {
      user: "users",
      session: "sessions",
      account: "accounts",
      verification: "verifications",
    },
    indexes: {
      user: {
        // Map key is a LABEL, not the field name — resolution must match
        // on hashKey.
        byEmail: { indexName: "email-index", hashKey: "email" },
      },
      session: {
        userId: {
          indexName: "userId-index",
          hashKey: "userId",
          rangeKey: "createdAt",
        },
      },
    },
  };
}

describe("findGsiForField", () => {
  it("matches on hashKey even when the map key is a label", () => {
    const config = makeConfig();
    expect(findGsiForField("user", "email", config)?.indexName).toBe(
      "email-index",
    );
  });

  it("does NOT match on the map key when hashKey differs", () => {
    const config = makeConfig();
    // "byEmail" is the map key, not a field
    expect(findGsiForField("user", "byEmail", config)).toBeUndefined();
  });

  it("returns undefined for unindexed fields and unknown models", () => {
    const config = makeConfig();
    expect(findGsiForField("user", "name", config)).toBeUndefined();
    expect(findGsiForField("nope", "email", config)).toBeUndefined();
  });
});

describe("findGsiByIndexName", () => {
  it("resolves the declaration including rangeKey", () => {
    const config = makeConfig();
    const gsi = findGsiByIndexName("session", "userId-index", config);
    expect(gsi?.hashKey).toBe("userId");
    expect(gsi?.rangeKey).toBe("createdAt");
  });

  it("returns undefined for unknown index names", () => {
    const config = makeConfig();
    expect(findGsiByIndexName("session", "nope-index", config)).toBeUndefined();
  });
});

describe("listGsis", () => {
  it("lists declarations for a model", () => {
    const config = makeConfig();
    expect(listGsis("user", config)).toHaveLength(1);
    expect(listGsis("verification", config)).toHaveLength(0);
  });
});
