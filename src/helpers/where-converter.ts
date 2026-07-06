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
 *   in         → #field IN (:vN, ...)   (max 100 values; >100 → chunked OR;
 *                empty array → vacuously FALSE, constant-folded)
 *   not_in     → NOT (#field IN (:vN, ...))  (empty array → vacuously TRUE)
 *   contains   → contains(#field, :val)
 *   starts_with → begins_with(#field, :prefix)
 *   ends_with  → contains(#field, :val) server-side over-approximation
 *                PLUS a client-side endsWith post-filter (DynamoDB has no
 *                suffix-match function; better-auth's admin plugin exposes
 *                ends_with as a first-class search operator, so it must
 *                work). Post-filters are AND-applied, so ends_with cannot
 *                be combined with OR connectors — that throws.
 *
 * UNSUPPORTED (throw UnsupportedOperatorError):
 *   mode: "insensitive" (verified unused by better-auth core and bundled
 *   plugins — they lowercase instead)
 *
 * AND/OR grouping matches better-auth's reference implementation
 * (@better-auth/memory-adapter): a strict left-to-right fold —
 * `result = result <connector> clause` — i.e. [A, B(OR), C(AND)] renders
 * as ((A OR B) AND C). Note better-auth's kysely adapter groups
 * differently (AND-group AND OR-group); the memory adapter is the
 * semantics its adapter test-kit exercises, so it is the reference here.
 *
 * All values pass through sanitizeValue (Date → ISO string): the
 * DocumentClient marshaller rejects raw Date instances.
 *
 * Operator dispatch uses a strategy registry (operators map) so that
 * adding a new operator is a one-line entry rather than modifying a
 * 150-line switch statement.
 */

import { UnsupportedOperatorError } from "../errors";
import { buildExpressionNames } from "./expression-names";
import { sanitizeValue } from "./update-item";
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

/**
 * A fragment is either an expression string or a boolean constant:
 * `false` = vacuously false (e.g. `in: []`), `true` = vacuously true
 * (e.g. `not_in: []`). Constants are folded away in buildExpression.
 */
type Fragment = string | boolean;

interface OperatorResult {
  frag: Fragment;
  valueIndex: number;
  chunked?: boolean;
}

type OperatorStrategy = (
  fieldRef: string,
  value: unknown,
  valueIndex: number,
  values: Record<string, any>,
) => OperatorResult;

const operators: Record<string, OperatorStrategy> = {
  eq: (fieldRef, value, vi, values) => {
    const ref = `:v${vi}`;
    values[ref] = sanitizeValue(value);
    return { frag: `${fieldRef} = ${ref}`, valueIndex: vi + 1 };
  },

  ne: (fieldRef, value, vi, values) => {
    const ref = `:v${vi}`;
    values[ref] = sanitizeValue(value);
    return { frag: `${fieldRef} <> ${ref}`, valueIndex: vi + 1 };
  },

  gt: (fieldRef, value, vi, values) => {
    const ref = `:v${vi}`;
    values[ref] = sanitizeValue(value);
    return { frag: `${fieldRef} > ${ref}`, valueIndex: vi + 1 };
  },

  gte: (fieldRef, value, vi, values) => {
    const ref = `:v${vi}`;
    values[ref] = sanitizeValue(value);
    return { frag: `${fieldRef} >= ${ref}`, valueIndex: vi + 1 };
  },

  lt: (fieldRef, value, vi, values) => {
    const ref = `:v${vi}`;
    values[ref] = sanitizeValue(value);
    return { frag: `${fieldRef} < ${ref}`, valueIndex: vi + 1 };
  },

  lte: (fieldRef, value, vi, values) => {
    const ref = `:v${vi}`;
    values[ref] = sanitizeValue(value);
    return { frag: `${fieldRef} <= ${ref}`, valueIndex: vi + 1 };
  },

  in: (fieldRef, value, vi, values) => {
    const arr: unknown[] = Array.isArray(value) ? value : [value];
    if (arr.length === 0) {
      // `x IN ()` is invalid DynamoDB syntax; an empty IN matches nothing.
      return { frag: false, valueIndex: vi };
    }
    if (arr.length <= MAX_IN_VALUES) {
      const refs: string[] = [];
      arr.forEach((v, i) => {
        const ref = `:v${vi + i}`;
        refs.push(ref);
        values[ref] = sanitizeValue(v);
      });
      return { frag: `${fieldRef} IN (${refs.join(", ")})`, valueIndex: vi + arr.length };
    }
    // >100 values — chunk into batches, OR-join
    const chunks: string[] = [];
    let idx = vi;
    for (let i = 0; i < arr.length; i += MAX_IN_VALUES) {
      const batch = arr.slice(i, i + MAX_IN_VALUES);
      const refs: string[] = [];
      batch.forEach((v) => {
        const ref = `:v${idx++}`;
        refs.push(ref);
        values[ref] = sanitizeValue(v);
      });
      chunks.push(`${fieldRef} IN (${refs.join(", ")})`);
    }
    return { frag: `(${chunks.join(" OR ")})`, valueIndex: idx, chunked: true };
  },

  not_in: (fieldRef, value, vi, values) => {
    const arr: unknown[] = Array.isArray(value) ? value : [value];
    if (arr.length === 0) {
      // NOT IN of nothing excludes nothing — vacuously true.
      return { frag: true, valueIndex: vi };
    }
    if (arr.length <= MAX_IN_VALUES) {
      const refs: string[] = [];
      arr.forEach((v, i) => {
        const ref = `:v${vi + i}`;
        refs.push(ref);
        values[ref] = sanitizeValue(v);
      });
      return { frag: `NOT (${fieldRef} IN (${refs.join(", ")}))`, valueIndex: vi + arr.length };
    }
    // >100 values → chunk and AND-join the NOT-IN blocks
    const parts: string[] = [];
    let idx = vi;
    for (let i = 0; i < arr.length; i += MAX_IN_VALUES) {
      const batch = arr.slice(i, i + MAX_IN_VALUES);
      const refs: string[] = [];
      batch.forEach((v) => {
        const ref = `:v${idx++}`;
        refs.push(ref);
        values[ref] = sanitizeValue(v);
      });
      parts.push(`NOT (${fieldRef} IN (${refs.join(", ")}))`);
    }
    return { frag: `(${parts.join(" AND ")})`, valueIndex: idx, chunked: true };
  },

  contains: (fieldRef, value, vi, values) => {
    const ref = `:v${vi}`;
    values[ref] = sanitizeValue(value);
    return { frag: `contains(${fieldRef}, ${ref})`, valueIndex: vi + 1 };
  },

  starts_with: (fieldRef, value, vi, values) => {
    const ref = `:v${vi}`;
    values[ref] = sanitizeValue(value);
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
    values[loRef] = sanitizeValue(arr[0]);
    values[hiRef] = sanitizeValue(arr[1]);
    return { frag: `${fieldRef} BETWEEN ${loRef} AND ${hiRef}`, valueIndex: vi + 2 };
  },

  // Server-side over-approximation; exact suffix match happens in the
  // client-side post-filter recorded by convertWhereClause.
  ends_with: (fieldRef, value, vi, values) => {
    const ref = `:v${vi}`;
    values[ref] = sanitizeValue(value);
    return { frag: `contains(${fieldRef}, ${ref})`, valueIndex: vi + 1 };
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
  const fragments: Array<{ frag: Fragment; connector: "AND" | "OR" }> = [];
  const postFilters: Array<{ field: string; operator: string; value: any }> = [];
  let valueIndex = 0;
  let chunked = false;
  let hasOr = false;

  for (const w of where) {
    const field = opts.getFieldName({ model: opts.model, field: w.field });
    const fieldRef = exprNames.toRef(field);
    const operator = (w.operator ?? "eq").toLowerCase();
    const connector = w.connector ?? "AND";
    if (connector === "OR" && fragments.length > 0) hasOr = true;

    // Reject unsupported modes / operators early.
    if (w.mode === "insensitive") {
      throw new UnsupportedOperatorError(
        "insensitive",
        "DynamoDB has no case-insensitive comparison. Store a lowercase copy of the field and query that instead.",
      );
    }

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
    if (operator === "ends_with") {
      // contains() narrows server-side; exact suffix match client-side.
      postFilters.push({ field, operator: "ends_with", value: w.value });
    }

    fragments.push({ frag: result.frag, connector });
  }

  // Post-filters are AND-applied to results; mixing them with OR groups
  // would over-restrict the other OR branches. Loud beats silently wrong.
  if (postFilters.length > 0 && hasOr) {
    throw new UnsupportedOperatorError(
      "ends_with",
      "ends_with cannot be combined with OR connectors on DynamoDB.",
    );
  }

  // ── Build final expression via left-to-right fold ─────────────
  const folded = buildExpression(fragments);

  if (folded === false) {
    return {
      expression: "",
      expressionAttributeNames: {},
      expressionAttributeValues: {},
      involvedFields: Array.from(fieldSet),
      needsClientSideFilter: false,
      alwaysFalse: true,
    };
  }

  const expression = folded === true ? "" : folded;

  // Constant folding may have dropped fragments; DynamoDB rejects requests
  // whose ExpressionAttributeNames/Values contain entries the expression
  // never references. Prune to the refs actually used.
  const { names: usedNames, values: usedValues } = pruneUnusedRefs(
    expression,
    exprNames.names,
    values,
  );

  return {
    expression,
    expressionAttributeNames: usedNames,
    expressionAttributeValues: usedValues,
    involvedFields: Array.from(fieldSet),
    needsClientSideFilter: false,
    ...(chunked ? { chunked: true } : {}),
    ...(postFilters.length > 0 ? { postFilters } : {}),
  };
}

// ── Internal helpers ────────────────────────────────────────────

/**
 * Renders (fragment, connector) pairs into a single expression using
 * better-auth's reference semantics: a strict left-to-right fold,
 * `result = result <connector> clause` — so [A, B(OR), C(AND)] becomes
 * (A OR B) AND C.
 *
 * Parentheses are emitted ONLY when the connector changes mid-fold:
 * homogeneous chains render flat ("A AND B AND C"). This matters beyond
 * cosmetics — Tier-2 KeyConditionExpressions are built through this
 * function too, and DynamoDB's key-condition grammar rejects
 * parenthesized conditions.
 *
 * Boolean constants (from empty in/not_in) are folded algebraically:
 *   X AND false → false     X AND true → X
 *   X OR  true  → true      X OR  false → X
 *
 * Returns the final expression string, or a boolean when the whole
 * clause folds to a constant.
 */
function buildExpression(
  fragments: Array<{ frag: Fragment; connector: "AND" | "OR" }>,
): Fragment {
  if (fragments.length === 0) return "";

  let acc: Fragment = fragments[0]!.frag;
  // Top-level connector of `acc` when it is a composite string;
  // null while acc is a single fragment (or was reset by constant folding).
  let accOp: "AND" | "OR" | null = null;

  for (let i = 1; i < fragments.length; i++) {
    const { frag, connector } = fragments[i]!;
    if (connector === "OR") {
      if (acc === true || frag === true) {
        acc = true;
        accOp = null;
      } else if (acc === false) {
        acc = frag;
        accOp = null;
      } else if (frag === false) {
        // X OR false → X (acc unchanged)
      } else {
        acc = accOp === "AND" ? `(${acc}) OR ${frag}` : `${acc} OR ${frag}`;
        accOp = "OR";
      }
    } else {
      if (acc === false || frag === false) {
        acc = false;
        accOp = null;
      } else if (acc === true) {
        acc = frag;
        accOp = null;
      } else if (frag === true) {
        // X AND true → X (acc unchanged)
      } else {
        acc = accOp === "OR" ? `(${acc}) AND ${frag}` : `${acc} AND ${frag}`;
        accOp = "AND";
      }
    }
  }

  return acc;
}

/**
 * Keeps only the #nX / :vX entries the expression actually references.
 */
function pruneUnusedRefs(
  expression: string,
  names: Record<string, string>,
  values: Record<string, any>,
): { names: Record<string, string>; values: Record<string, any> } {
  if (!expression) return { names: {}, values: {} };

  const usedNameRefs = new Set(expression.match(/#n\d+/g) ?? []);
  const usedValueRefs = new Set(expression.match(/:v\d+/g) ?? []);

  const prunedNames: Record<string, string> = {};
  for (const [k, v] of Object.entries(names)) {
    if (usedNameRefs.has(k)) prunedNames[k] = v;
  }
  const prunedValues: Record<string, any> = {};
  for (const [k, v] of Object.entries(values)) {
    if (usedValueRefs.has(k)) prunedValues[k] = v;
  }
  return { names: prunedNames, values: prunedValues };
}
