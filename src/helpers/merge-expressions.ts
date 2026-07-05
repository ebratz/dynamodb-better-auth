/**
 * Expression merging for GSI queries — extracted from query-planner.ts.
 *
 * When a GSI Query has both a KeyConditionExpression (from hash/range key)
 * and a FilterExpression (from extra where clauses), they are built by
 * separate calls to convertWhereClause. Each call independently assigns
 * #nX / :vX placeholders starting from 0, so the two fragments' slots
 * collide whenever both are non-empty.
 *
 * This function merges the two maps by re-namespacing the ENTIRE filter
 * fragment: every #nX shifts by the key-condition's name count and every
 * :vX by its value count, making the two slot sets provably disjoint.
 *
 * Regression note (0.1.6): the previous implementation remapped #nX name
 * collisions but left :vX VALUE collisions unhandled — the filter's :v0
 * silently overwrote the key condition's :v0 via Object.assign. A Tier-2
 * plan like `where: [{domain eq "x.com"}, {domainVerified eq true}]` then
 * queried the GSI with `domain = true`, which DynamoDB rejects with
 * "Condition parameter type does not match schema type" (or, when the
 * clobbered value happened to be type-compatible, silently returned the
 * wrong result set). The name remap also had cascade/prefix hazards
 * (#n1→#n2 could re-match a just-written slot; #n1 matched inside #n10).
 */

/**
 * Result of a single convertWhereClause call — the expression string
 * plus its ExpressionAttributeNames / ExpressionAttributeValues maps.
 */
interface ExpressionFragment {
  expression: string;
  expressionAttributeNames: Record<string, string>;
  expressionAttributeValues: Record<string, any>;
}

/**
 * Shifts every `${prefix}${idx}` reference in `refs` up by `shift`,
 * patching `expr` accordingly, and writes the result into `into`.
 *
 * Replacements run in DESCENDING index order with a numeric-boundary
 * lookahead so they can never cascade (#n1→#n2 runs after #n2→#n3) and a
 * short ref can never match inside a longer one (#n1 vs #n10). Returns
 * the patched expression.
 */
function shiftFragmentRefs(
  expr: string,
  refs: Record<string, any>,
  prefix: "#n" | ":v",
  shift: number,
  into: Record<string, any>,
): string {
  const entries = Object.entries(refs)
    .map(([key, val]) => ({ key, val, idx: Number(key.slice(prefix.length)) }))
    .sort((a, b) => b.idx - a.idx);

  for (const { key, val, idx } of entries) {
    // Non-standard ref (not `${prefix}<number>`) — convertWhereClause never
    // emits these; keep them untouched rather than guessing.
    if (!Number.isInteger(idx) || idx < 0 || key !== `${prefix}${idx}`) {
      into[key] = val;
      continue;
    }
    const newKey = `${prefix}${idx + shift}`;
    into[newKey] = val;
    if (shift > 0) {
      const escaped = key.replace(/[#:]/g, "\\$&");
      expr = expr.replace(new RegExp(`${escaped}(?!\\d)`, "g"), newKey);
    }
  }
  return expr;
}

/**
 * Merges a key-condition expression fragment with an optional filter
 * expression fragment. The key condition keeps its slots verbatim; the
 * filter fragment's #nX / :vX references are shifted past them.
 *
 * When filterResult has no expression (empty filterClauses), returns
 * the key-condition fragment unchanged with no filter expression.
 */
export function mergeKeyAndFilterExpressions(
  kcResult: ExpressionFragment,
  filterResult?: ExpressionFragment,
): {
  keyCondition: string;
  filterExpression: string;
  names: Record<string, string>;
  values: Record<string, any>;
} {
  if (!filterResult || !filterResult.expression) {
    return {
      keyCondition: kcResult.expression,
      filterExpression: "",
      names: kcResult.expressionAttributeNames,
      values: kcResult.expressionAttributeValues,
    };
  }

  const mergedNames: Record<string, string> = { ...kcResult.expressionAttributeNames };
  const mergedValues: Record<string, any> = { ...kcResult.expressionAttributeValues };

  let filterExpr = shiftFragmentRefs(
    filterResult.expression,
    filterResult.expressionAttributeNames,
    "#n",
    Object.keys(kcResult.expressionAttributeNames).length,
    mergedNames,
  );
  filterExpr = shiftFragmentRefs(
    filterExpr,
    filterResult.expressionAttributeValues,
    ":v",
    Object.keys(kcResult.expressionAttributeValues).length,
    mergedValues,
  );

  return {
    keyCondition: kcResult.expression,
    filterExpression: filterExpr,
    names: mergedNames,
    values: mergedValues,
  };
}
