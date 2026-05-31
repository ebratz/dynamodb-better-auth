import { describe, it, expect } from "vitest";
import { getKeySchema, buildKeyFromWhere } from "../src/helpers/key-builder";
import type { DynamoDBAdapterConfig } from "../src/types";

const baseConfig: DynamoDBAdapterConfig = {
  client: {} as any,
  tables: {
    user: "Users",
    session: "Sessions",
    account: "Accounts",
    verification: "Verifications",
    emailLookups: "EmailLookups",
  },
};

describe("getKeySchema", () => {
  it("returns pk:id for user", () => {
    expect(getKeySchema("user", baseConfig)).toEqual({ pkField: "id" });
  });

  it("returns pk:token for session", () => {
    expect(getKeySchema("session", baseConfig)).toEqual({ pkField: "token" });
  });

  it("returns pk:providerId sk:accountId for account", () => {
    expect(getKeySchema("account", baseConfig)).toEqual({
      pkField: "providerId",
      skField: "accountId",
    });
  });

  it("returns pk:id for verification", () => {
    expect(getKeySchema("verification", baseConfig)).toEqual({ pkField: "id" });
  });

  it("returns pk:email for emailLookups", () => {
    expect(getKeySchema("emailLookups", baseConfig)).toEqual({ pkField: "email" });
  });

  it("overrides with config.keySchemas", () => {
    const config: DynamoDBAdapterConfig = {
      ...baseConfig,
      keySchemas: {
        user: { pkField: "userId", skField: "sortKey" },
      },
    };
    expect(getKeySchema("user", config)).toEqual({
      pkField: "userId",
      skField: "sortKey",
    });
  });

  it("defaults unknown plugin models to pk:id", () => {
    expect(getKeySchema("organization", baseConfig)).toEqual({ pkField: "id" });
    expect(getKeySchema("team", baseConfig)).toEqual({ pkField: "id" });
  });

  it("overrides plugin models via keySchemas", () => {
    const config: DynamoDBAdapterConfig = {
      ...baseConfig,
      keySchemas: {
        organization: { pkField: "orgId", skField: "memberId" },
      },
    };
    expect(getKeySchema("organization", config)).toEqual({
      pkField: "orgId",
      skField: "memberId",
    });
  });
});

describe("buildKeyFromWhere", () => {
  it("extracts simple PK from where clause", () => {
    const key = buildKeyFromWhere(
      [{ field: "id", operator: "eq", value: "user-123" }],
      "user",
      baseConfig,
    );
    expect(key).toEqual({ id: "user-123" });
  });

  it("defaults operator to eq when omitted", () => {
    const key = buildKeyFromWhere(
      [{ field: "id", value: "user-456" }],
      "user",
      baseConfig,
    );
    expect(key).toEqual({ id: "user-456" });
  });

  it("extracts composite PK+SK from account where", () => {
    const key = buildKeyFromWhere(
      [
        { field: "providerId", operator: "eq", value: "google" },
        { field: "accountId", operator: "eq", value: "12345" },
      ],
      "account",
      baseConfig,
    );
    expect(key).toEqual({ providerId: "google", accountId: "12345" });
  });

  it("skips SK when not present in where", () => {
    const key = buildKeyFromWhere(
      [{ field: "providerId", operator: "eq", value: "google" }],
      "account",
      baseConfig,
    );
    expect(key).toEqual({ providerId: "google" });
  });

  it("extracts session PK by token", () => {
    const key = buildKeyFromWhere(
      [{ field: "token", operator: "eq", value: "sess-abc" }],
      "session",
      baseConfig,
    );
    expect(key).toEqual({ token: "sess-abc" });
  });

  it("extracts emailLookups PK by email", () => {
    const key = buildKeyFromWhere(
      [{ field: "email", operator: "eq", value: "x@y.com" }],
      "emailLookups",
      baseConfig,
    );
    expect(key).toEqual({ email: "x@y.com" });
  });

  it("throws InvalidWhereError when PK field is missing", () => {
    expect(() =>
      buildKeyFromWhere(
        [{ field: "name", operator: "eq", value: "John" }],
        "user",
        baseConfig,
      ),
    ).toThrow(/missing PK field/);
  });

  it("throws InvalidWhereError when PK operator is not eq", () => {
    expect(() =>
      buildKeyFromWhere(
        [{ field: "id", operator: "ne", value: "user-123" }],
        "user",
        baseConfig,
      ),
    ).toThrow(/must use "eq"/);
  });

  it("throws InvalidWhereError when SK operator is not eq", () => {
    expect(() =>
      buildKeyFromWhere(
        [
          { field: "providerId", operator: "eq", value: "google" },
          { field: "accountId", operator: "gt", value: "12345" },
        ],
        "account",
        baseConfig,
      ),
    ).toThrow(/must use "eq"/);
  });

  it("throws InvalidWhereError on empty where", () => {
    expect(() =>
      buildKeyFromWhere([], "user", baseConfig),
    ).toThrow(/missing PK field/);
  });

  it("respects keySchemas override for buildKey", () => {
    const config: DynamoDBAdapterConfig = {
      ...baseConfig,
      keySchemas: {
        organization: { pkField: "orgId", skField: "memberId" },
      },
    };
    const key = buildKeyFromWhere(
      [
        { field: "orgId", operator: "eq", value: "org-1" },
        { field: "memberId", operator: "eq", value: "mem-1" },
      ],
      "organization",
      config,
    );
    expect(key).toEqual({ orgId: "org-1", memberId: "mem-1" });
  });
});
