import type { WhereClause } from "../types";
import { DynamoAdapterError } from "../errors";
import { convertWhereClause } from "./where-converter";

/** Compile the predicate at the write boundary, independently of read routing. */
export function writeCondition(
  where: WhereClause[],
  pkField: string,
  snapshot?: Record<string, unknown>,
) {
  const filter = convert(where);
  const names: Record<string, string> = { "#pk": pkField };
  const values: Record<string, unknown> = {};
  if (filter?.alwaysFalse) return {
    ConditionExpression: "attribute_exists(#pk) AND attribute_not_exists(#pk)",
    ExpressionAttributeNames: names,
  };
  let expression = filter?.expression ?? "";
  for (const [alias, field] of Object.entries(filter?.expressionAttributeNames ?? {})) {
    names[alias.replace("#n", "#c")] = field;
  }
  for (const [alias, value] of Object.entries(filter?.expressionAttributeValues ?? {})) {
    values[alias.replace(":v", ":c")] = value;
  }
  expression = expression.replace(/#n(\d+)/g, "#c$1").replace(/:v(\d+)/g, ":c$1");
  for (const [i, clause] of (filter?.postFilters ?? []).entries()) {
    if (!snapshot) throw new DynamoAdapterError("INVALID_WHERE", "Atomic suffix predicates require a row snapshot.");
    names[`#s${i}`] = clause.field;
    const value = snapshot[clause.field];
    const guard = value === undefined
      ? `attribute_not_exists(#s${i})`
      : `#s${i} = :s${i}`;
    if (value !== undefined) values[`:s${i}`] = value;
    expression = expression ? `(${expression}) AND ${guard}` : guard;
  }
  return {
    ConditionExpression: expression ? `attribute_exists(#pk) AND (${expression})` : "attribute_exists(#pk)",
    ExpressionAttributeNames: names,
    ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
  };
}

function convert(where: WhereClause[]) {
  return convertWhereClause(where, {
    model: "",
    getFieldName: ({ field }) => field,
    getFieldAttributes: () => ({}),
  });
}

export function snapshotWhere(row: Record<string, unknown>): WhereClause[] {
  return Object.entries(row).filter(([, value]) => value !== undefined).map(([field, value]) => ({
    field, value: value as WhereClause["value"], operator: "eq", connector: "AND",
  }));
}
