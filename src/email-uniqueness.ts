/**
 * Email uniqueness enforcement — per DESIGN.md §9.9 + accepted R4.
 *
 * Uses a sidecar EmailLookups table with PK = email (String) to provide
 * strongly-consistent email uniqueness checks. All operations use
 * TransactWriteItems for atomicity.
 *
 * buildEmailUniquenessActions is the single source of truth for email-lookup
 * TransactWriteItems. Standalone functions call it rather than inlining.
 *
 * parseEmailUniquenessError is exported for use by transaction.ts's flush
 * handler — it detects EMAIL_EXISTS collisions in TransactionCanceledException.
 *
 * Exports:
 *   createUserWithEmailUniqueness(docClient, config, data) → Promise<User>
 *   deleteUserWithEmailRelease(docClient, config, user) → Promise<void>
 *   updateUserEmailWithUniqueness(docClient, config, user, oldEmail, newEmail, patch) → Promise<User>
 *   buildEmailUniquenessActions(operation, config, data/opts) → TransactWriteItem[]
 *   parseEmailUniquenessError(err, transactItems, emailTable) → DynamoAdapterError | null
 */

import {
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBAdapterConfig } from "./types";
import { DynamoAdapterError } from "./errors";
import { generateToken } from "./helpers/uuid";
import { buildUpdateExpression } from "./helpers/update-item";

// ── Shared error parser ─────────────────────────────────────────

/**
 * Detects an email uniqueness violation inside a TransactionCanceledException.
 * Checks each cancellation reason against the corresponding transact item:
 * if the item is an email-lookup Put (identified by #pk → "email" or table-name
 * match) and its reason is ConditionalCheckFailed, this is an EMAIL_EXISTS.
 *
 * Returns a DynamoAdapterError("EMAIL_EXISTS", ...) or null.
 */
export function parseEmailUniquenessError(
  err: any,
  transactItems: any[],
  emailTable: string,
): DynamoAdapterError | null {
  if (err.name !== "TransactionCanceledException") return null;

  const reasons = err.CancellationReasons ?? [];

  for (let i = 0; i < reasons.length; i++) {
    if (reasons[i]?.Code === "ConditionalCheckFailed") {
      const item = transactItems[i];
      // Detect email-lookup Put: #pk maps to "email", or the item targets
      // the configured emailLookups table.
      if (
        item?.Put?.ExpressionAttributeNames?.["#pk"] === "email" ||
        item?.Put?.TableName === emailTable
      ) {
        return new DynamoAdapterError(
          "EMAIL_EXISTS",
          "Email is already registered",
          err,
        );
      }
    }
  }

  return null;
}

// ── Public API: Standalone functions ────────────────────────────

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

  // User Put
  const userPut = {
    Put: {
      TableName: userTable,
      Item: data,
      ConditionExpression: "attribute_not_exists(#pk)",
      ExpressionAttributeNames: { "#pk": "id" },
    },
  };

  // Email-lookup via shared builder
  const emailActions = buildEmailUniquenessActions("create", config, { data });
  const transactItems = [userPut, ...emailActions];

  try {
    await docClient.send(
      new TransactWriteCommand({
        TransactItems: transactItems as any,
        ClientRequestToken: generateToken(),
      }),
    );
    return data;
  } catch (err: any) {
    const emailErr = parseEmailUniquenessError(err, transactItems, emailTable);
    if (emailErr) throw emailErr;

    if (err.name === "TransactionCanceledException") {
      throw new DynamoAdapterError(
        "CONDITIONAL_CHECK_FAILED",
        `User creation failed: ${JSON.stringify(err.CancellationReasons ?? [])}`,
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

  // User Delete
  const userDelete = {
    Delete: {
      TableName: userTable,
      Key: { id: user.id as string },
    },
  };

  // Email-lookup via shared builder (returns empty if user has no email)
  const emailActions = buildEmailUniquenessActions("delete", config, { user });
  const transactItems = [userDelete, ...emailActions];

  await docClient.send(
    new TransactWriteCommand({
      TransactItems: transactItems as any,
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

  // Build SET clauses via shared helper (strips PK "id", Date → ISO)
  const { setClauses, attrNames, attrValues } = buildUpdateExpression(
    patch as Record<string, any>,
    "id",
  );

  // Append the email SET clause (buildUpdateExpression strips PK, not email,
  // but email is passed separately as newEmail — ensure it's set explicitly).
  const emailIdx = setClauses.length;
  attrNames[`#n${emailIdx}`] = "email";
  attrValues[`:v${emailIdx}`] = newEmail;
  setClauses.push(`#n${emailIdx} = :v${emailIdx}`);

  // User Update
  const userUpdate = {
    Update: {
      TableName: userTable,
      Key: { id: userId },
      UpdateExpression: `SET ${setClauses.join(", ")}`,
      ExpressionAttributeNames: { ...attrNames, "#pk": "id" },
      ExpressionAttributeValues: attrValues,
      ConditionExpression: "attribute_exists(#pk)",
    },
  };

  // Email-lookup actions via shared builder
  const emailActions = buildEmailUniquenessActions("updateEmail", config, {
    user,
    oldEmail,
    newEmail,
  });
  const transactItems = [userUpdate, ...emailActions];

  try {
    await docClient.send(
      new TransactWriteCommand({
        TransactItems: transactItems as any,
        ClientRequestToken: generateToken(),
      }),
    );

    return { ...user, ...patch, email: newEmail };
  } catch (err: any) {
    const emailErr = parseEmailUniquenessError(err, transactItems, emailTable);
    if (emailErr) throw emailErr;

    if (err.name === "TransactionCanceledException") {
      throw new DynamoAdapterError(
        "TRANSACTION_FAILED",
        `Email update failed: ${JSON.stringify(err.CancellationReasons ?? [])}`,
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
 * Used by both the standalone functions and the transaction wrapper (X1).
 *
 * This is the single source of truth — all callers (standalone + tx handlers)
 * go through this function, not inline email-lookup item construction.
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
