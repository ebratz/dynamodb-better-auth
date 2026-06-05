# Examples

Companion apps that demonstrate the DynamoDB adapter for Better Auth in a
runnable environment.

## Quick start

Each example uses [DynamoDB Local](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.html)
via Docker Compose — no AWS account needed.

### Express

```bash
cd examples/express
npm install
npm run docker:up    # starts DynamoDB Local on :8000
npm run setup        # creates the 6 tables + GSIs
npm run dev          # starts the server on :3000
```

Open http://localhost:3000 — the `/api/auth/*` routes are handled by Better Auth.

### Next.js

```bash
cd examples/nextjs
npm install
npm run docker:up    # starts DynamoDB Local
npm run setup        # creates tables
npm run dev          # starts Next.js dev server on :3000
```

## Table layout

Both examples use the same `myapp-*` table prefix:

| Table | PK | SK | GSIs |
|---|---|---|---|
| `myapp-users` | `id` | — | `email-index` (email) |
| `myapp-sessions` | `token` | — | `userId-index`, `by-id` (KEYS_ONLY) |
| `myapp-accounts` | `providerId` | `accountId` | `by-id` (KEYS_ONLY), `by-userId` |
| `myapp-verifications` | `id` | — | `identifier-index` |
| `myapp-email-lookups` | `email` | — | — |

## Tear down

```bash
npm run docker:down
```
