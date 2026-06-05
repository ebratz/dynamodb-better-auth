/**
 * Better Auth + DynamoDB adapter configuration for the Express example.
 *
 * Points at DynamoDB Local (http://localhost:8000) and uses
 * "myapp-" prefixed table names with email uniqueness enabled.
 */

import { betterAuth } from "better-auth";
import { dynamodbAdapter } from "@ebratz/dynamodb-better-auth";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

const ddbClient = new DynamoDBClient({
  endpoint: "http://localhost:8000",
  region: "us-east-1",
  credentials: { accessKeyId: "fake", secretAccessKey: "fake" },
});

export const auth = betterAuth({
  database: dynamodbAdapter({
    client: ddbClient,
    tables: {
      user: "myapp-users",
      session: "myapp-sessions",
      account: "myapp-accounts",
      verification: "myapp-verifications",
      emailLookups: "myapp-email-lookups",
    },
    enableEmailUniqueness: true,
    indexes: {
      user: {
        email: { indexName: "email-index", hashKey: "email" },
      },
      session: {
        userId: { indexName: "userId-index", hashKey: "userId" },
      },
      account: {
        id: { indexName: "by-id", hashKey: "id", projection: "KEYS_ONLY" },
        userId: { indexName: "by-userId", hashKey: "userId" },
      },
      verification: {
        identifier: {
          indexName: "identifier-index",
          hashKey: "identifier",
        },
      },
    },
    debugLogs: true,
  }),
  session: {
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
  },
});
