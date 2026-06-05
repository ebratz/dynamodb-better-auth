/**
 * Integration test setup — creates all DynamoDB Local tables before tests run.
 */
import { DynamoDBClient, CreateTableCommand } from "@aws-sdk/client-dynamodb";

const ENDPOINT = process.env.DYNAMODB_ENDPOINT || "http://localhost:8001";

const client = new DynamoDBClient({
  endpoint: ENDPOINT,
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

export async function setupTables() {
  console.log("Setting up DynamoDB Local tables...\n");

  // Users
  await createTable({
    TableName: "test-users",
    AttributeDefinitions: [
      { AttributeName: "id", AttributeType: "S" },
      { AttributeName: "email", AttributeType: "S" },
    ],
    KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    GlobalSecondaryIndexes: [{
      IndexName: "email-index",
      KeySchema: [{ AttributeName: "email", KeyType: "HASH" }],
      Projection: { ProjectionType: "ALL" },
    }],
    BillingMode: "PAY_PER_REQUEST",
  });

  // Sessions
  await createTable({
    TableName: "test-sessions",
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

  // Accounts
  await createTable({
    TableName: "test-accounts",
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

  // Verifications
  await createTable({
    TableName: "test-verifications",
    AttributeDefinitions: [
      { AttributeName: "id", AttributeType: "S" },
      { AttributeName: "identifier", AttributeType: "S" },
    ],
    KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
    GlobalSecondaryIndexes: [{
      IndexName: "identifier-index",
      KeySchema: [{ AttributeName: "identifier", KeyType: "HASH" }],
      Projection: { ProjectionType: "ALL" },
    }],
    BillingMode: "PAY_PER_REQUEST",
  });

  // EmailLookups
  await createTable({
    TableName: "test-email-lookups",
    AttributeDefinitions: [
      { AttributeName: "email", AttributeType: "S" },
    ],
    KeySchema: [{ AttributeName: "email", KeyType: "HASH" }],
    BillingMode: "PAY_PER_REQUEST",
  });

  // Organization (plugin model test) — custom PK field "orgId"
  await createTable({
    TableName: "test-organizations",
    AttributeDefinitions: [
      { AttributeName: "orgId", AttributeType: "S" },
      { AttributeName: "slug", AttributeType: "S" },
    ],
    KeySchema: [{ AttributeName: "orgId", KeyType: "HASH" }],
    GlobalSecondaryIndexes: [{
      IndexName: "slug-index",
      KeySchema: [{ AttributeName: "slug", KeyType: "HASH" }],
      Projection: { ProjectionType: "ALL" },
    }],
    BillingMode: "PAY_PER_REQUEST",
  });

  console.log("\nAll tables ready.\n");
}
