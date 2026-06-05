/**
 * Expression merging for GSI queries — extracted from query-planner.ts.
 *
 * When a GSI Query has both a KeyConditionExpression (from hash/range key)
 * and a FilterExpression (from extra where clauses), they are built by
 * separate calls to convertWhereClause. Each call independently assigns
 * #nX placeholders, which can collide when the same field name appears
 * in both the key-condition and filter sets.
 *
 * This function merges the two maps, remapping collisions to fresh slots
 * and patching the filter expression to use the new placeholders.
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
 * Merges a key-condition expression fragment with an optional filter
 * expression fragment, remapping any #nX placeholder collisions.
 *
 * Returns the combined names/values map, the original keyCondition
 * expression, and the (possibly patched) filterExpression.
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

  let filterExpr = filterResult.expression;
  let offset = Object.keys(kcResult.expressionAttributeNames).length;
  const mergedNames = { ...kcResult.expressionAttributeNames };
  const mergedValues = { ...kcResult.expressionAttributeValues };

  for (const [key, field] of Object.entries(filterResult.expressionAttributeNames)) {
    if (mergedNames[key] !== undefined && mergedNames[key] !== field) {
      // Collision — same #nX placeholder maps to a different field.
      // Remap to a fresh #nX slot and patch the filter expression.
      const newKey = `#n${offset++}`;
      mergedNames[newKey] = field;
      const escapedKey = key.replace(/#/g, "\\#");
      filterExpr = filterExpr.replace(new RegExp(escapedKey, "g"), newKey);
    } else if (mergedNames[key] === undefined) {
      mergedNames[key] = field;
    }
    // Same field → same placeholder → no action needed.
  }
  Object.assign(mergedValues, filterResult.expressionAttributeValues);

  return {
    keyCondition: kcResult.expression,
    filterExpression: filterExpr,
    names: mergedNames,
    values: mergedValues,
  };
}
