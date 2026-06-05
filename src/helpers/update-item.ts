/**
 * Shared helpers for building DynamoDB UpdateExpression fragments
 * and sanitizing data for writes (Date → ISO conversion).
 *
 * Used by update.ts, update-many.ts, create.ts, and transaction.ts.
 */

// ── UpdateExpression Builder ────────────────────────────────────

/**
 * Builds SET clause fragments and their ExpressionAttributeNames/Values
 * for a DynamoDB UpdateCommand.
 *
 * - Strips PK/SK fields from the update payload (DynamoDB rejects
 *   key-attribute mutation).
 * - Converts Date → ISO string in attribute values (DocumentClient v3
 *   does not auto-serialize Date).
 *
 * Returns placeholders using the canonical #nX / :vN pattern.
 */
export function buildUpdateExpression(
  update: Record<string, any>,
  pkField: string,
  skField?: string,
): {
  setClauses: string[];
  attrNames: Record<string, string>;
  attrValues: Record<string, any>;
} {
  // ── Strip key fields ────────────────────────────────────────
  const safeFields = Object.keys(update).filter(
    (f) => f !== pkField && f !== skField,
  );

  const attrNames: Record<string, string> = {};
  const attrValues: Record<string, any> = {};
  const setClauses: string[] = [];

  for (let i = 0; i < safeFields.length; i++) {
    const field = safeFields[i]!;
    const nameKey = `#n${i}`;
    const valueKey = `:v${i}`;
    attrNames[nameKey] = field;
    attrValues[valueKey] = sanitizeValue(update[field]);
    setClauses.push(`${nameKey} = ${valueKey}`);
  }

  return { setClauses, attrNames, attrValues };
}

// ── Write Sanitizer ─────────────────────────────────────────────

/**
 * Converts a single value for DynamoDB write compatibility.
 * Date → ISO string; everything else passes through.
 */
function sanitizeValue(val: unknown): any {
  return val instanceof Date ? val.toISOString() : val;
}

/**
 * Deep-copies an object, converting all Date instances to ISO 8601
 * strings. DocumentClient v3 does not auto-serialize Date, and
 * unhandled Date instances cause `Unsupported type passed: Date`
 * errors at marshalling time.
 *
 * Returns a new object — does not mutate the input.
 */
export function sanitizeForWrite<T extends Record<string, any>>(obj: T): T {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = sanitizeValue(v);
  }
  return out as T;
}
