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
 * Operator dispatch uses a strategy registry (operators map) so that
 * adding a new operator is a one-line entry rather than modifying a
 * 150-line switch statement.
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

// ── Operator strategy registry ──────────────────────────────────

interface OperatorResult {
  frag: string;
  valueIndex: number;
  chunked?: boolean;
}

type OperatorStrategy = (
  fieldRef: string,
  value: unknown,
  valueIndex: number,
  values: Record<string, any>,
) => OperatorResult;

/**
 * Registry of all supported DynamoDB operators.
 *
 * Each entry is a pure function: (fieldRef, value, valueIndex, values)
 * → { frag, valueIndex, chunked? }.
 *
 * - `fieldRef` – the #nX placeholder (e.g. "#n0")
 * - `value`     – the value(s) from the where clause
 * - `valueIndex`– current :v counter before this operator consumes slots
 * - `values`    – mutable map to populate with :vX → actual value entries
 *
 * Adding a new operator is a single entry in this map.
 */
const operators: Record<string, OperatorStrategy> = {
  eq: (fieldRef, value, vi, values) => {
    const ref = `:v${vi}`;
    values[ref] = value;
    return { frag: `${fieldRef} = ${ref}`, valueIndex: vi + 1 };
  },

  ne: (fieldRef, value, vi, values) => {
    const ref = `:v${vi}`;
    values[ref] = value;
    return { frag: `${fieldRef} <> ${ref}`, valueIndex: vi + 1 };
  },

  gt: (fieldRef, value, vi, values) => {
    const ref = `:v${vi}`;
    values[ref] = value;
    return { frag: `${fieldRef} > ${ref}`, valueIndex: vi + 1 };
  },

  gte: (fieldRef, value, vi, values) => {
    const ref = `:v${vi}`;
    values[ref] = value;
    return { frag: `${fieldRef} >= ${ref}`, valueIndex: vi + 1 };
  },

  lt: (fieldRef, value, vi, values) => {
    const ref = `:v${vi}`;
    values[ref] = value;
    return { frag: `${fieldRef} < ${ref}`, valueIndex: vi + 1 };
  },

  lte: (fieldRef, value, vi, values) => {
    const ref = `:v${vi}`;
    values[ref] = value;
    return { frag: `${fieldRef} <= ${ref}`, valueIndex: vi + 1 };
  },

  in: (fieldRef, value, vi, values) => {
    const arr: unknown[] = Array.isArray(value) ? value : [value];
    if (arr.length === 0) {
      return { frag: `${fieldRef} IN ()`, valueIndex: vi };
    }
    if (arr.length <= MAX_IN_VALUES) {
      // Single IN clause
      const refs: string[] = [];
      for (let i = 0; i < arr.length; i++) {
        const ref = `:v${vi + i}`;
        refs.push(ref);
        values[ref] = null; // placeholder, populated below
      }
      arr.forEach((v, i) => { values[refs[i]!] = v; });
      return { frag: `${fieldRef} IN (${refs.join(", ")})`, valueIndex: vi + arr.length };
    }
    // >100 values — chunk into batches, OR-join
    const chunks: string[] = [];
    let idx = vi;
    for (let i = 0; i < arr.length; i += MAX_IN_VALUES) {
      const batch = arr.slice(i, i + MAX_IN_VALUES);
      const refs: string[] = [];
      for (let j = 0; j < batch.length; j++) {
        const ref = `:v${idx++}`;
        refs.push(ref);
        values[ref] = null;
      }
      batch.forEach((v, j) => { values[refs[j]!] = v; });
      chunks.push(`${fieldRef} IN (${refs.join(", ")})`);
    }
    return { frag: `(${chunks.join(" OR ")})`, valueIndex: idx, chunked: true };
  },

  not_in: (fieldRef, value, vi, values) => {
    const arr: unknown[] = Array.isArray(value) ? value : [value];
    if (arr.length === 0) {
      return { frag: `NOT ${fieldRef} IN ()`, valueIndex: vi };
    }
    if (arr.length <= MAX_IN_VALUES) {
      const refs: string[] = [];
      for (let i = 0; i < arr.length; i++) {
        const ref = `:v${vi + i}`;
        refs.push(ref);
        values[ref] = null;
      }
      arr.forEach((v, i) => { values[refs[i]!] = v; });
      return { frag: `NOT (${fieldRef} IN (${refs.join(", ")}))`, valueIndex: vi + arr.length };
    }
    // >100 values → chunk and AND-join the NOT-IN blocks
    const parts: string[] = [];
    let idx = vi;
    for (let i = 0; i < arr.length; i += MAX_IN_VALUES) {
      const batch = arr.slice(i, i + MAX_IN_VALUES);
      const refs: string[] = [];
      for (let j = 0; j < batch.length; j++) {
        const ref = `:v${idx++}`;
        refs.push(ref);
        values[ref] = null;
      }
      batch.forEach((v, j) => { values[refs[j]!] = v; });
      parts.push(`NOT (${fieldRef} IN (${refs.join(", ")}))`);
    }
    return { frag: `(${parts.join(" AND ")})`, valueIndex: idx, chunked: true };
  },

  contains: (fieldRef, value, vi, values) => {
    const ref = `:v${vi}`;
    values[ref] = value;
    return { frag: `contains(${fieldRef}, ${ref})`, valueIndex: vi + 1 };
  },

  starts_with: (fieldRef, value, vi, values) => {
    const ref = `:v${vi}`;
    values[ref] = value;
    return { frag: `begins_with(${fieldRef}, ${ref})`, valueIndex: vi + 1 };
  },

  between: (fieldRef, value, vi, values) => {
    const arr: unknown[] = Array.isArray(value) ? value : [];
    if (arr.length !== 2) {
      throw new UnsupportedOperatorError(
        "between",
        "BETWEEN requires exactly 2 values: [low, high].",
      );
    }
    const loRef = `:v${vi}`;
    const hiRef = `:v${vi + 1}`;
    values[loRef] = arr[0];
    values[hiRef] = arr[1];
    return { frag: `${fieldRef} BETWEEN ${loRef} AND ${hiRef}`, valueIndex: vi + 2 };
  },

  ends_with: () => {
    throw new UnsupportedOperatorError(
      "ends_with",
      "DynamoDB has no suffix-match function. Store a reversed copy of the field and use begins_with on a GSI, or filter client-side.",
    );
  },
};

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

    // Look up operator strategy from the registry
    const strategy = operators[operator];
    if (!strategy) {
      throw new UnsupportedOperatorError(
        operator,
        `Operator not in the supported set: ${Object.keys(operators).join(", ")}.`,
      );
    }

    const result = strategy(fieldRef, w.value, valueIndex, values);
    valueIndex = result.valueIndex;
    if (result.chunked) {
      chunked = true;
    }

    fragments.push({ frag: result.frag, connector });
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
