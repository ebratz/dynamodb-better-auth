import type { TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import type { WhereClause } from "../types";
import { matchesClientFilters } from "../helpers/resolve-item";
import { resolveQueryPlan } from "../helpers/query-planner";
import { getKeySchema } from "../helpers/key-builder";
import { DynamoAdapterError } from "../errors";
import type { TransactionContext } from "./tx-types";

/** Overlay buffered writes before filtering, sorting, and pagination. */
export async function txRead(ctx: TransactionContext, args: {
  model: string;
  where?: WhereClause[];
  limit?: number;
  offset?: number;
  sortBy?: { field: string; direction: "asc" | "desc" };
}): Promise<Record<string, unknown>[] | undefined> {
  const table = ctx.getTable(args.model);
  const actions = (ctx.writeBuffer as NonNullable<TransactWriteCommandInput["TransactItems"]>)
    .filter(action => (action.Put ?? action.Update ?? action.Delete)?.TableName === table);
  if (!actions.length) return undefined;
  resolveQueryPlan(args.where ?? [], args.model, ctx.config); // Validate unsupported predicates.
  const schema = getKeySchema(args.model, ctx.config);
  const keyOf = (row: Record<string, unknown>) => JSON.stringify([row[schema.pkField], schema.skField ? row[schema.skField] : null]);
  const cap = ctx.config.maxScanItems ?? 10_000;
  const rows = await ctx.nativeAdapter.findMany({ model: args.model, where: [], limit: cap > 0 ? cap + 1 : Number.MAX_SAFE_INTEGER });
  if (cap > 0 && rows.length > cap) throw new DynamoAdapterError("SCAN_LIMIT_EXCEEDED", "Transaction read exceeded maxScanItems.");
  const view = new Map<string, Record<string, unknown>>(rows.map(row => [keyOf(row), { ...row }]));
  for (const action of actions) {
    if (action.Put?.Item) view.set(keyOf(action.Put.Item), { ...action.Put.Item });
    if (action.Delete?.Key) view.delete(keyOf(action.Delete.Key));
    if (action.Update?.Key) {
      const update = action.Update;
      const row = view.get(keyOf(update.Key!));
      if (!row) continue;
      if (!update.UpdateExpression?.startsWith("SET ")) throw new DynamoAdapterError("INVALID_DATA", "Unsupported buffered update expression.");
      // All buffered adapter updates use flat SET assignments from buildUpdateExpression.
      for (const assignment of update.UpdateExpression.slice(4).split(",")) {
        const [name, value] = assignment.trim().split(/\s*=\s*/);
        const field = update.ExpressionAttributeNames?.[name!];
        if (!field || !value) throw new DynamoAdapterError("INVALID_DATA", "Unsupported buffered update expression.");
        row[field] = update.ExpressionAttributeValues?.[value];
      }
    }
  }
  const result = [...view.values()].filter(row => {
    let matches = true;
    for (const [index, clause] of (args.where ?? []).entries()) {
      const value = matchesClientFilters(row, [{ field: clause.field, operator: clause.operator ?? "eq", value: clause.value }]);
      matches = index === 0 ? value : clause.connector === "OR" ? matches || value : matches && value;
    }
    return matches;
  });
  if (args.sortBy) {
    const { field, direction } = args.sortBy;
    result.sort((a, b) => {
      const av = a[field] as string | number;
      const bv = b[field] as string | number;
      return (av < bv ? -1 : av > bv ? 1 : 0) * (direction === "desc" ? -1 : 1);
    });
  }
  const offset = args.offset ?? 0;
  return result.slice(offset, args.limit === undefined ? undefined : offset + args.limit);
}
