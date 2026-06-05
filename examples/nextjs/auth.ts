import { betterAuth } from "better-auth";
import { dynamodbAdapter } from "@ebratz/dynamodb-better-auth";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

export const auth = betterAuth({
  database: dynamodbAdapter({
    client: new DynamoDBClient({
      region: "us-east-1",
      endpoint: process.env.DYNAMODB_ENDPOINT || "http://localhost:8000",
      credentials: {
        accessKeyId: "local",
        secretAccessKey: "local",
      },
    }),
    tables: {
      user: "example-users",
      session: "example-sessions",
      account: "example-accounts",
      verification: "example-verifications",
    },
    indexes: {
      user: {
        email: { indexName: "email-index", hashKey: "email" },
      },
      session: {
        userId: { indexName: "userId-index", hashKey: "userId" },
      },
      account: {
        userId: { indexName: "by-userId", hashKey: "userId", projection: "ALL" },
        id: { indexName: "by-id", hashKey: "id", projection: "KEYS_ONLY" },
      },
      verification: {
        identifier: { indexName: "identifier-index", hashKey: "identifier" },
      },
    },
    debugLogs: true,
  }),
  emailAndPassword: {
    enabled: true,
  },
  session: {
    cookieCache: {
      enabled: true,
      maxAge: 5 * 60, // 5 minutes
    },
  },
});
