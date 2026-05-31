/**
 * Email uniqueness enforcement — per DESIGN.md §9.9 + accepted R4.
 *
 * Uses a sidecar EmailLookups table with PK = email (String) to provide
 * strongly-consistent email uniqueness checks. All operations use
 * TransactWriteItems for atomicity.
 *
 * Exports:
 *   createUserWithEmailUniqueness(docClient, config, data) → Promise<User>
 *   deleteUserWithEmailRelease(docClient, config, user) → Promise<void>
 *   updateUserEmailWithUniqueness(docClient, config, user, oldEmail, newEmail, patch) → Promise<User>
 *   buildEmailUniquenessActions(operation, config, data/opts) → TransactWriteItem[]
 *     (helper for X1 transaction.ts — returns buffer items for email-lookup ops)
 */

import {
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBAdapterConfig } from "./types";
import { DynamoAdapterError } from "./errors";

// ── Public API ──────────────────────────────────────────────────

/**
 * Creates a user with atomic email-uniqueness enforcement.
 * TransactWriteItems: Put user + Put email-lookup.
 * On email collision → DynamoAdapterError("EMAIL_EXISTS").
 */
export async function createUserWithEmailUniqueness(
  docClient: DynamoDBDocumentClient,
  config: DynamoDBAdapterConfig,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const userTable = config.tables.user;
  const emailTable = config.tables.emailLookups;
  if (!userTable || !emailTable) {
    throw new DynamoAdapterError(
      "MISSING_TABLE",
      "enableEmailUniqueness requires tables.user and tables.emailLookups to be configured",
    );
  }

  const email = data.email as string;
  if (!email) {
    throw new DynamoAdapterError(
      "INVALID_DATA",
      "enableEmailUniqueness requires data.email to be set",
    );
  }

  const userId = data.id as string;
  const emailLower = email.toLowerCase();

  const transactItems = [
    {
      Put: {
        TableName: userTable,
        Item: data,
        ConditionExpression: "attribute_not_exists(#pk)",
        ExpressionAttributeNames: { "#pk": "id" },
      },
    },
    {
      Put: {
        TableName: emailTable,
        Item: {
          email: emailLower,
          userId,
        },
        ConditionExpression: "attribute_not_exists(#pk)",
        ExpressionAttributeNames: { "#pk": "email" },
      },
    },
  ];

  try {
    await docClient.send(
      new TransactWriteCommand({
        TransactItems: transactItems,
        ClientRequestToken: generateToken(),
      }),
    );
    return data;
  } catch (err: any) {
    if (err.name === "TransactionCanceledException") {
      const reasons = err.CancellationReasons ?? [];
      // Index 0 = user Put, Index 1 = email-lookup Put
      if (reasons[1]?.Code === "ConditionalCheckFailed") {
        throw new DynamoAdapterError(
          "EMAIL_EXISTS",
          `Email "${email}" is already registered`,
          err,
        );
      }
      // Index 0 failure (user id collision) is a UUID collision — rethrow as general error
      throw new DynamoAdapterError(
        "CONDITIONAL_CHECK_FAILED",
        `User creation failed: ${JSON.stringify(reasons)}`,
        err,
      );
    }
    throw err;
  }
}

/**
 * Atomically deletes a user and releases their email claim.
 */
export async function deleteUserWithEmailRelease(
  docClient: DynamoDBDocumentClient,
  config: DynamoDBAdapterConfig,
  user: Record<string, unknown>,
): Promise<void> {
  const userTable = config.tables.user;
  const emailTable = config.tables.emailLookups;
  if (!userTable || !emailTable) {
    throw new DynamoAdapterError(
      "MISSING_TABLE",
      "enableEmailUniqueness requires tables.user and tables.emailLookups to be configured",
    );
  }

  const userId = user.id as string;
  const email = (user.email as string)?.toLowerCase();

  if (!email) {
    // No email to release — just delete the user
    await docClient.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: userTable,
              Key: { id: userId },
            },
          },
        ],
        ClientRequestToken: generateToken(),
      }),
    );
    return;
  }

  await docClient.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Delete: {
            TableName: userTable,
            Key: { id: userId },
          },
        },
        {
          Delete: {
            TableName: emailTable,
            Key: { email },
          },
        },
      ],
      ClientRequestToken: generateToken(),
    }),
  );
}

/**
 * Atomically updates a user's email: update user, release old email claim,
 * and claim new email. Fails if the new email is already taken.
 */
export async function updateUserEmailWithUniqueness(
  docClient: DynamoDBDocumentClient,
  config: DynamoDBAdapterConfig,
  user: Record<string, unknown>,
  oldEmail: string,
  newEmail: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const userTable = config.tables.user;
  const emailTable = config.tables.emailLookups;
  if (!userTable || !emailTable) {
    throw new DynamoAdapterError(
      "MISSING_TABLE",
      "enableEmailUniqueness requires tables.user and tables.emailLookups to be configured",
    );
  }

  const userId = user.id as string;
  const oldEmailLower = oldEmail.toLowerCase();
  const newEmailLower = newEmail.toLowerCase();

  // Build SET clauses for user update
  const setClauses: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, any> = {};

  let idx = 0;
  for (const [field, value] of Object.entries(patch)) {
    const nk = `#f${idx}`;
    const vk = `:v${idx}`;
    names[nk] = field;
    values[vk] = value;
    setClauses.push(`${nk} = ${vk}`);
    idx++;
  }

  // Also set email in the user row
  const emailNk = `#f${idx}`;
  const emailVk = `:v${idx}`;
  names[emailNk] = "email";
  values[emailVk] = newEmail;
  setClauses.push(`${emailNk} = ${emailVk}`);

  const updateExpression = `SET ${setClauses.join(", ")}`;

  const transactItems = [
    {
      Update: {
        TableName: userTable,
        Key: { id: userId },
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: { ...names, "#pk": "id" },
        ExpressionAttributeValues: values,
        ConditionExpression: "attribute_exists(#pk)",
      },
    },
    {
      Delete: {
        TableName: emailTable,
        Key: { email: oldEmailLower },
      },
    },
    {
      Put: {
        TableName: emailTable,
        Item: {
          email: newEmailLower,
          userId,
        },
        ConditionExpression: "attribute_not_exists(#pk)",
        ExpressionAttributeNames: { "#pk": "email" },
      },
    },
  ];

  try {
    await docClient.send(
      new TransactWriteCommand({
        TransactItems: transactItems,
        ClientRequestToken: generateToken(),
      }),
    );

    // Return the merged result (user fields + patch + new email)
    return { ...user, ...patch, email: newEmail };
  } catch (err: any) {
    if (err.name === "TransactionCanceledException") {
      const reasons = err.CancellationReasons ?? [];
      // Index 2 = new email-lookup Put
      if (reasons[2]?.Code === "ConditionalCheckFailed") {
        throw new DynamoAdapterError(
          "EMAIL_EXISTS",
          `Email "${newEmail}" is already registered`,
          err,
        );
      }
      throw new DynamoAdapterError(
        "TRANSACTION_FAILED",
        `Email update failed: ${JSON.stringify(reasons)}`,
        err,
      );
    }
    throw err;
  }
}

// ── Transaction helper (for X1) ─────────────────────────────────

type TransactWriteItem =
  | { Put: { TableName: string; Item: Record<string, unknown>; ConditionExpression?: string; ExpressionAttributeNames?: Record<string, string> } }
  | { Delete: { TableName: string; Key: Record<string, unknown> } }
  | { Update: { TableName: string; Key: Record<string, unknown>; UpdateExpression: string; ExpressionAttributeNames: Record<string, string>; ExpressionAttributeValues: Record<string, unknown>; ConditionExpression?: string } };

/**
 * Builds the email-lookup TransactWriteItems that should be included
 * when a user create/delete/update happens inside a transaction.
 * Used by the transaction wrapper (X1) to include email-uniqueness
 * actions in the outer TransactWriteItems.
 *
 * @param operation - "create" | "delete" | "updateEmail"
 * @param config - adapter config
 * @param opts - operation-specific data
 */
export function buildEmailUniquenessActions(
  operation: "create" | "delete" | "updateEmail",
  config: DynamoDBAdapterConfig,
  opts: {
    data?: Record<string, unknown>;
    user?: Record<string, unknown>;
    oldEmail?: string;
    newEmail?: string;
  },
): TransactWriteItem[] {
  const emailTable = config.tables.emailLookups;
  if (!emailTable) {
    throw new DynamoAdapterError(
      "MISSING_TABLE",
      "enableEmailUniqueness requires tables.emailLookups to be configured",
    );
  }

  switch (operation) {
    case "create": {
      const email = opts.data?.email as string;
      const userId = opts.data?.id as string;
      if (!email || !userId) return [];

      const emailLower = email.toLowerCase();
      return [
        {
          Put: {
            TableName: emailTable,
            Item: { email: emailLower, userId },
            ConditionExpression: "attribute_not_exists(#pk)",
            ExpressionAttributeNames: { "#pk": "email" },
          },
        },
      ];
    }

    case "delete": {
      const email = (opts.user?.email as string)?.toLowerCase();
      if (!email) return [];

      return [
        {
          Delete: {
            TableName: emailTable,
            Key: { email },
          },
        },
      ];
    }

    case "updateEmail": {
      const oldEmailLower = opts.oldEmail?.toLowerCase();
      const newEmailLower = opts.newEmail?.toLowerCase();
      const userId = opts.user?.id as string;

      if (!oldEmailLower || !newEmailLower || !userId) return [];

      return [
        {
          Delete: {
            TableName: emailTable,
            Key: { email: oldEmailLower },
          },
        },
        {
          Put: {
            TableName: emailTable,
            Item: { email: newEmailLower, userId },
            ConditionExpression: "attribute_not_exists(#pk)",
            ExpressionAttributeNames: { "#pk": "email" },
          },
        },
      ];
    }

    default:
      return [];
  }
}

// ── Internal helpers ────────────────────────────────────────────

let _crypto: any;
function generateToken(): string {
  if (!_crypto) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      _crypto = require("crypto");
    } catch {
      _crypto = {
        randomUUID() {
          return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
            /[xy]/g,
            (c) => {
              const r = (Math.random() * 16) | 0;
              const v = c === "x" ? r : (r & 0x3) | 0x8;
              return v.toString(16);
            },
          );
        },
      };
    }
  }
  return _crypto.randomUUID();
}
