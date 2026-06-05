/**
 * Error propagation tests — verify that DynamoDB errors from docClient.send()
 * are propagated correctly (not silently swallowed or mis-classified).
 *
 * Covers: ValidationException, ThrottlingException, ResourceNotFoundException,
 *         InternalServerError, and BatchWrite retry behavior.
 */

import { describe, it, expect, vi } from "vitest";

import { updateMethod } from "../src/adapter/methods/update";
import { createMethod } from "../src/adapter/methods/create";
import { deleteManyMethod } from "../src/adapter/methods/delete-many";
import { findOneMethod } from "../src/adapter/methods/find-one";
import { makeConfig } from "./helpers";

// ── Minimal SDK mock — each test overrides send behavior ────────

vi.mock("@aws-sdk/lib-dynamodb", () => ({
  PutCommand: vi.fn().mockImplementation((input: any) => ({
    ...input,
    _type: "PutCommand",
  })),
  UpdateCommand: vi.fn().mockImplementation((input: any) => ({
    ...input,
    _type: "UpdateCommand",
  })),
  GetCommand: vi.fn().mockImplementation((input: any) => ({
    ...input,
    _type: "GetCommand",
  })),
  QueryCommand: vi.fn().mockImplementation((input: any) => ({
    ...input,
    _type: "QueryCommand",
  })),
  ScanCommand: vi.fn().mockImplementation((input: any) => ({
    ...input,
    _type: "ScanCommand",
  })),
  BatchWriteCommand: vi.fn().mockImplementation((input: any) => ({
    ...input,
    _type: "BatchWriteCommand",
  })),
}));

// ── Helpers ────────────────────────────────────────────────────

function makeError(name: string, message: string): Error {
  const err: any = new Error(message);
  err.name = name;
  return err;
}

function makeDocClient(throwingSend: (cmd: any) => Promise<never>) {
  const send = vi.fn().mockImplementation(throwingSend);
  return { send } as any;
}

function makeDocClientWithResponses(responses: any[]) {
  let callIdx = 0;
  const send = vi.fn().mockImplementation(async (cmd: any) => {
    const resp = responses[callIdx] ?? { Items: [] };
    callIdx++;
    if (resp instanceof Error || (resp && resp.name && resp.message)) {
      throw resp;
    }
    return resp;
  });
  return { send } as any;
}

// ── Tests ──────────────────────────────────────────────────────

describe("error propagation", () => {
  // ── update ──────────────────────────────────────────────────
  describe("update", () => {
    it("propagates non-conditional DynamoDB errors (ValidationException)", async () => {
      const docClient = makeDocClient(async (_cmd: any) => {
        throw makeError("ValidationException", "Invalid UpdateExpression");
      });

      const config = makeConfig();
      const update = updateMethod(docClient, config);

      await expect(
        update({
          model: "user",
          where: [{ field: "id", operator: "eq", value: "u1" }],
          update: { name: "NewName" },
        }),
      ).rejects.toThrow("Invalid UpdateExpression");
    });

    it("catches ConditionalCheckFailedException and returns null (not throw)", async () => {
      const docClient = makeDocClient(async (_cmd: any) => {
        throw makeError("ConditionalCheckFailedException", "The conditional request failed");
      });

      const config = makeConfig();
      const update = updateMethod(docClient, config);

      const result = await update({
        model: "user",
        where: [{ field: "id", operator: "eq", value: "nonexistent" }],
        update: { name: "DoesNotMatter" },
      });

      expect(result).toBeNull();
    });

    it("propagates ThrottlingException", async () => {
      const docClient = makeDocClient(async (_cmd: any) => {
        throw makeError("ThrottlingException", "Rate exceeded");
      });

      const config = makeConfig();
      const update = updateMethod(docClient, config);

      await expect(
        update({
          model: "user",
          where: [{ field: "id", operator: "eq", value: "u1" }],
          update: { name: "NewName" },
        }),
      ).rejects.toThrow("Rate exceeded");
    });
  });

  // ── create ───────────────────────────────────────────────────
  describe("create", () => {
    it("propagates ThrottlingException", async () => {
      const docClient = makeDocClient(async (_cmd: any) => {
        throw makeError("ThrottlingException", "Rate exceeded");
      });

      const config = makeConfig();
      const create = createMethod(docClient, config);

      await expect(
        create({ model: "user", data: { id: "u1", email: "a@b.com" } }),
      ).rejects.toThrow("Rate exceeded");
    });

    it("throws DYNAMO_ADAPTER_ERROR on ConditionalCheckFailedException (not swallow)", async () => {
      const docClient = makeDocClient(async (_cmd: any) => {
        throw makeError("ConditionalCheckFailedException", "The conditional request failed");
      });

      const config = makeConfig();
      const create = createMethod(docClient, config);

      await expect(
        create({ model: "user", data: { id: "u1", email: "a@b.com" } }),
      ).rejects.toThrow(/already exists/);
    });

    it("propagates ResourceNotFoundException", async () => {
      const docClient = makeDocClient(async (_cmd: any) => {
        throw makeError("ResourceNotFoundException", "Table not found");
      });

      const config = makeConfig();
      const create = createMethod(docClient, config);

      await expect(
        create({ model: "user", data: { id: "u1", email: "a@b.com" } }),
      ).rejects.toThrow("Table not found");
    });
  });

  // ── deleteMany ───────────────────────────────────────────────
  describe("deleteMany", () => {
    it("propagates fatal BatchWrite errors", async () => {
      const docClient = makeDocClientWithResponses([
        // Scan returns items (Tier 3)
        {
          Items: [
            { id: "u1", name: "Alice" },
            { id: "u2", name: "Bob" },
          ],
        },
        // BatchWrite throws InternalServerError — fatal, not retryable
        makeError("InternalServerError", "An internal error occurred"),
      ]);

      const config = makeConfig();
      const deleteMany = deleteManyMethod(docClient, config);

      await expect(
        deleteMany({
          model: "user",
          where: [{ field: "name", operator: "starts_with", value: "A" }],
        }),
      ).rejects.toThrow("An internal error occurred");
    });

    it("retries UnprocessedItems but propagates errors on retry", async () => {
      const userItem = { id: "u1", name: "Alice" };
      const docClient = makeDocClientWithResponses([
        // GetItem returns the item (Tier 1: PK equality)
        { Item: userItem },
        // First BatchWrite: 1 unprocessed
        {
          UnprocessedItems: {
            "test-users": [
              { DeleteRequest: { Key: { id: "u1" } } },
            ],
          },
        },
        // Retry BatchWrite throws
        makeError("ThrottlingException", "Rate exceeded on retry"),
      ]);

      const config = makeConfig();
      const deleteMany = deleteManyMethod(docClient, config);

      // retry throws ThrottlingException → propagates (not swallowed)
      await expect(
        deleteMany({
          model: "user",
          where: [{ field: "id", operator: "eq", value: "u1" }],
        }),
      ).rejects.toThrow("Rate exceeded on retry");
    });
  });

  // ── findOne ──────────────────────────────────────────────────
  describe("findOne", () => {
    it("propagates QueryCommand errors from Tier 2", async () => {
      const docClient = makeDocClient(async (cmd: any) => {
        if ((cmd as any)._type === "QueryCommand") {
          throw makeError("ValidationException", "Invalid KeyConditionExpression");
        }
        return {};
      });

      const config = makeConfig({
        indexes: {
          user: {
            email: { indexName: "email-index", hashKey: "email" },
          },
        },
      });
      const findOne = findOneMethod(docClient, config);

      await expect(
        findOne({
          model: "user",
          where: [{ field: "email", operator: "eq", value: "x@y.com" }],
        }),
      ).rejects.toThrow("Invalid KeyConditionExpression");
    });

    it("propagates ScanCommand errors from Tier 3", async () => {
      const docClient = makeDocClient(async (cmd: any) => {
        if ((cmd as any)._type === "ScanCommand") {
          throw makeError("InternalServerError", "Scan failed");
        }
        return {};
      });

      const config = makeConfig();
      const findOne = findOneMethod(docClient, config);

      await expect(
        findOne({
          model: "user",
          where: [{ field: "name", operator: "eq", value: "Nobody" }],
        }),
      ).rejects.toThrow("Scan failed");
    });
  });
});
