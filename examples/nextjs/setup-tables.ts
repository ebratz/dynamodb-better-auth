/**
 * Creates the 4 core DynamoDB tables + GSIs for the example app.
 *
 * Usage: npm run setup
 * Requires DynamoDB Local running on port 8000 (`docker compose up -d`).
 */
import { DynamoDBClient, CreateTableCommand } from "@aws-sdk/client-dynamodb";

const ENDPOINT = process.env.DYNAMODB_ENDPOINT || "http://localhost:8000";

const client = new DynamoDBClient({
  endpoint: ENDPOINT,
  region: "us-east-1",
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
});

async function createTable(params: Record<string, any>) {
  try {
    await client.send(new CreateTableCommand(params as any));
    console.log(`  \u2713 ${params.TableName}`);
  } catch (err: any) {
    if (err.name === "ResourceInUseException") {
      console.log(`  - ${params.TableName} (already exists)`);
    } else {
      console.error(`  \u2717 ${params.TableName}: ${err.message}`);
      throw err;
    }
  }
}

async function main() {
  console.log("Creating DynamoDB tables...\n");

  // ── Users ──────────────────────────────────────────────────
  await createTable({
    TableName: "example-users",
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [
      { AttributeName: "id", AttributeType: "S" },
      { AttributeName: "email", AttributeType: "S" },
    ],
    KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    GlobalSecondaryIndexes: [
      {
        IndexName: "email-index",
        KeySchema: [{ AttributeName: "email", KeyType: "HASH" }],
        Projection: { ProjectionType: "ALL" },
      },
    ],
  });

  // ── Sessions ───────────────────────────────────────────────
  await createTable({
    TableName: "example-sessions",
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [
      { AttributeName: "token", AttributeType: "S" },
      { AttributeName: "userId", AttributeType: "S" },
    ],
    KeySchema: [{ AttributeName: "token", KeyType: "HASH" }],
    GlobalSecondaryIndexes: [
      {
        IndexName: "userId-index",
        KeySchema: [{ AttributeName: "userId", KeyType: "HASH" }],
        Projection: { ProjectionType: "ALL" },
      },
    ],
    TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
  });

  // ── Accounts ───────────────────────────────────────────────
  await createTable({
    TableName: "example-accounts",
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [
      { AttributeName: "providerId", AttributeType: "S" },
      { AttributeName: "accountId", AttributeType: "S" },
      { AttributeName: "userId", AttributeType: "S" },
      { AttributeName: "id", AttributeType: "S" },
    ],
    KeySchema: [
      { AttributeName: "providerId", KeyType: "HASH" },
      { AttributeName: "accountId", KeyType: "RANGE" },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: "by-userId",
        KeySchema: [{ AttributeName: "userId", KeyType: "HASH" }],
        Projection: { ProjectionType: "ALL" },
      },
      {
        IndexName: "by-id",
        KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
        Projection: { ProjectionType: "KEYS_ONLY" },
      },
    ],
  });

  // ── Verifications ──────────────────────────────────────────
  await createTable({
    TableName: "example-verifications",
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [
      { AttributeName: "id", AttributeType: "S" },
      { AttributeName: "identifier", AttributeType: "S" },
    ],
    KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    GlobalSecondaryIndexes: [
      {
        IndexName: "identifier-index",
        KeySchema: [{ AttributeName: "identifier", KeyType: "HASH" }],
        Projection: { ProjectionType: "ALL" },
      },
    ],
    TimeToLiveSpecification: { AttributeName: "expiresAt", Enabled: true },
  });

  console.log("\nAll tables ready.\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
