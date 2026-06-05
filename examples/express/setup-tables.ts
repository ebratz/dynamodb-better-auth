/**
 * Create DynamoDB Local tables for the Express example.
 *
 * Run with: npx tsx setup-tables.ts
 */

import {
  DynamoDBClient,
  CreateTableCommand,
} from "@aws-sdk/client-dynamodb";

const client = new DynamoDBClient({
  endpoint: "http://localhost:8000",
  region: "us-east-1",
  credentials: { accessKeyId: "fake", secretAccessKey: "fake" },
});

async function createTable(params: Record<string, any>) {
  try {
    await client.send(new CreateTableCommand(params as any));
    console.log(`  ✓ ${params.TableName}`);
  } catch (err: any) {
    if (err.name === "ResourceInUseException") {
      console.log(`  - ${params.TableName} (already exists)`);
    } else {
      throw err;
    }
  }
}

async function main() {
  console.log("Creating DynamoDB Local tables for Express example...\n");

  // Users — PK=id, GSI by email
  await createTable({
    TableName: "myapp-users",
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
    BillingMode: "PAY_PER_REQUEST",
  });

  // Sessions — PK=token, GSI by userId + by-id
  await createTable({
    TableName: "myapp-sessions",
    AttributeDefinitions: [
      { AttributeName: "token", AttributeType: "S" },
      { AttributeName: "userId", AttributeType: "S" },
      { AttributeName: "id", AttributeType: "S" },
    ],
    KeySchema: [{ AttributeName: "token", KeyType: "HASH" }],
    GlobalSecondaryIndexes: [
      {
        IndexName: "userId-index",
        KeySchema: [{ AttributeName: "userId", KeyType: "HASH" }],
        Projection: { ProjectionType: "ALL" },
      },
      {
        IndexName: "by-id",
        KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
        Projection: { ProjectionType: "KEYS_ONLY" },
      },
    ],
    BillingMode: "PAY_PER_REQUEST",
  });

  // Accounts — PK=providerId, SK=accountId, GSI by-id + by-userId
  await createTable({
    TableName: "myapp-accounts",
    AttributeDefinitions: [
      { AttributeName: "providerId", AttributeType: "S" },
      { AttributeName: "accountId", AttributeType: "S" },
      { AttributeName: "id", AttributeType: "S" },
      { AttributeName: "userId", AttributeType: "S" },
    ],
    KeySchema: [
      { AttributeName: "providerId", KeyType: "HASH" },
      { AttributeName: "accountId", KeyType: "RANGE" },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: "by-id",
        KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
        Projection: { ProjectionType: "KEYS_ONLY" },
      },
      {
        IndexName: "by-userId",
        KeySchema: [{ AttributeName: "userId", KeyType: "HASH" }],
        Projection: { ProjectionType: "ALL" },
      },
    ],
    BillingMode: "PAY_PER_REQUEST",
  });

  // Verifications — PK=id, GSI by identifier
  await createTable({
    TableName: "myapp-verifications",
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
    BillingMode: "PAY_PER_REQUEST",
  });

  // EmailLookups — PK=email (for email-uniqueness sidecar)
  await createTable({
    TableName: "myapp-email-lookups",
    AttributeDefinitions: [
      { AttributeName: "email", AttributeType: "S" },
    ],
    KeySchema: [{ AttributeName: "email", KeyType: "HASH" }],
    BillingMode: "PAY_PER_REQUEST",
  });

  console.log("\nAll tables ready.\n");
}

main().catch((err) => {
  console.error("Failed to create tables:", err);
  process.exit(1);
});
