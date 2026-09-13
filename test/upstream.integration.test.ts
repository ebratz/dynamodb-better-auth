import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { getAuthTables } from "better-auth/db";
import { authFlowTestSuite, normalTestSuite, testAdapter, transactionsTestSuite } from "@better-auth/test-utils/adapter";
import type { BetterAuthOptions } from "better-auth";
import { dynamodbAdapter } from "../src/adapter/factory";
import { getKeySchema } from "../src/helpers/key-builder";
import type { DynamoDBAdapterConfig } from "../src/types";

const client = new DynamoDBClient({
  endpoint: process.env.DYNAMODB_ENDPOINT || "http://localhost:8001",
  region: "us-east-1",
  credentials: { accessKeyId: "fake", secretAccessKey: "fake" },
});
const created = new Set<string>();
function config(options: BetterAuthOptions): DynamoDBAdapterConfig {
  return {
    client,
    tables: Object.fromEntries(Object.keys(getAuthTables(options)).map(model => [model, `upstream-${model}`])),
    indexes: {
      verification: { identifier: { indexName: "by-identifier", hashKey: "identifier" } },
    },
  };
}

const suite = await testAdapter({
  adapter: options => dynamodbAdapter(config(options)),
  runMigrations: async options => {
    const configuration = config(options);
    for (const [model, table] of Object.entries(configuration.tables)) {
      if (created.has(table)) continue;
      const key = getKeySchema(model, configuration);
      const fields = [key.pkField, ...(key.skField ? [key.skField] : [])];
      const verification = model === "verification";
      await client.send(new CreateTableCommand({
        TableName: table,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [...fields, ...(verification ? ["identifier"] : [])].map(AttributeName => ({ AttributeName, AttributeType: "S" })),
        KeySchema: fields.map((AttributeName, index) => ({ AttributeName, KeyType: index === 0 ? "HASH" : "RANGE" })),
        ...(verification ? { GlobalSecondaryIndexes: [{
          IndexName: "by-identifier", KeySchema: [{ AttributeName: "identifier", KeyType: "HASH" }],
          Projection: { ProjectionType: "ALL" },
        }] } : {}),
      }));
      created.add(table);
    }
  },
  tests: [normalTestSuite(), authFlowTestSuite(), transactionsTestSuite()],
  onFinish: async () => {
    for (const TableName of created) await client.send(new DeleteTableCommand({ TableName }));
    client.destroy();
  },
});
suite.execute();
