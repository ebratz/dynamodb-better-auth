import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DynamoDBAdapterConfig, WhereClause } from "../../types";
import { DynamoAdapterError } from "../../errors";
import { findOneMethod } from "./find-one";
import { updateMethod } from "./update";
import { snapshotWhere } from "../../helpers/write-condition";

export interface IncrementArgs {
  model: string;
  where: WhereClause[];
  increment: Record<string, number>;
  set?: Record<string, unknown>;
}

export function incrementPatch(row: Record<string, unknown>, args: IncrementArgs): Record<string, unknown> {
  const patch = Object.fromEntries(Object.entries(args.set ?? {}).filter(([, value]) => value !== undefined));
  for (const [field, delta] of Object.entries(args.increment)) {
    const value = row[field] ?? 0;
    if (typeof value !== "number" || !Number.isFinite(value) || !Number.isFinite(delta) ||
      !Number.isFinite(value + delta) || (delta !== 0 && value + delta === value)) {
      throw new DynamoAdapterError("INVALID_DATA", "Increment requires representable finite numeric counters and deltas.");
    }
    if (field in patch) throw new DynamoAdapterError("INVALID_DATA", `Cannot increment and set ${field} together.`);
    patch[field] = value + delta;
  }
  if (!Object.keys(patch).length) throw new DynamoAdapterError("INVALID_DATA", "Increment requires at least one increment or assignment.");
  return patch;
}

/** Optimistic atomic increment. Every write guards the observed snapshot. */
export function incrementOneMethod(client: DynamoDBDocumentClient, config: DynamoDBAdapterConfig) {
  const find = findOneMethod(client, config);
  const update = updateMethod(client, config);
  return async (args: IncrementArgs): Promise<Record<string, unknown> | null> => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const row = await find(args);
      if (!row) return null;
      const patch = incrementPatch(row, args);
      // Include absent counters explicitly: another writer may initialize them.
      const guards = snapshotWhere({ ...Object.fromEntries(Object.keys(patch).map(field => [field, row[field] ?? null])), ...row });
      const result = await update({ model: args.model, where: [...args.where, ...guards], update: patch });
      if (result) return result;
    }
    throw new DynamoAdapterError("TRANSACTION_CONFLICT", "Atomic increment exceeded its contention retry budget.");
  };
}
