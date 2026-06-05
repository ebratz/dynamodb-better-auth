/**
 * Converts a Better Auth where clause to DynamoDB expression fragments.
 *
 * Operator mappings per DESIGN.md §4:
 *   eq         → #field = :val
 *   ne         → #field <> :val
 *   gt         → #field > :val
 *   gte        → #field >= :val
 *   lt         → #field < :val
 *   lte        → #field <= :val
 *   between    → #field BETWEEN :vN AND :vM
 *   in         → #field IN (:vN, ...)   (max 100 values; >100 → chunked OR)
 *   not_in     → NOT (#field IN (:vN, ...))
 *   contains   → contains(#field, :val)
 *   starts_with → begins_with(#field, :prefix)
 *
 * UNSUPPORTED (throw UnsupportedOperatorError):
 *   ends_with, mode: "insensitive"
 *
 * Per DESIGN.md §4 + review-gap fix B (IN chunking).
 */

import { UnsupportedOperatorError } from "../errors";
import { buildExpressionNames } from "./expression-names";
import type { ConvertedWhere, ConversionOptions } from "../types";

/**
 * DynamoDB enforces max 100 values in an IN clause.
 * Beyond that we split into chunks joined by OR.
 */
const MAX_IN_VALUES = 100;

/**
 * Where clause entry shape — cleaned by the adapter factory before we see it.
 */
interface WhereEntry {
  field: string;
  value: string | number | boolean | string[] | number[] | Date | null;
  operator?: string;
  connector?: "AND" | "OR";
  mode?: "sensitive" | "insensitive";
}

// ── Public API ──────────────────────────────────────────────────

export function convertWhereClause(
  where: WhereEntry[],
  opts: ConversionOptions,
): ConvertedWhere {
  if (!where || where.length === 0) {
    return {
      expression: "",
      expressionAttributeNames: {},
      expressionAttributeValues: {},
      involvedFields: [],
      needsClientSideFilter: false,
    };
  }

  // Collect all unique field names for ExpressionAttributeNames.
  const fieldSet = new Set<string>();
  for (const w of where) {
    fieldSet.add(opts.getFieldName({ model: opts.model, field: w.field }));
  }
  const exprNames = buildExpressionNames(Array.from(fieldSet));

  const values: Record<string, any> = {};
  const fragments: Array<{ frag: string; connector: "AND" | "OR" }> = [];
  let valueIndex = 0;
  let chunked = false;

  for (const w of where) {
    const field = opts.getFieldName({ model: opts.model, field: w.field });
    const fieldRef = exprNames.toRef(field);
    const operator = (w.operator ?? "eq").toLowerCase();
    const connector = w.connector ?? "AND";

    // Reject unsupported modes / operators early.
    if (w.mode === "insensitive") {
      throw new UnsupportedOperatorError(
        "insensitive",
        "DynamoDB has no case-insensitive comparison. Store a lowercase copy of the field and query that instead.",
      );
    }

    let frag: string;

    switch (operator) {
      case "eq": {
        const ref = `:v${valueIndex++}`;
        values[ref] = w.value;
        frag = `${fieldRef} = ${ref}`;
        break;
      }
      case "ne": {
        const ref = `:v${valueIndex++}`;
        values[ref] = w.value;
        frag = `${fieldRef} <> ${ref}`;
        break;
      }
      case "gt": {
        const ref = `:v${valueIndex++}`;
        values[ref] = w.value;
        frag = `${fieldRef} > ${ref}`;
        break;
      }
      case "gte": {
        const ref = `:v${valueIndex++}`;
        values[ref] = w.value;
        frag = `${fieldRef} >= ${ref}`;
        break;
      }
      case "lt": {
        const ref = `:v${valueIndex++}`;
        values[ref] = w.value;
        frag = `${fieldRef} < ${ref}`;
        break;
      }
      case "lte": {
        const ref = `:v${valueIndex++}`;
        values[ref] = w.value;
        frag = `${fieldRef} <= ${ref}`;
        break;
      }
      case "in": {
        const arr = Array.isArray(w.value) ? w.value : [w.value];
        if (arr.length === 0) {
          // IN with empty list matches nothing.
          frag = `${fieldRef} IN ()`;
        } else if (arr.length <= MAX_IN_VALUES) {
          const refs = arr.map(() => {
            const ref = `:v${valueIndex++}`;
            values[ref] = null; // placeholder — filled below
            return ref;
          });
          // Fill actual values (must happen after refs are created
          // so valueIndex ordering matches ref list order).
          arr.forEach((v, i) => {
            values[refs[i]!] = v;
          });
          frag = `${fieldRef} IN (${refs.join(", ")})`;
        } else {
          // >100 values — chunk into batches of 100, OR-join.
          chunked = true;
          const chunks: string[] = [];
          for (let i = 0; i < arr.length; i += MAX_IN_VALUES) {
            const batch = arr.slice(i, i + MAX_IN_VALUES);
            const refs = batch.map(() => {
              const ref = `:v${valueIndex++}`;
              values[ref] = null;
              return ref;
            });
            batch.forEach((v, j) => {
              values[refs[j]!] = v;
            });
            chunks.push(`${fieldRef} IN (${refs.join(", ")})`);
          }
          frag = `(${chunks.join(" OR ")})`;
        }
        break;
      }
      case "not_in": {
        const arr = Array.isArray(w.value) ? w.value : [w.value];
        if (arr.length === 0) {
          frag = `NOT ${fieldRef} IN ()`;
        } else if (arr.length <= MAX_IN_VALUES) {
          const refs = arr.map(() => {
            const ref = `:v${valueIndex++}`;
            values[ref] = null;
            return ref;
          });
          arr.forEach((v, i) => {
            values[refs[i]!] = v;
          });
          frag = `NOT (${fieldRef} IN (${refs.join(", ")}))`;
        } else {
          // >100 values → chunk and AND-join the NOT-IN blocks.
          // "NOT IN chunk1 AND NOT IN chunk2" correctly excludes all values.
          chunked = true;
          const parts: string[] = [];
          for (let i = 0; i < arr.length; i += MAX_IN_VALUES) {
            const batch = arr.slice(i, i + MAX_IN_VALUES);
            const refs = batch.map(() => {
              const ref = `:v${valueIndex++}`;
              values[ref] = null;
              return ref;
            });
            batch.forEach((v, j) => {
              values[refs[j]!] = v;
            });
            parts.push(`NOT (${fieldRef} IN (${refs.join(", ")}))`);
          }
          frag = `(${parts.join(" AND ")})`;
        }
        break;
      }
      case "contains": {
        const ref = `:v${valueIndex++}`;
        values[ref] = w.value;
        frag = `contains(${fieldRef}, ${ref})`;
        break;
      }
      case "starts_with": {
        const ref = `:v${valueIndex++}`;
        values[ref] = w.value;
        frag = `begins_with(${fieldRef}, ${ref})`;
        break;
      }
      case "between": {
        const arr = Array.isArray(w.value) ? w.value : [];
        if (arr.length !== 2) {
          throw new UnsupportedOperatorError(
            "between",
            "BETWEEN requires exactly 2 values: [low, high].",
          );
        }
        const loRef = `:v${valueIndex++}`;
        const hiRef = `:v${valueIndex++}`;
        values[loRef] = arr[0];
        values[hiRef] = arr[1];
        frag = `${fieldRef} BETWEEN ${loRef} AND ${hiRef}`;
        break;
      }
      case "ends_with": {
        throw new UnsupportedOperatorError(
          "ends_with",
          "DynamoDB has no suffix-match function. Store a reversed copy of the field and use begins_with on a GSI, or filter client-side.",
        );
      }
      default: {
        throw new UnsupportedOperatorError(
          operator,
          `Operator not in the supported set: eq, ne, gt, gte, lt, lte, in, not_in, contains, starts_with, between.`,
        );
      }
    }

    fragments.push({ frag, connector });
  }

  // ── Build final expression with AND/OR grouping ───────────────
  const expression = buildExpression(fragments);

  return {
    expression,
    expressionAttributeNames: exprNames.names,
    expressionAttributeValues: values,
    involvedFields: Array.from(fieldSet),
    needsClientSideFilter: false,
    ...(chunked ? { chunked: true } : {}),
  };
}

// ── Internal helpers ────────────────────────────────────────────

/**
 * Renders a list of (fragment, connector) pairs into a single
 * DynamoDB expression string respecting AND/OR precedence.
 *
 * Strategy:
 *   - Group consecutive AND clauses together (implicit AND).
 *   - OR clauses split the group.
 *   - Final: (AND_group1) OR (AND_group2) OR ...
 */
function buildExpression(
  fragments: Array<{ frag: string; connector: "AND" | "OR" }>,
): string {
  if (fragments.length === 0) return "";
  if (fragments.length === 1) return fragments[0]!.frag;

  // Partition into OR-separated groups. Each group is an AND-list.
  const groups: string[][] = [];
  let current: string[] = [];

  for (const f of fragments) {
    if (f.connector === "OR" && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(f.frag);
  }
  if (current.length > 0) {
    groups.push(current);
  }

  if (groups.length === 1) {
    // All AND — no wrapping parens needed.
    return groups[0]!.join(" AND ");
  }

  // Multiple groups — wrap each in parens, join with OR.
  return groups
    .map((g) => (g.length === 1 ? g[0] : `(${g.join(" AND ")})`))
    .join(" OR ");
}
