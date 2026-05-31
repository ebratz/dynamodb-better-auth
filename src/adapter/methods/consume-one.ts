/**
 * consumeOne method — per DESIGN.md §5 (consumeOne method) + review-gap fix A.
 *
 * Atomically reads and deletes a single item.
 *
 * - Tier 1: use where clause directly as the key → DeleteCommand with
 *   ReturnValues: "ALL_OLD".
 * - Tier 2: Query the GSI with Limit: 1, extract the PK (+SK if composite),
 *   then DeleteCommand on the resolved key with ReturnValues: "ALL_OLD".
 * - Tier 3: rejected → throw InvalidWhereError (consumeOne requires PK or
 *   indexed equality — Gap A fix).
 *
 * Returns the deleted item's Attributes, or null if no item matched.
 */

import { DeleteCommand, QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBAdapterConfig } from "../../types";
import { getKeySchema } from "../../helpers/key-builder";
import { getTableName } from "../client";
import { InvalidWhereError } from "../../errors";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Where = any;

export function consumeOneMethod(
  docClient: DynamoDBDocumentClient,
  config: DynamoDBAdapterConfig,
) {
  return async (args: {
    model: string;
    where: Where[];
  }): Promise<Record<string, any> | null> => {
    const { model, where } = args;
    const tableName = getTableName(model, config);
    const schema = getKeySchema(model, config);

    // ── Resolve key ───────────────────────────────────────────
    const plan = resolveConsumeOnePlan(where, model, schema, config);

    let key: Record<string, any>;

    if (plan.tier === 1) {
      key = plan.key!;
    } else if (plan.tier === 2) {
      // Tier 2: Query GSI, Limit 1, extract key
      const item = await _queryForKey(docClient, tableName, plan, config, model);
      if (!item) return null;
      key = { [schema.pkField]: item[schema.pkField] };
      if (schema.skField && item[schema.skField] !== undefined) {
        key[schema.skField] = item[schema.skField];
      }
    } else {
      // Tier 3: rejected
      // Check if composite key is missing SK for a clearer error
      if (schema.skField) {
        const pkMatch = where.find(
          (w: Where) => w.field === schema.pkField && (!w.operator || w.operator === "eq"),
        );
        const skMatch = schema.skField
          ? where.find(
              (w: Where) => w.field === schema.skField && (!w.operator || w.operator === "eq"),
            )
          : undefined;
        if (pkMatch && !skMatch) {
          throw new InvalidWhereError(
            `consumeOne requires both PK (${schema.pkField}) and ` +
            `SK (${schema.skField}) for composite-key model "${model}".`,
          );
        }
      }
      throw new InvalidWhereError(
        `consumeOne requires PK equality or indexed field equality (Tier 1 or Tier 2). ` +
        `Got Tier 3 Scan for model "${model}".`,
      );
    }

    // ── Atomic delete with pre-state capture ──────────────────
    const result = await docClient.send(
      new DeleteCommand({
        TableName: tableName,
        Key: key,
        ReturnValues: "ALL_OLD",
      }),
    );

    return (result.Attributes as any) ?? null;
  };
}

// ── Internal helpers ───────────────────────────────────────────

interface ConsumeOnePlan {
  tier: 1 | 2 | 3;
  key?: Record<string, any>;
  indexName?: string;
  keyCondition?: string;
  expressionAttributeNames: Record<string, string>;
  expressionAttributeValues: Record<string, any>;
  needsFollowUpGetItem?: boolean;
  followUpKeyFields?: { pkField: string; skField?: string };
}

function resolveConsumeOnePlan(
  where: Where[],
  model: string,
  schema: { pkField: string; skField?: string },
  config: DynamoDBAdapterConfig,
): ConsumeOnePlan {
  const names: Record<string, string> = {};
  const values: Record<string, any> = {};

  const fieldName = (f: string, i: number) => {
    const nk = `#n${i}`;
    names[nk] = f;
    return nk;
  };
  const valRef = (v: any, i: number) => {
    const vk = `:v${i}`;
    values[vk] = v;
    return vk;
  };

  // Tier 1: PK equality (and optional SK equality for composite)
  const pkEq = where.filter(
    (w: Where) =>
      (!w.operator || w.operator === "eq") &&
      (!w.connector || w.connector !== "OR"),
  );
  const pkMatch = pkEq.find((w: Where) => w.field === schema.pkField);
  const skMatch = schema.skField
    ? pkEq.find((w: Where) => w.field === schema.skField)
    : undefined;

  // For consumeOne, Tier 1 requires that the PK+SK fully identifies the item
  // AND there are no OR-joined clauses that could match other items.
  const ors = where.filter((w: Where) => w.connector === "OR");
  if (pkMatch && (schema.skField ? skMatch : true) && ors.length === 0) {
    const key: Record<string, any> = { [schema.pkField]: pkMatch.value };
    if (schema.skField && skMatch) {
      key[schema.skField] = skMatch.value;
    }
    return {
      tier: 1,
      key,
      expressionAttributeNames: {},
      expressionAttributeValues: {},
    };
  }

  // Tier 2: Check for GSI match (hash key equality, no OR clauses)
  const nonOr = where.filter(
    (w: Where) => !w.connector || w.connector !== "OR",
  );
  const modelIndexes = config.indexes?.[model];

  if (modelIndexes && nonOr.length === 1) {
    const w = nonOr[0]!;
    const gsiDecl = modelIndexes[w.field];
    if (gsiDecl && (!w.operator || w.operator === "eq")) {
      const fRef = fieldName(w.field, Object.keys(names).length);
      const vRef = valRef(w.value, Object.keys(values).length);

      return {
        tier: 2,
        indexName: gsiDecl.indexName,
        keyCondition: `${fRef} = ${vRef}`,
        expressionAttributeNames: names,
        expressionAttributeValues: values,
        needsFollowUpGetItem: gsiDecl.projection === "KEYS_ONLY",
        followUpKeyFields:
          gsiDecl.projection === "KEYS_ONLY"
            ? { pkField: schema.pkField, skField: schema.skField }
            : undefined,
      };
    }
  }

  // Tier 3: rejected
  return {
    tier: 3,
    expressionAttributeNames: {},
    expressionAttributeValues: {},
  };
}

async function _queryForKey(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  plan: ConsumeOnePlan,
  config: DynamoDBAdapterConfig,
  model: string,
): Promise<Record<string, any> | null> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: tableName,
      IndexName: plan.indexName!,
      KeyConditionExpression: plan.keyCondition!,
      ExpressionAttributeNames: plan.expressionAttributeNames,
      ExpressionAttributeValues: plan.expressionAttributeValues,
      Limit: 1,
    } as any),
  );

  const items = result.Items ?? [];

  if (items.length === 0) return null;

  // Follow-up GetItem for KEYS_ONLY GSIs
  if (plan.needsFollowUpGetItem) {
    const item = items[0]! as Record<string, any>;
    const fk = plan.followUpKeyFields!;
    const key: Record<string, any> = { [fk.pkField]: item[fk.pkField] };
    if (fk.skField && item[fk.skField] !== undefined) {
      key[fk.skField] = item[fk.skField];
    }
    const fuResult = await docClient.send(
      new GetCommand({ TableName: tableName, Key: key }),
    );
    return (fuResult.Item as any) ?? null;
  }

  return items[0] as any;
}
