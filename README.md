# @ebratz/dynamodb-better-auth

[![npm version](https://img.shields.io/npm/v/@ebratz/dynamodb-better-auth.svg)](https://www.npmjs.com/package/@ebratz/dynamodb-better-auth)
[![CI](https://github.com/ebratz/dynamodb-better-auth/workflows/CI/badge.svg)](https://github.com/ebratz/dynamodb-better-auth/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](https://www.typescriptlang.org/)

A production-grade DynamoDB adapter for [Better Auth](https://www.better-auth.com).

Designed around DynamoDB's access-pattern-first model: per-model tables, a three-tier query planner (GetItem → GSI Query → Scan), atomic transactions via `TransactWriteItems`, and an optional sidecar table for race-free email uniqueness. Built on `@aws-sdk/lib-dynamodb` v3.

```ts
import { betterAuth } from "better-auth";
import { dynamodbAdapter } from "@ebratz/dynamodb-better-auth";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

export const auth = betterAuth({
  database: dynamodbAdapter({
    client: new DynamoDBClient({ region: "us-east-1" }),
    tables: {
      user:         "myapp-users",
      session:      "myapp-sessions",
      account:      "myapp-accounts",
      verification: "myapp-verifications",
    },
  }),
  session: { cookieCache: { enabled: true, maxAge: 5 * 60 } },
});
```

---

## Highlights

- **Multi-table by design.** One table per Better Auth model — same shape as the official SQL and MongoDB adapters. Clean IAM, no entity discriminators, no key overloading.
- **Three-tier query planner.** Every read picks the cheapest DynamoDB primitive that satisfies the where clause: `GetItem` on PK, `Query` on a configured GSI, or `Scan` + filter (with a debug warning).
- **Atomic transactions.** Hybrid-buffer pattern collects writes inside the `transaction()` callback and flushes them as a single `TransactWriteItems` — across multiple tables — at the end.
- **Race-free email uniqueness.** Optional `EmailLookups` sidecar table written transactionally with user creation. GSIs are eventually consistent; this isn't.
- **Plugin-extensible.** `tables`/`indexes` accept arbitrary plugin models (organization, 2FA, API keys, passkeys). `keySchemas` override default PK/SK per model.
- **`unsafeBatchUpdate` escape hatch.** Default `updateMany` uses per-item `UpdateItem` for field-level merge semantics; opt in to `BatchWriteItem`+`PutItem` when you want speed and own the row.
- **Date round-trip handled.** Symmetric `Date ↔ ISO 8601` conversion (DocumentClient v3 doesn't do this automatically).
- **Strict TypeScript.** Public types exported, errors typed.
- **Tested.** 239 unit tests + 20 integration tests against DynamoDB Local.

---

## Table of contents

- [Installation](#installation)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Table setup](#table-setup)
- [Email uniqueness](#email-uniqueness)
- [Transactions](#transactions)
- [Error handling](#error-handling)
- [Configuration reference](#configuration-reference)
- [Plugin models](#plugin-models)
- [Plugin Schemas](#plugin-schemas)
- [IAM policy](#iam-policy)
- [Operational recommendations](#operational-recommendations)
- [Limitations](#limitations)
- [Migration from SQL Adapters](#migration-from-sql-adapters)
- [Performance Tuning](#performance-tuning)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

---

## Installation

```bash
npm install @ebratz/dynamodb-better-auth \
            @aws-sdk/client-dynamodb \
            @aws-sdk/lib-dynamodb \
            @aws-sdk/util-dynamodb \
            better-auth
```

Or with `pnpm` / `yarn` / `bun` — peer deps are explicit so the package manager will flag any missing ones.

### Peer dependencies

| Package | Why it's required |
|---|---|
| `@aws-sdk/client-dynamodb` | Core DynamoDB client |
| `@aws-sdk/lib-dynamodb` | DocumentClient with automatic marshalling/unmarshalling |
| `@aws-sdk/util-dynamodb` | Type helpers used by the adapter internals |
| `better-auth` | Supplies the `createAdapterFactory` API |

The adapter constructs a `DynamoDBDocumentClient` internally with `removeUndefinedValues: true` so optional fields (`image`, `ipAddress`, etc.) don't trip the marshaller. You only need to pass the raw `DynamoDBClient`.

---

## Quick start

> **⚡ Enable cookie cache for production.** Without it, every authenticated request hits DynamoDB. With it, session validation runs from a signed cookie and only refreshes every few minutes. This is the single biggest performance and cost lever.
>
> ```ts
> session: { cookieCache: { enabled: true, maxAge: 5 * 60 } }
> ```
>
> **Tradeoff:** Revoked sessions remain active on other devices until the cache expires. For sensitive endpoints (password change, account deletion), set `disableCookieCache: true` per-route.

```ts
import { betterAuth } from "better-auth";
import { dynamodbAdapter } from "@ebratz/dynamodb-better-auth";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient({ region: "us-east-1" });

export const auth = betterAuth({
  database: dynamodbAdapter({
    client,
    tables: {
      user:         "myapp-users",
      session:      "myapp-sessions",
      account:      "myapp-accounts",
      verification: "myapp-verifications",
    },
    // Declare GSIs so the query planner can use Query instead of Scan.
    indexes: {
      user:         { email:      { indexName: "email-index",      hashKey: "email" } },
      session:      { userId:     { indexName: "userId-index",     hashKey: "userId" } },
      account:      {
        userId:     { indexName: "by-userId", hashKey: "userId", projection: "ALL" },
        id:         { indexName: "by-id",     hashKey: "id",     projection: "KEYS_ONLY" },
      },
      verification: { identifier: { indexName: "identifier-index", hashKey: "identifier" } },
    },
  }),
  session: {
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },
});
```

---

## How it works

### Multi-table layout

Each Better Auth model gets its own DynamoDB table. The reasoning: DynamoDB is access-pattern-first and each model has different read shapes. Sharing one table would force compromises in key design and complicate IAM.

| Model | Partition key | Sort key | Why |
|---|---|---|---|
| `user` | `id` | — | Looked up by id (account → user join, internal references) |
| `session` | `token` | — | Hot path: session validation by token, every authenticated request |
| `account` | `providerId` | `accountId` | Composite key encodes `UNIQUE(providerId, accountId)` constraint that SQL gets for free |
| `verification` | `id` | — | Verification tokens consumed by id or identifier |
| `emailLookups` (opt-in) | `email` | — | Sidecar for race-free email claims |

### Three-tier query planner

Every `findOne`, `findMany`, `update`, `delete` is routed by a query planner that picks the cheapest DynamoDB primitive that satisfies the `where` clause:

```
where → planner → Tier 1: GetItem      ← single-digit ms
                   Tier 2: Query (GSI)  ← single-digit ms with indexes configured
                   Tier 3: Scan + Filter ← O(table size); logs a warning
```

- **Tier 1 (GetItem):** the `where` matches the table's primary key. Direct lookup, the cheapest read DynamoDB offers.
- **Tier 2 (Query on GSI):** the `where` matches a GSI's hash key (optionally with sort key conditions). Used automatically when you declare the matching `GsiDeclaration` in config.
- **Tier 3 (Scan):** no key match. Iterates the entire table, applies a `FilterExpression`. Emits `[dynamodb-adapter] Scan on <table>` warnings (when `debugLogs` is on) so you know to add a GSI.

The planner explicitly **never silently produces wrong results.** Unsupported operators (`ends_with`, `mode: "insensitive"`) throw `UnsupportedOperatorError`; `offset > 0` on a Tier-2 Query throws `UnsupportedOptionError` (use cursor pagination instead).

### Transaction model

`TransactWriteItems` is write-only — DynamoDB doesn't support read-modify-write inside a transaction. The adapter implements a **buffer-then-flush** pattern:

1. Inside `transaction(async (tx) => { ... })`, calls to `tx.create`, `tx.update`, `tx.delete`, `tx.deleteMany`, `tx.consumeOne` are buffered as `TransactWriteItem` actions.
2. `tx.findOne`, `tx.findMany`, `tx.count` pass through to the database (non-transactional reads).
3. `update` and `consumeOne` eagerly read pre-state via `GetItem` so the returned value reflects the merged result honestly.
4. At callback exit, all buffered actions flush in a single `TransactWriteItems` request with a `ClientRequestToken` for idempotency.
5. If the callback throws, the buffer is discarded — no writes are committed.

See [Transactions](#transactions) for a worked example.

---

## Table setup

The adapter requires **four tables** (five with email uniqueness). Create them before starting your app. Both CloudFormation and AWS CDK examples are provided.

### Users

| Attribute | Type | Key |
|---|---|---|
| `id` | String | **PK** |
| `email` | String | GSI `email-index` PK |
| `name` | String | |
| `emailVerified` | Boolean | |
| `image` | String | |
| `createdAt` | String (ISO) | |
| `updatedAt` | String (ISO) | |

<details>
<summary><strong>CloudFormation</strong></summary>

```yaml
UsersTable:
  Type: AWS::DynamoDB::Table
  Properties:
    TableName: myapp-users
    BillingMode: PAY_PER_REQUEST
    AttributeDefinitions:
      - AttributeName: id
        AttributeType: S
      - AttributeName: email
        AttributeType: S
    KeySchema:
      - AttributeName: id
        KeyType: HASH
    GlobalSecondaryIndexes:
      - IndexName: email-index
        KeySchema:
          - AttributeName: email
            KeyType: HASH
        Projection:
          ProjectionType: ALL
```
</details>

<details>
<summary><strong>AWS CDK (TypeScript)</strong></summary>

```ts
import { Table, AttributeType, BillingMode, ProjectionType } from "aws-cdk-lib/aws-dynamodb";

const users = new Table(this, "Users", {
  tableName: "myapp-users",
  partitionKey: { name: "id", type: AttributeType.STRING },
  billingMode: BillingMode.PAY_PER_REQUEST,
});

users.addGlobalSecondaryIndex({
  indexName: "email-index",
  partitionKey: { name: "email", type: AttributeType.STRING },
  projectionType: ProjectionType.ALL,
});
```
</details>

### Sessions

| Attribute | Type | Key |
|---|---|---|
| `token` | String | **PK** |
| `id` | String | GSI `by-id` PK (optional, for admin plugin) |
| `userId` | String | GSI `userId-index` PK |
| `expiresAt` | String (ISO) | TTL |
| `ipAddress` | String | |
| `userAgent` | String | |
| `createdAt` | String (ISO) | |
| `updatedAt` | String (ISO) | |

**Why `token` as PK?** The hot path — session validation on every authenticated request — looks up sessions by `token`. Making it the PK means a single-digit-ms `GetItem` without any GSI.

> **Admin plugin users:** If you use Better Auth's admin plugin (`listSessions`), add the optional `by-id` GSI. Without it, session-by-id queries fall through to a full Scan.

<details>
<summary><strong>CloudFormation</strong></summary>

```yaml
SessionsTable:
  Type: AWS::DynamoDB::Table
  Properties:
    TableName: myapp-sessions
    BillingMode: PAY_PER_REQUEST
    AttributeDefinitions:
      - AttributeName: token
        AttributeType: S
      - AttributeName: userId
        AttributeType: S
      # Optional — for admin plugin session-by-id queries:
      - AttributeName: id
        AttributeType: S
    KeySchema:
      - AttributeName: token
        KeyType: HASH
    GlobalSecondaryIndexes:
      - IndexName: userId-index
        KeySchema:
          - AttributeName: userId
            KeyType: HASH
        Projection:
          ProjectionType: ALL
      # Optional — for admin plugin:
      - IndexName: by-id
        KeySchema:
          - AttributeName: id
            KeyType: HASH
        Projection:
          ProjectionType: KEYS_ONLY
    TimeToLiveSpecification:
      AttributeName: expiresAt
      Enabled: true
```
</details>

<details>
<summary><strong>AWS CDK (TypeScript)</strong></summary>

```ts
const sessions = new Table(this, "Sessions", {
  tableName: "myapp-sessions",
  partitionKey: { name: "token", type: AttributeType.STRING },
  billingMode: BillingMode.PAY_PER_REQUEST,
  timeToLiveAttribute: "expiresAt",
});

sessions.addGlobalSecondaryIndex({
  indexName: "userId-index",
  partitionKey: { name: "userId", type: AttributeType.STRING },
  projectionType: ProjectionType.ALL,
});

// Optional — for admin plugin:
sessions.addGlobalSecondaryIndex({
  indexName: "by-id",
  partitionKey: { name: "id", type: AttributeType.STRING },
  projectionType: ProjectionType.KEYS_ONLY,
});
```
</details>

### Accounts

| Attribute | Type | Key |
|---|---|---|
| `providerId` | String | **PK** |
| `accountId` | String | **SK** |
| `id` | String | GSI `by-id` PK |
| `userId` | String | GSI `by-userId` PK |
| `accessToken` | String | |
| `refreshToken` | String | |
| `accessTokenExpiresAt` | String (ISO) | |
| `refreshTokenExpiresAt` | String (ISO) | |
| `scope` | String | |
| `idToken` | String | |
| `password` | String | |
| `createdAt` | String (ISO) | |
| `updatedAt` | String (ISO) | |

**Why composite PK `(providerId, accountId)`?** Better Auth's SQL schemas enforce `UNIQUE(providerId, accountId)`. DynamoDB has no unique constraints on non-key attributes. Encoding `(providerId, accountId)` as the PK prevents duplicate OAuth identities at the database level — a conditional `PutItem` against this PK fails on duplicates.

<details>
<summary><strong>CloudFormation</strong></summary>

```yaml
AccountsTable:
  Type: AWS::DynamoDB::Table
  Properties:
    TableName: myapp-accounts
    BillingMode: PAY_PER_REQUEST
    AttributeDefinitions:
      - AttributeName: providerId
        AttributeType: S
      - AttributeName: accountId
        AttributeType: S
      - AttributeName: id
        AttributeType: S
      - AttributeName: userId
        AttributeType: S
    KeySchema:
      - AttributeName: providerId
        KeyType: HASH
      - AttributeName: accountId
        KeyType: RANGE
    GlobalSecondaryIndexes:
      - IndexName: by-id
        KeySchema:
          - AttributeName: id
            KeyType: HASH
        Projection:
          ProjectionType: KEYS_ONLY
      - IndexName: by-userId
        KeySchema:
          - AttributeName: userId
            KeyType: HASH
        Projection:
          ProjectionType: ALL
```
</details>

<details>
<summary><strong>AWS CDK (TypeScript)</strong></summary>

```ts
const accounts = new Table(this, "Accounts", {
  tableName: "myapp-accounts",
  partitionKey: { name: "providerId", type: AttributeType.STRING },
  sortKey: { name: "accountId", type: AttributeType.STRING },
  billingMode: BillingMode.PAY_PER_REQUEST,
});

accounts.addGlobalSecondaryIndex({
  indexName: "by-id",
  partitionKey: { name: "id", type: AttributeType.STRING },
  projectionType: ProjectionType.KEYS_ONLY,
});

accounts.addGlobalSecondaryIndex({
  indexName: "by-userId",
  partitionKey: { name: "userId", type: AttributeType.STRING },
  projectionType: ProjectionType.ALL,
});
```
</details>

### Verifications

| Attribute | Type | Key |
|---|---|---|
| `id` | String | **PK** |
| `identifier` | String | GSI `identifier-index` PK |
| `value` | String | |
| `expiresAt` | String (ISO) | TTL |
| `createdAt` | String (ISO) | |
| `updatedAt` | String (ISO) | |

<details>
<summary><strong>CloudFormation</strong></summary>

```yaml
VerificationsTable:
  Type: AWS::DynamoDB::Table
  Properties:
    TableName: myapp-verifications
    BillingMode: PAY_PER_REQUEST
    AttributeDefinitions:
      - AttributeName: id
        AttributeType: S
      - AttributeName: identifier
        AttributeType: S
    KeySchema:
      - AttributeName: id
        KeyType: HASH
    GlobalSecondaryIndexes:
      - IndexName: identifier-index
        KeySchema:
          - AttributeName: identifier
            KeyType: HASH
        Projection:
          ProjectionType: ALL
    TimeToLiveSpecification:
      AttributeName: expiresAt
      Enabled: true
```
</details>

<details>
<summary><strong>AWS CDK (TypeScript)</strong></summary>

```ts
const verifications = new Table(this, "Verifications", {
  tableName: "myapp-verifications",
  partitionKey: { name: "id", type: AttributeType.STRING },
  billingMode: BillingMode.PAY_PER_REQUEST,
  timeToLiveAttribute: "expiresAt",
});

verifications.addGlobalSecondaryIndex({
  indexName: "identifier-index",
  partitionKey: { name: "identifier", type: AttributeType.STRING },
  projectionType: ProjectionType.ALL,
});
```
</details>

### EmailLookups (optional — only with `enableEmailUniqueness`)

| Attribute | Type | Key |
|---|---|---|
| `email` | String | **PK** |
| `userId` | String | |

```yaml
EmailLookupsTable:
  Type: AWS::DynamoDB::Table
  Properties:
    TableName: myapp-email-lookups
    BillingMode: PAY_PER_REQUEST
    AttributeDefinitions:
      - AttributeName: email
        AttributeType: S
    KeySchema:
      - AttributeName: email
        KeyType: HASH
```

---

## Email uniqueness

DynamoDB GSIs are **eventually consistent**. A just-inserted user may not appear in `email-index` for milliseconds, which can allow duplicate emails in concurrent sign-ups.

The adapter solves this with an opt-in sidecar table:

```ts
dynamodbAdapter({
  client,
  tables: {
    user:         "myapp-users",
    session:      "myapp-sessions",
    account:      "myapp-accounts",
    verification: "myapp-verifications",
    emailLookups: "myapp-email-lookups", // ← required
  },
  enableEmailUniqueness: true, // ← opt-in
})
```

When enabled, user `create` wraps in a `TransactWriteItems` containing:

1. `Put` user with `ConditionExpression: "attribute_not_exists(id)"`
2. `Put` email-lookup with `ConditionExpression: "attribute_not_exists(email)"`

`EmailLookups` is a base table with `PK = email`, so `ConsistentRead: true` is supported — unlike a GSI. The conditional Put guards against concurrent claims. If either action fails (id collision or email collision), the entire transaction rolls back.

User deletion and email change are handled symmetrically: delete releases the email claim; update transactionally swaps old email-lookup → new email-lookup.

> **Plan ahead:** If you anticipate adding email-based flows later (magic links, password reset, email change), deploy the lookup table from day one. Retrofitting after users exist requires a backfill that races with new sign-ups.

---

## Transactions

Use the `transaction()` API for atomic multi-table writes — for example, creating a user + their first account together:

```ts
import { dynamodbAdapter } from "@ebratz/dynamodb-better-auth";

// Inside a Better Auth flow, the framework calls `adapter.transaction(cb)`
// internally for operations like createOAuthUser. You can also call it manually:

await auth.options.database.transaction(async (tx) => {
  // Primary-key fields must be supplied — transaction is a lower-level
  // primitive than the factory-wrapped methods (no auto id generation).
  const user = await tx.create({
    model: "user",
    data: {
      id: crypto.randomUUID(),
      email: "alice@example.com",
      emailVerified: true,
      name: "Alice",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });

  await tx.create({
    model: "account",
    data: {
      id: crypto.randomUUID(),
      providerId: "google",
      accountId: "google-user-id-12345",
      userId: user.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  });
});
// Both rows committed atomically. If either Put fails (e.g., duplicate
// providerId+accountId), neither is committed.
```

### Transaction limits and behavior

- **Up to 100 actions** per transaction (DynamoDB limit). Auth transactions are typically 2–5 actions.
- **Reads inside the callback are not transactional.** `tx.findOne` / `tx.findMany` see the pre-transaction state.
- **`update` and `consumeOne` eagerly read** the pre-state at buffer time so their return value is honest.
- **Idempotency:** each flush carries a `ClientRequestToken` (UUID) so retried requests within 10 minutes are deduplicated by DynamoDB.

---

## Error handling

The adapter exports typed errors so callers can switch on them:

```ts
import {
  dynamodbAdapter,
  DynamoAdapterError,
  UnsupportedOperatorError,
  UnsupportedOptionError,
  InvalidWhereError,
} from "@ebratz/dynamodb-better-auth";

try {
  await auth.api.signUpEmail({ body: { email: "dup@example.com", password: "x" } });
} catch (err) {
  if (err instanceof DynamoAdapterError) {
    switch (err.code) {
      case "EMAIL_EXISTS":
        return { error: "email_taken" };
      case "CONDITIONAL_CHECK_FAILED":
        return { error: "duplicate" };
      case "TRANSACTION_FAILED":
        // err.message contains parsed CancellationReasons
        console.error("Tx failed:", err.message);
        throw err;
      default:
        throw err;
    }
  }
  throw err;
}
```

### Error codes

| Code | When it's thrown |
|---|---|
| `UNSUPPORTED_OPERATOR` | `ends_with` or `mode: "insensitive"` used in `where` |
| `UNSUPPORTED_OPTION` | `offset > 0` on a Tier-2 GSI Query |
| `INVALID_WHERE` | `consumeOne` called with a non-PK / non-indexed `where` |
| `CONDITIONAL_CHECK_FAILED` | Conditional write failed (e.g., duplicate PK) |
| `TRANSACTION_FAILED` | `TransactWriteItems` cancelled — `err.message` parses `CancellationReasons` |
| `EMAIL_EXISTS` | `enableEmailUniqueness` blocked a duplicate-email sign-up |
| `MISSING_INDEX` | Configured GSI doesn't exist in the live table |

---

## Configuration reference

### `DynamoDBAdapterConfig`

| Field | Type | Default | Description |
|---|---|---|---|
| `client` | `DynamoDBClient \| DynamoDBDocumentClient` | *required* | AWS SDK client. Adapter wraps raw `DynamoDBClient` with correct marshall options. |
| `tables` | `{ user, session, account, verification } & Record<string,string>` | *required* | Table name mapping. Plugin models can be added freely. |
| `tables.emailLookups` | `string` | — | Required when `enableEmailUniqueness: true` |
| `indexes` | `Record<string, Record<string, GsiDeclaration>>` | `{}` | GSI declarations — controls Tier-2 vs Tier-3 routing |
| `keySchemas` | `Record<string, KeySchemaOverride>` | `{}` | Override default PK/SK per model (plugin models default to `id`; built-in `rateLimit` defaults to `key` — create its table with PK `key` when using `rateLimit.storage: "database"`) |
| `enableEmailUniqueness` | `boolean` | `false` | Atomic email-claim enforcement via sidecar table |
| `warnOnLargeCount` | `number` | `10000` | Emit `debugLogs` warning when `count()` scans more than this many items |
| `unsafeBatchUpdate` | `boolean` | `false` | Use `BatchWriteItem`+`PutItem` in `updateMany` (faster, full-item LWW) |
| `updateManyConcurrency` | `number` | `10` | Max parallel `UpdateItem` calls in `updateMany` |
| `usePlural` | `boolean` | `false` | Forwarded to Better Auth's adapter factory |
| `debugLogs` | `boolean \| Record<string, boolean>` | `false` | Per-operation debug logging |

### `GsiDeclaration`

| Field | Type | Description |
|---|---|---|
| `indexName` | `string` | Live GSI name in DynamoDB |
| `hashKey` | `string` | GSI partition key attribute |
| `rangeKey` | `string` | GSI sort key attribute (optional) |
| `projection` | `"ALL" \| "KEYS_ONLY" \| { include: string[] }` | GSI projection type — affects whether a follow-up `GetItem` is needed |

### `KeySchemaOverride`

| Field | Type | Description |
|---|---|---|
| `pkField` | `string` | Name of the partition key attribute |
| `skField` | `string` | Name of the sort key attribute (optional) |

### Importing types

```ts
import type {
  DynamoDBAdapterConfig,
  GsiDeclaration,
  KeySchemaOverride,
} from "@ebratz/dynamodb-better-auth";
```

---

## Plugin models

Better Auth plugins (organization, 2FA, API keys, passkeys) add models. The adapter supports them via the extensible `tables`, `indexes`, and `keySchemas`:

```ts
dynamodbAdapter({
  client,
  tables: {
    user:         "myapp-users",
    session:      "myapp-sessions",
    account:      "myapp-accounts",
    verification: "myapp-verifications",
    organization: "myapp-organizations",
    member:       "myapp-members",
    invitation:   "myapp-invitations",
  },
  indexes: {
    organization: {
      slug: { indexName: "slug-index", hashKey: "slug" },
    },
    member: {
      userId: { indexName: "userId-index", hashKey: "userId" },
    },
  },
  // Plugin models default to PK=id. Override when needed:
  keySchemas: {
    member: { pkField: "organizationId", skField: "userId" },
  },
})
```

You create the DynamoDB tables for plugin models the same way as the core ones; the adapter does not auto-create or migrate tables.

---

## Plugin Schemas

This section documents the specific DynamoDB table and GSI requirements for popular Better Auth plugins.

### Admin plugin

Better Auth's admin plugin adds a `listSessions` endpoint that queries sessions by `id`. The `session` table already supports this if the optional `by-id` GSI is deployed (see the [Sessions table setup](#sessions)).

**Required GSIs:**

| Model | GSI | Hash Key | Projection |
|---|---|---|---|
| `session` | `by-id` | `id` | `ALL` |

**Config snippet:**

```ts
indexes: {
  session: {
    byId: { indexName: "by-id", hashKey: "id", projection: "ALL" },
  },
}
```

No additional tables beyond the core set. No `keySchemas` override needed (`session` already has PK=`token`).

### Organization plugin

The organization plugin introduces three new models: `organization`, `member`, and `invitation`.

**Required tables:**

| Model | PK | SK | Notes |
|---|---|---|---|
| `organization` | `id` | — | |
| `member` | `id` | — | Needs GSI for lookup by `organizationId` |
| `invitation` | `id` | — | Needs GSI for lookup by `organizationId` |

**Config snippet:**

```ts
import { dynamodbAdapter } from "@ebratz/dynamodb-better-auth";

dynamodbAdapter({
  client,
  tables: {
    user:         "myapp-users",
    session:      "myapp-sessions",
    account:      "myapp-accounts",
    verification: "myapp-verifications",
    // Organization plugin tables
    organization: "myapp-organizations",
    member:       "myapp-members",
    invitation:   "myapp-invitations",
  },
  indexes: {
    organization: {
      slug: { indexName: "slug-index", hashKey: "slug" },
    },
    member: {
      organizationId: { indexName: "orgId-index", hashKey: "organizationId", projection: "ALL" },
      userId:         { indexName: "userId-index", hashKey: "userId", projection: "ALL" },
    },
    invitation: {
      organizationId: { indexName: "orgId-index", hashKey: "organizationId", projection: "ALL" },
    },
  },
  keySchemas: {
    // Use composite (organizationId, userId) to enforce unique membership
    member: { pkField: "organizationId", skField: "userId" },
  },
})
```

**CloudFormation snippet (Organization table):**

```yaml
OrganizationTable:
  Type: AWS::DynamoDB::Table
  Properties:
    TableName: myapp-organizations
    BillingMode: PAY_PER_REQUEST
    AttributeDefinitions:
      - AttributeName: id
        AttributeType: S
      - AttributeName: slug
        AttributeType: S
    KeySchema:
      - AttributeName: id
        KeyType: HASH
    GlobalSecondaryIndexes:
      - IndexName: slug-index
        KeySchema:
          - AttributeName: slug
            KeyType: HASH
        Projection:
          ProjectionType: ALL
```

**CloudFormation snippet (Member table):**

```yaml
MemberTable:
  Type: AWS::DynamoDB::Table
  Properties:
    TableName: myapp-members
    BillingMode: PAY_PER_REQUEST
    AttributeDefinitions:
      - AttributeName: organizationId
        AttributeType: S
      - AttributeName: userId
        AttributeType: S
    KeySchema:
      - AttributeName: organizationId
        KeyType: HASH
      - AttributeName: userId
        KeyType: RANGE
    GlobalSecondaryIndexes:
      - IndexName: orgId-index
        KeySchema:
          - AttributeName: organizationId
            KeyType: HASH
        Projection:
          ProjectionType: ALL
      - IndexName: userId-index
        KeySchema:
          - AttributeName: userId
            KeyType: HASH
        Projection:
          ProjectionType: ALL
```

**CloudFormation snippet (Invitation table):**

```yaml
InvitationTable:
  Type: AWS::DynamoDB::Table
  Properties:
    TableName: myapp-invitations
    BillingMode: PAY_PER_REQUEST
    AttributeDefinitions:
      - AttributeName: id
        AttributeType: S
      - AttributeName: organizationId
        AttributeType: S
    KeySchema:
      - AttributeName: id
        KeyType: HASH
    GlobalSecondaryIndexes:
      - IndexName: orgId-index
        KeySchema:
          - AttributeName: organizationId
            KeyType: HASH
        Projection:
          ProjectionType: ALL
```

### Username plugin

The username plugin adds a `username` field to users and queries by username during sign-in. Add a GSI on `user.username` to avoid a full Scan on every login.

**Required GSIs:**

| Model | GSI | Hash Key | Projection |
|---|---|---|---|
| `user` | `username-index` | `username` | `ALL` |

**Config snippet:**

```ts
indexes: {
  user: {
    username: { indexName: "username-index", hashKey: "username", projection: "ALL" },
  },
}
```

No additional tables. The `user` table's existing `id` PK is sufficient.

### Passkey plugin

The passkey plugin adds a `passkey` table with PK=`id`. No additional GSIs are required — the standard PK lookups cover all passkey operations (registration, authentication, listing by user's credential ID).

**Required tables:**

| Model | PK | Notes |
|---|---|---|
| `passkey` | `id` | Standard PK-only table |

**Config snippet:**

```ts
tables: {
  user:    "myapp-users",
  session: "myapp-sessions",
  account: "myapp-accounts",
  verification: "myapp-verifications",
  passkey: "myapp-passkeys",
}
```

No `indexes` or `keySchemas` override needed.

### Two-factor plugin

The two-factor plugin adds a `twoFactor` table with PK=`id`. No additional GSIs are required.

**Required tables:**

| Model | PK | Notes |
|---|---|---|
| `twoFactor` | `id` | Standard PK-only table |

**Config snippet:**

```ts
tables: {
  user:    "myapp-users",
  session: "myapp-sessions",
  account: "myapp-accounts",
  verification: "myapp-verifications",
  twoFactor: "myapp-two-factor",
}
```

No `indexes` or `keySchemas` override needed.

---

## IAM policy

Minimal IAM policy for the adapter:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query",
        "dynamodb:Scan",
        "dynamodb:BatchWriteItem",
        "dynamodb:BatchGetItem",
        "dynamodb:TransactWriteItems",
        "dynamodb:TransactGetItems"
      ],
      "Resource": [
        "arn:aws:dynamodb:*:*:table/myapp-users",
        "arn:aws:dynamodb:*:*:table/myapp-users/index/*",
        "arn:aws:dynamodb:*:*:table/myapp-sessions",
        "arn:aws:dynamodb:*:*:table/myapp-sessions/index/*",
        "arn:aws:dynamodb:*:*:table/myapp-accounts",
        "arn:aws:dynamodb:*:*:table/myapp-accounts/index/*",
        "arn:aws:dynamodb:*:*:table/myapp-verifications",
        "arn:aws:dynamodb:*:*:table/myapp-verifications/index/*"
      ]
    }
  ]
}
```

Tighten further by removing `Scan` once GSIs cover every access pattern (the adapter warns when Tier 3 is reached).

---

## Operational recommendations

### Enable DynamoDB TTL

Configure TTL on `sessions.expiresAt` and `verifications.expiresAt` to auto-clean expired data (free, async, typically within 48 hours). This is a **backup** mechanism — the adapter always checks `expiresAt` explicitly; never rely on TTL for correctness.

### Use on-demand capacity mode

Auth traffic is spiky (login bursts, OAuth callback storms). On-demand (`BillingMode: PAY_PER_REQUEST`) eliminates throttling risk and capacity planning. Switch to provisioned with auto-scaling later if you have predictable load.

### Reuse the DynamoDBClient (Lambda / serverless)

Create the client once at module scope so the SDK's HTTP keep-alive connections survive across invocations:

```ts
// ✅ Module scope — reused across warm invocations
const client = new DynamoDBClient({});

export const handler = async (event) => {
  const auth = betterAuth({
    database: dynamodbAdapter({ client, tables: { /* ... */ } }),
  });
  // ...
};
```

### Cost intuition

With cookie cache enabled (5 min `maxAge`):
- ~1 `GetItem` per session per 5 minutes per user — not per request
- ~1 `PutItem` per sign-up
- ~1 `Query` per user listing (admin paths)

On-demand pricing is roughly $1.25 per million reads and $1.25 per million writes; a moderately-trafficked auth tier costs cents per month.

---

## Limitations & Edge Cases

### Supported operators

When converting a `where` clause, the following operators map to DynamoDB expressions:

| Operator | DynamoDB expression |
|---|---|
| `eq` | `#field = :val` |
| `ne` | `#field <> :val` |
| `gt` | `#field > :val` |
| `gte` | `#field >= :val` |
| `lt` | `#field < :val` |
| `lte` | `#field <= :val` |
| `in` | `#field IN (:v0, …)` (auto-chunked at 100) |
| `not_in` | `NOT (#field IN (:v0, …))` |
| `contains` | `contains(#field, :val)` |
| `starts_with` | `begins_with(#field, :prefix)` |
| `between` | `#field BETWEEN :lo AND :hi` |

### Unsupported operators

| Operator | Behavior |
|---|---|
| `ends_with` | Throws `UnsupportedOperatorError`. Workaround: store reversed string in a GSI + use `begins_with`, or filter client-side. |
| `mode: "insensitive"` | Throws `UnsupportedOperatorError`. Workaround: store a lowercase copy (`emailLower`) and query against it. |

### Offset on GSI Queries (Tier 2)

DynamoDB has no `OFFSET` concept. When querying via a GSI with `offset > 0`, the adapter throws `UnsupportedOptionError`. Use cursor-based pagination via `ExclusiveStartKey` instead. Scan-based queries (Tier 3) support offset via client-side discard (logged as a warning).

### GSI eventual consistency

All DynamoDB GSIs are eventually consistent (typically <1s but unbounded). After creating a user, an immediate `findOne({ email })` via `email-index` may return null for milliseconds. Use `enableEmailUniqueness` with the `EmailLookups` sidecar for strong consistency on the email field.

### Tier-3 sort + limit reads all items

When a Scan (Tier 3) is combined with `sortBy`, the adapter must fetch **all** matching items, sort client-side, then slice to `limit` — DynamoDB's native `Limit` would otherwise return the wrong N items. Without `sortBy`, the native `Limit` is applied during the Scan. **Adding the appropriate GSI avoids Tier 3 entirely.**

### `updateMany` is not transactional

Default `updateMany` runs N parallel `UpdateItem` calls — they are not atomic with each other. Partial failure surfaces as an `AggregateError` whose `.errors` lists the per-item failures; successful updates remain committed. Wrap in `transaction()` if all-or-nothing is required.

### `where: []` rejected on deleteMany / consumeOne

To prevent accidental full-table operations, `deleteMany` and `consumeOne` reject an empty `where` array (or `undefined` where) with a `DynamoAdapterError` (`code: "INVALID_WHERE"`). `findMany` and `count` still accept empty where clauses since reads are non-destructive.

### PK/SK fields silently stripped from update payloads

DynamoDB does not allow modifying key attributes via `UpdateItem`. The adapter silently strips the partition key and sort key fields from the `update` data before building the `SET` expression. Attempting to `update({ model: "user", where: …, update: { id: "new-id", name: "Bob" } })` will update only `name` — the `id` change is discarded.

### `findMany` with `limit: 0` short-circuits

Calling `findMany` with `limit: 0` returns an empty array immediately without any DynamoDB call. This is a deliberate optimization — no RCU consumed.

### Item size — no guard in adapter

DynamoDB items are capped at 400 KB. Auth items (user, session, account, verification) are typically < 1 KB. Plugins adding large blob fields may approach the limit. **The adapter does not validate item size** before writing; DynamoDB will reject writes exceeding 400 KB with a `ValidationException`. Applications are responsible for staying under the limit.

### IN clause

The `in` operator supports up to 100 values per clause in DynamoDB. The adapter automatically chunks larger lists into batches of 100 and OR-joins the expressions.

### Transaction limits

`TransactWriteItems` supports up to 100 actions and 4 MB aggregate. Auth transactions typically involve 2–5 items (well within limits).

---

## Migration from SQL Adapters

If you're moving from one of Better Auth's SQL adapters (PostgreSQL, MySQL, SQLite), this section covers the differences that matter.

### 1. Table provisioning

SQL adapters auto-create tables via migrations. **DynamoDB requires explicit table creation** — the adapter never creates or alters tables. Use the CloudFormation or CDK snippets in the [Table setup](#table-setup) section as a starting point. Each core model needs its own table; GSIs must be declared at creation time (though you can add them to existing tables later).

### 2. GSI requirement

In SQL, `findFirst({ where: { email: "alice@example.com" } })` is instant — it's just a b-tree lookup on the indexed column. On DynamoDB, the same query **falls to a full Scan (Tier 3) unless you declare a GSI** for the `email` field:

```ts
// Without this, every email lookup scans the entire Users table.
indexes: {
  user: {
    email: { indexName: "email-index", hashKey: "email" },
  },
}
```

The adapter's query planner will use the GSI automatically — `findOne({ email: "..." })` becomes a Tier-2 `Query` instead of a Tier-3 `Scan`. Check your app for every field queried in a `where` clause and add corresponding GSIs. The adapter's `debugLogs: true` will warn you about paths that hit Tier 3.

### 3. Session PK difference

| Adapter | Session PK | Why |
|---|---|---|
| SQL (default) | `id` | Auto-increment UUID |
| **DynamoDB** | **`token`** | Hot path — every authenticated request validates session by token, not by id |

This is a deliberate design choice for DynamoDB's access-pattern-first model. The session validation hot path (`findOne({ token })`) becomes a single-digit-ms `GetItem` without any GSI. 

> **Enable cookie cache.** Set `session.cookieCache.maxAge` to 5 minutes so session validation reads a signed cookie instead of hitting DynamoDB on every request. This is the single biggest cost and latency lever — see [Performance Tuning](#performance-tuning).

Sessions still have an `id` field, and an optional `by-id` GSI is available for admin panel queries.

### 4. Date handling

DynamoDB stores dates as **ISO 8601 strings** (`"2024-01-01T00:00:00.000Z"`), not native `Date` objects. The adapter handles round-trip serialization automatically:

- **Writes:** `Date` objects in `create` / `update` payloads are converted to ISO strings before marshalling.
- **Reads:** ISO strings in responses are converted back to `Date` objects.

This is transparent in normal operation. Only matters if you read/write DynamoDB items directly (outside the adapter).

### 5. Transaction differences

| Feature | SQL | DynamoDB |
|---|---|---|
| Action limit | Unlimited | **100 per transaction** |
| Read consistency | Read-modify-write inside tx | **Reads are non-transactional** (buffer-then-flush) |
| Aggregate size | Unlimited | 4 MB total |
| Rollback | `ROLLBACK` | Discard buffer on throw |

Auth transactions are typically 2–5 actions, well within the 100-action limit. The main gotcha is that `tx.findOne()` inside a transaction sees the **pre-transaction** state, not intermediate writes.

### Migration checklist

- [ ] Create 4 DynamoDB tables (user, session, account, verification) with GSIs matching your queries
- [ ] Add `emailLookups` table if using `enableEmailUniqueness`
- [ ] Configure cookie cache (`session.cookieCache.maxAge: 5 * 60`)
- [ ] Review all `findFirst` / `findMany` calls — ensure GSIs cover every queried field
- [ ] Enable `debugLogs: true` during development to catch Tier-3 Scan paths

---

## Performance Tuning

### Tier warning decoder

When `debugLogs` is enabled, Tier-3 Scan warnings appear in your logs. Here's what each one means and the GSI you need:

| Warning pattern | Problem | Fix |
|---|---|---|
| `findOne on user using Scan` | Querying a user by non-PK field (e.g. `name`, `role`) | Add a GSI for the queried field, or ensure the PK is in the `where` clause |
| `findOne on session using Scan` | Session lookup not using `token` (PK) | Use `findOne({ token })` instead of `findOne({ id })`, or add `by-id` GSI |
| `findMany on user using Scan with sortBy` | Sort by a field with no GSI sort key | Add a GSI with the sort field as `rangeKey` |
| `update on user using Scan` | Update targeting a non-PK / non-GSI field | Add a GSI for the field used in the `where` clause |
| `delete on user using Scan` | Delete targeting a non-PK / non-GSI field | Add a GSI for the field used in the `where` clause |
| `count on user scanned N items` | `count()` with a broad or empty filter | Add a GSI for the filter field, or accept the Scan for infrequent queries |
| `updateMany on user using Scan` | Bulk update targeting a non-indexed field | Add a GSI for the `where` field used in `updateMany` |

### Cookie cache tuning

Better Auth's `session.cookieCache` stores a signed JWT in the session cookie so the adapter can validate it without hitting DynamoDB. The `maxAge` field controls the tradeoff:

```ts
session: {
  cookieCache: { enabled: true, maxAge: 5 * 60 }, // 5 minutes
}
```

| `maxAge` | GetItem calls (per user per period) | Session invalidation delay | Best for |
|---|---|---|---|
| `30` (30s) | ~2/min | Near-instant | High-security apps |
| `300` (5m) | ~0.2/min | Up to 5 min | **Default — recommended for most apps** |
| `900` (15m) | ~0.07/min | Up to 15 min | Low-security, read-heavy |
| `3600` (1h) | ~0.02/min | Up to 1 hour | Internal tools, dashboards |

> **For sensitive endpoints** (password change, account deletion, email change), set `disableCookieCache: true` on the route to force a DynamoDB read and see the latest session state.

### Cost-per-operation table

DynamoDB on-demand pricing (us-east-1):

| Operation | RCU / WCU | Cost per 1M ops | Notes |
|---|---|---|---|
| `GetItem` (≤4KB) | 0.5 RCU | $0.625 | Single-item PK lookup. Cookie cache eliminates most of these. |
| `Query` (≤4KB) | 0.5 RCU per 4KB scanned | $0.625 | GSI Query — cost scales with items scanned, not returned. |
| `Scan` (≤4KB) | 0.5 RCU per 4KB scanned | $0.625 per 4KB of table | Full table scan — avoid. GSIs prevent this. |
| `Write` (≤1KB) | 1 WCU | $1.25 | PutItem, UpdateItem, DeleteItem, TransactWriteItems (2 WCU per action in tx) |
| `Transactional write` | 2 WCU per action | $2.50 per 1M actions | TransactWriteItems charges 2x standard writes |

**Estimated monthly cost for 10K DAU** (with cookie cache at 5 min, email uniqueness enabled):

| Operation | Calls/user/day | Total/month | Cost |
|---|---|---|---|
| Session validation (cookie cache hits) | 0 | 0 | $0 |
| Session validation (cache misses, ~1 per 5 min) | ~288 | 86M | ~$54 |
| Sign-up (user create + email lookup) | 0.01 | 3K | <$0.01 |
| Login (session create) | 1 | 300K | ~$0.38 |
| Password reset (verification create + consume) | 0.02 | 6K | <$0.01 |
| **Total** | | | **~$55/month** |

Without cookie cache: 10K DAU × 100 requests/day × 0.5 RCU = 500M GetItem calls = ~$312/month. Cookie cache eliminates over 80% of read costs.

### Concurrency tuning

`updateManyConcurrency` controls how many parallel `UpdateItem` calls run when `updateMany` is called (non-batch mode):

```ts
dynamodbAdapter({
  updateManyConcurrency: 10, // default
})
```

| Value | Throughput | Safety | When to use |
|---|---|---|---|
| `5` | Low | Safest — low DDB table capacity | Low-capacity tables, on-demand-burst-limited |
| `10` | Medium | **Default — balanced for most workloads** | General purpose |
| `25` | High | Higher burst consumption | Batch jobs, high-capacity provisioned tables |
| `50` | Very high | Risk of throttling | Internal tools, cron jobs with no concurrent user traffic |

Higher values saturate the table's capacity faster. On on-demand mode, DynamoDB can double capacity once per 30 minutes — large `updateMany` calls may hit throttling if they exceed the doubled limit. For bulk operations on large datasets (>1000 items), use `unsafeBatchUpdate: true` with `BatchWriteItem` instead, which batches writes into 25-item chunks with automatic retry.

---

## Troubleshooting

### `ValidationException: One of the required keys was not given a value`

You're calling `tx.create()` inside `transaction()` without supplying the PK field (e.g., `id` for `user`, `token` for `session`). Transaction is a lower-level primitive than the factory-wrapped methods — it doesn't run Better Auth's id generator. Supply primary-key fields explicitly:

```ts
await tx.create({ model: "user", data: { id: crypto.randomUUID(), ... } });
```

### `ValidationException: Pass options.removeUndefinedValues=true ...`

You're passing a pre-constructed `DynamoDBDocumentClient` that doesn't have `removeUndefinedValues: true`. Either pass the raw `DynamoDBClient` (the adapter wraps it correctly) or construct the DocumentClient with:

```ts
DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});
```

### Scan warnings in logs

When `debugLogs` is enabled and the query planner falls to Tier 3, you'll see:

```
[dynamodb-adapter] findOne on user using Scan (Tier 3). Consider adding a GSI for "name".
```

This means a `where` clause couldn't be served by the PK or any declared GSI. Add the missing GSI to your DynamoDB table and to the adapter's `indexes` config.

### `EMAIL_EXISTS` on legitimate sign-ups

If you enabled `enableEmailUniqueness: true` after users were already created, the lookup table is missing entries for existing users. Run a one-time backfill that reads all users and inserts corresponding rows into `EmailLookups`.

### CI integration tests fail locally

Integration tests require DynamoDB Local. Start it with:

```bash
docker compose up -d
npm run test:integration
```

If port 8001 is already in use, set `DYNAMODB_ENDPOINT=http://localhost:<port>` before running.

### TypeScript can't find `@ebratz/dynamodb-better-auth/types`

Use the default export instead — types are re-exported from the package root:

```ts
import type { DynamoDBAdapterConfig } from "@ebratz/dynamodb-better-auth";
```

The `/types` subpath exists but is rarely needed.

---

## Development

```bash
# Install dependencies
npm install

# Type-check
npm run typecheck

# Run unit tests
npm run test:unit

# Run integration tests (requires DynamoDB Local)
docker compose up -d
npm run test:integration

# Coverage
npm run test:coverage

# Build
npm run build
```

### Project layout

```
src/
├── adapter/
│   ├── client.ts         # DynamoDBDocumentClient wrapper
│   ├── factory.ts        # Adapter factory wiring
│   ├── methods/          # Per-method implementations (create, findOne, ...)
│   └── transaction.ts    # Hybrid-buffer transaction wrapper
├── helpers/
│   ├── expression-names.ts  # Safe #n placeholder builder
│   ├── key-builder.ts       # PK/SK schema registry
│   ├── query-planner.ts     # Three-tier query routing
│   └── where-converter.ts   # Where → DynamoDB expression
├── email-uniqueness.ts   # Sidecar table logic
├── errors.ts             # Exported error classes
├── index.ts              # Public API
└── types.ts              # Public + internal types

test/
├── adapter.test.ts       # Integration suite (DynamoDB Local)
├── setup.ts              # Table creation for integration tests
└── *.test.ts             # Per-unit unit tests
```

---

## Contributing

PRs welcome. Please:

1. Open an issue first for non-trivial changes — saves both of us time.
2. **Use Conventional Commits in your PR title.** The release bot reads it to decide the version bump:
   - `feat: add organization model support` → minor bump
   - `fix: ConsumeOne returning null` → patch bump
   - `feat!: drop Node 18 support` → major bump
   - `chore:`, `ci:`, `docs:`, `test:`, `refactor:`, `style:`, `build:`, `perf:` → no version bump
3. Add tests for new behavior; coverage thresholds are enforced (`statements ≥ 85`, `branches ≥ 75`, `functions ≥ 80`).
4. Keep the existing strict TypeScript settings; no `any` in production code without justification.
5. The integration test suite must pass against DynamoDB Local (`docker compose up -d && npm run test:integration`).
6. You do **not** need to update `CHANGELOG.md` — it's generated automatically from commit messages.

---

## Releases

Releases are fully automated by [release-please](https://github.com/googleapis/release-please-action). The flow:

```
PR opened ──► CI runs (typecheck, unit, integration, pack-smoke)
              │
              ├─ PR title validator checks Conventional Commits format
              │
              └─► All green required before merge (branch protection)
                  │
                  ▼
                Merge to main
                  │
                  ▼
                release-please bot opens/updates a "Release PR" with:
                  • bumped version in package.json
                  • new CHANGELOG.md entries derived from commits
                  │
                  ▼
                Merge the Release PR
                  │
                  ▼
                Tag v0.x.y created automatically
                  │
                  ▼
                npm publish --provenance runs in CI
                  │
                  ▼
                Package live on npmjs.com 🎉
```

### For maintainers

To cut a release: merge the open Release PR. That's it.

To skip a release for a batch of changes that don't warrant publishing: keep merging commits with non-release types (`chore:`, `docs:`, `test:`, `ci:`, `build:`, `refactor:`, `style:`). The Release PR won't appear or won't update until a `feat:` or `fix:` lands.

To force a specific version, edit the Release PR's `package.json` and `CHANGELOG.md` before merging — release-please respects your edits.

To roll back: the published `0.x.y` cannot be removed from npm (only deprecated). Use `npm deprecate @ebratz/dynamodb-better-auth@0.x.y "reason"` and publish a fixed `0.x.(y+1)`.

---

## License

[MIT](./LICENSE) © Eduardo Bratz
