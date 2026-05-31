/**
 * Integration test — Block I.
 *
 * Uses DynamoDB Local. Tables are created by test/setup.ts before the suite runs.
 * Tests the full Better Auth adapter scenario directly against the adapter.
 *
 * Usage:
 *   docker run -d --name dynamodb-local -p 8001:8000 amazon/dynamodb-local
 *   DYNAMODB_ENDPOINT=http://localhost:8001 npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DynamoDBClient, DeleteTableCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBAdapterConfig } from "../src/types";
import { dynamodbAdapter } from "../src/adapter/factory";
import { setupTables } from "./setup";
import type { BetterAuthOptions } from "better-auth";

// ── Config ─────────────────────────────────────────────────────

const TABLE_NAMES = {
  user: "test-users",
  session: "test-sessions",
  account: "test-accounts",
  verification: "test-verifications",
  emailLookups: "test-email-lookups",
  organization: "test-organizations",
};

const adapterConfig: DynamoDBAdapterConfig = {
  client: new DynamoDBClient({
    endpoint: process.env.DYNAMODB_ENDPOINT || "http://localhost:8001",
    region: "us-east-1",
    credentials: { accessKeyId: "fake", secretAccessKey: "fake" },
  }),
  tables: TABLE_NAMES,
  indexes: {
    user: {
      email: { indexName: "email-index", hashKey: "email" },
    },
    session: {
      userId: { indexName: "userId-index", hashKey: "userId" },
      id: { indexName: "by-id", hashKey: "id", projection: "KEYS_ONLY" },
    },
    account: {
      userId: { indexName: "by-userId", hashKey: "userId", projection: "ALL" },
      id: { indexName: "by-id", hashKey: "id", projection: "KEYS_ONLY" },
    },
    verification: {
      identifier: { indexName: "identifier-index", hashKey: "identifier" },
    },
    organization: {
      slug: { indexName: "slug-index", hashKey: "slug" },
    },
  },
  keySchemas: {
    organization: { pkField: "id" },
  },
  enableEmailUniqueness: true,
  warnOnLargeCount: 100,
};

// ── Global setup / teardown ────────────────────────────────────

let adapter: ReturnType<ReturnType<typeof dynamodbAdapter>>;
const mockOptions = {} as BetterAuthOptions;

beforeAll(async () => {
  console.log("\n  Creating tables in DynamoDB Local...\n");
  await setupTables();
  console.log("  Tables ready.\n");
  adapter = dynamodbAdapter(adapterConfig)(mockOptions);
}, 60000);

afterAll(async () => {
  const rawClient = new DynamoDBClient({
    endpoint: process.env.DYNAMODB_ENDPOINT || "http://localhost:8001",
    region: "us-east-1",
    credentials: { accessKeyId: "fake", secretAccessKey: "fake" },
  });
  for (const name of Object.values(TABLE_NAMES)) {
    try { await rawClient.send(new DeleteTableCommand({ TableName: name })); } catch { /* ok */ }
  }
});

// ── Helpers ────────────────────────────────────────────────────

const now = () => new Date();
const later = (ms = 3600000) => new Date(Date.now() + ms);

// ── User CRUD ──────────────────────────────────────────────────

describe("User CRUD", () => {
  it("creates and finds a user", async () => {
    const user = await adapter.create({
      model: "user",
      data: {
        email: "crud@test.com",
        emailVerified: false,
        name: "CRUD User",
        createdAt: now(),
        updatedAt: now(),
      },
    });
    expect(user.email).toBe("crud@test.com");
    expect(user.name).toBe("CRUD User");
    expect(typeof user.id).toBe("string");

    const found = await adapter.findOne({
      model: "user",
      where: [{ field: "id", operator: "eq", value: user.id }],
    });
    expect(found).not.toBeNull();
    expect(found!.email).toBe("crud@test.com");
    expect(found!.createdAt).toBeInstanceOf(Date);
  });

  it("updates a user", async () => {
    const user = await adapter.create({
      model: "user",
      data: {
        email: "update@test.com",
        emailVerified: false,
        name: "Before",
        createdAt: now(),
        updatedAt: now(),
      },
    });

    const updated = await adapter.update({
      model: "user",
      where: [{ field: "id", operator: "eq", value: user.id }],
      update: { name: "After", emailVerified: true },
    });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("After");
    expect(updated!.emailVerified).toBe(true);
  });

  it("finds user by email via GSI (Tier 2)", async () => {
    const email = "gsi-lookup@test.com";
    const user = await adapter.create({
      model: "user",
      data: {
        email,
        emailVerified: false,
        name: "GSI User",
        createdAt: now(),
        updatedAt: now(),
      },
    });

    const found = await adapter.findOne({
      model: "user",
      where: [{ field: "email", operator: "eq", value: email }],
    });
    expect(found).not.toBeNull();
    expect(found!.id).toBe(user.id);
  });

  it("counts users", async () => {
    const c = await adapter.count({ model: "user", where: [] });
    expect(c).toBeGreaterThan(0);
  });

  it("deletes a user", async () => {
    const user = await adapter.create({
      model: "user",
      data: {
        email: "delete@test.com",
        emailVerified: false,
        name: "Del",
        createdAt: now(),
        updatedAt: now(),
      },
    });

    await adapter.delete({
      model: "user",
      where: [{ field: "id", operator: "eq", value: user.id }],
    });

    const gone = await adapter.findOne({
      model: "user",
      where: [{ field: "id", operator: "eq", value: user.id }],
    });
    expect(gone).toBeNull();
  });
});

// ── Session CRUD ───────────────────────────────────────────────

describe("Session CRUD", () => {
  const token = "sess-token-integration";
  let userId: string;

  beforeAll(async () => {
    const user = await adapter.create({
      model: "user",
      data: {
        email: "sess@integration.test",
        emailVerified: false,
        name: "Sess",
        createdAt: now(),
        updatedAt: now(),
      },
    });
    userId = user.id;
  });

  it("creates a session with PK=token", async () => {
    const sess = await adapter.create({
      model: "session",
      data: {
        userId,
        token,
        expiresAt: later(),
        createdAt: now(),
        updatedAt: now(),
      },
    });
    expect(sess.token).toBe(token);
    expect(sess.userId).toBe(userId);
  });

  it("finds session by token (Tier 1 GetItem — hot path)", async () => {
    const sess = await adapter.findOne({
      model: "session",
      where: [{ field: "token", operator: "eq", value: token }],
    });
    expect(sess).not.toBeNull();
    expect(sess!.token).toBe(token);
  });

  it("finds sessions by userId (Tier 2 GSI Query)", async () => {
    const sessions = await adapter.findMany({
      model: "session",
      where: [{ field: "userId", operator: "eq", value: userId }],
    });
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(sessions[0]!.userId).toBe(userId);
  });
});

// ── Account CRUD (composite key) ───────────────────────────────

describe("Account CRUD (composite PK)", () => {
  let userId: string;

  beforeAll(async () => {
    const user = await adapter.create({
      model: "user",
      data: {
        email: "acc-integration@test.com",
        emailVerified: false,
        name: "Acc",
        createdAt: now(),
        updatedAt: now(),
      },
    });
    userId = user.id;
  });

  it("creates account with (providerId, accountId) composite key", async () => {
    const acc = await adapter.create({
      model: "account",
      data: {
        userId,
        providerId: "google-integration",
        accountId: "google-abc",
        createdAt: now(),
        updatedAt: now(),
      },
    });
    expect(acc.providerId).toBe("google-integration");
    expect(acc.accountId).toBe("google-abc");
  });

  it("duplicate (providerId, accountId) fails (atomic uniqueness)", async () => {
    await expect(
      adapter.create({
        model: "account",
        data: {
          userId,
          providerId: "google-integration",
          accountId: "google-abc",
          createdAt: now(),
          updatedAt: now(),
        },
      }),
    ).rejects.toThrow();
  });

  it("finds account by userId (Tier 2 GSI)", async () => {
    const accounts = await adapter.findMany({
      model: "account",
      where: [{ field: "userId", operator: "eq", value: userId }],
    });
    expect(accounts.length).toBe(1);
  });
});

// ── Verification + consumeOne ──────────────────────────────────

describe("Verification + consumeOne", () => {
  it("finds verification by identifier via GSI (Tier 2)", async () => {
    const v = await adapter.create({
      model: "verification",
      data: {
        identifier: "find-by-ident",
        value: "token-abc",
        expiresAt: later(),
        createdAt: now(),
        updatedAt: now(),
      },
    });

    const found = await adapter.findOne({
      model: "verification",
      where: [{ field: "identifier", operator: "eq", value: "find-by-ident" }],
    });
    expect(found).not.toBeNull();
    expect(found!.identifier).toBe("find-by-ident");
    expect(found!.id).toBe(v.id);
  });

  it("consumeOne by identifier returns item and removes it (Tier 2 GSI)", async () => {
    const ident = "consume-tok-run-1";
    const created = await adapter.create({
      model: "verification",
      data: {
        identifier: ident,
        value: "val-123",
        expiresAt: later(),
        createdAt: now(),
        updatedAt: now(),
      },
    });

    const consumed = await adapter.consumeOne({
      model: "verification",
      where: [{ field: "identifier", operator: "eq", value: ident }],
    });
    expect(consumed).not.toBeNull();
    expect(consumed!.id).toBe(created.id);
    expect(consumed!.identifier).toBe(ident);

    // Second consume returns null
    const gone = await adapter.consumeOne({
      model: "verification",
      where: [{ field: "identifier", operator: "eq", value: ident }],
    });
    expect(gone).toBeNull();
  });
});

// ── Email uniqueness ───────────────────────────────────────────

describe("Email Uniqueness", () => {
  it("prevents duplicate email via EmailLookups sidecar", async () => {
    const email = "unique-int@test.com";
    await adapter.create({
      model: "user",
      data: {
        email,
        emailVerified: false,
        name: "First",
        createdAt: now(),
        updatedAt: now(),
      },
    });

    await expect(
      adapter.create({
        model: "user",
        data: {
          email,
          emailVerified: false,
          name: "Second",
          createdAt: now(),
          updatedAt: now(),
        },
      }),
    ).rejects.toThrow();
  });
});

// ── Transaction (no Dates — transaction marshalling is separate) ─

describe("Transaction", () => {
  it("executes atomic create + create in transaction", async () => {
    // Transaction is a lower-level primitive than the factory-wrapped methods —
    // callers must supply primary-key fields explicitly (id for user, token for
    // session). The factory's id generation only runs on non-transactional create.
    const txUserId = `tx-user-${Date.now()}`;
    const txToken = `tx-token-${Date.now()}`;

    await adapter.transaction(async (tx: any) => {
      const user = await tx.create({
        model: "user",
        data: {
          id: txUserId,
          email: "tx-int@test.com",
          emailVerified: false,
          name: "Tx User",
        },
      });
      expect(user.email).toBe("tx-int@test.com");

      const sess = await tx.create({
        model: "session",
        data: {
          userId: txUserId,
          token: txToken,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        } as any,
      });
      expect(sess.token).toBe(txToken);
    });

    // Both created atomically
    const u = await adapter.findOne({
      model: "user",
      where: [{ field: "id", operator: "eq", value: txUserId }],
    });
    expect(u).not.toBeNull();

    const s = await adapter.findOne({
      model: "session",
      where: [{ field: "token", operator: "eq", value: txToken }],
    });
    expect(s).not.toBeNull();
  });
});

// ── FindMany sort+limit (Tier 3) ───────────────────────────────

describe("FindMany sort+limit (Tier 3 fallback)", () => {
  beforeAll(async () => {
    for (let i = 0; i < 5; i++) {
      const ch = String.fromCharCode(65 + i); // A..E
      await adapter.create({
        model: "user",
        data: {
          email: `sort-int-${i}@t.com`,
          emailVerified: false,
          name: `User${ch}`,
          createdAt: now(),
          updatedAt: now(),
        },
      });
    }
  });

  it("returns correct top-2 by name desc", async () => {
    const r = await adapter.findMany({
      model: "user",
      where: [{ field: "email", operator: "contains", value: "sort-int-" }],
      sortBy: { field: "name", direction: "desc" },
      limit: 2,
    });
    expect(r.length).toBe(2);
    expect(r[0]!.name).toBe("UserE");
    expect(r[1]!.name).toBe("UserD");
  });

  it("returns correct top-2 by name asc", async () => {
    const r = await adapter.findMany({
      model: "user",
      where: [{ field: "email", operator: "contains", value: "sort-int-" }],
      sortBy: { field: "name", direction: "asc" },
      limit: 2,
    });
    expect(r.length).toBe(2);
    expect(r[0]!.name).toBe("UserA");
    expect(r[1]!.name).toBe("UserB");
  });
});

// ── Date round-trip ────────────────────────────────────────────

describe("Date round-trip", () => {
  it("Date object survives create → findOne round-trip", async () => {
    const timestamp = new Date();
    const user = await adapter.create({
      model: "user",
      data: {
        email: "date-int@test.com",
        emailVerified: false,
        name: "Date Test",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });

    expect(user.createdAt).toBeInstanceOf(Date);
    expect(user.updatedAt).toBeInstanceOf(Date);

    const found = await adapter.findOne({
      model: "user",
      where: [{ field: "id", operator: "eq", value: user.id }],
    });

    expect(found).not.toBeNull();
    expect(found!.createdAt).toBeInstanceOf(Date);
    expect(found!.updatedAt).toBeInstanceOf(Date);
    expect(Math.abs(found!.createdAt.getTime() - timestamp.getTime())).toBeLessThan(2000);
  });
});

// ── Count ──────────────────────────────────────────────────────

describe("Count", () => {
  it("counts with filter", async () => {
    const c = await adapter.count({
      model: "user",
      where: [{ field: "emailVerified", operator: "eq", value: false }],
    });
    expect(c).toBeGreaterThanOrEqual(0);
  });
});

// ── deleteMany ─────────────────────────────────────────────────

describe("deleteMany", () => {
  beforeAll(async () => {
    for (let i = 0; i < 3; i++) {
      await adapter.create({
        model: "user",
        data: {
          email: `bulk-int-${i}@t.com`,
          emailVerified: false,
          name: "Bulk",
          createdAt: now(),
          updatedAt: now(),
        },
      });
    }
  });

  it("deletes multiple users by email pattern", async () => {
    const count = await adapter.deleteMany({
      model: "user",
      where: [{ field: "email", operator: "contains", value: "bulk-int-" }],
    });
    expect(count).toBeGreaterThanOrEqual(3);
  });
});
