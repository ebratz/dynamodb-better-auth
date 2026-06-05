# DynamoDB + Better Auth — Next.js Example

Minimal Next.js 15 app demonstrating **@ebratz/dynamodb-better-auth**
with Better Auth.

## Quick start

```bash
# 1. Start DynamoDB Local
docker compose up -d

# 2. Create tables + GSIs
npm run setup

# 3. Start the dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Enter any email + password
(8+ chars). On first visit, your account is created and you're signed in.
Return visits sign you in with the same credentials.

## Architecture

```
examples/nextjs/
├── auth.ts              # better-auth + DynamoDB adapter config
├── setup-tables.ts      # Creates 4 tables + GSIs in DynamoDB Local
├── docker-compose.yml   # DynamoDB Local on port 8000
└── src/
    ├── auth-client.ts   # Shared client for useSession/signIn hooks
    └── app/
        ├── layout.tsx
        ├── page.tsx     # Sign-in form + session display
        └── api/auth/[...all]/route.ts  # Better Auth API handler
```

### Tables created

| Table | PK | GSIs |
|---|---|---|
| `example-users` | `id` | `email-index` (email) |
| `example-sessions` | `token` | `userId-index` (userId) |
| `example-accounts` | `providerId` + `accountId` (composite) | `by-userId`, `by-id` |
| `example-verifications` | `id` | `identifier-index` (identifier) |

### Production deployment

Replace the DynamoDB client config in `auth.ts`:

```ts
client: new DynamoDBClient({
  region: "us-east-1",  // your AWS region
  // Remove endpoint + credentials for production —
  // the AWS SDK picks up IAM credentials automatically.
}),
```

Then deploy to Vercel, AWS Lambda, or any Node.js host.

## Notes

- **Email uniqueness** is NOT enabled in this example. See the main
  [README](../../README.md#email-uniqueness) for details on the
  `enableEmailUniqueness` + `EmailLookups` sidecar table.
- **TTL** is configured on sessions and verifications for auto-cleanup.
- The adapter's `debugLogs: true` shows which DynamoDB primitive each
  query resolves to — useful during development.
