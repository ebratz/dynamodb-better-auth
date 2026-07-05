import { describe, it, expect } from "vitest";
import { mergeKeyAndFilterExpressions } from "../src/helpers/merge-expressions";

/**
 * Invariant checker: every #nX / :vX referenced by the two expressions must
 * resolve in the merged maps, and every merged entry must be referenced by
 * at least one expression (DynamoDB rejects unused ExpressionAttributeValues).
 */
function assertWellFormed(result: {
  keyCondition: string;
  filterExpression: string;
  names: Record<string, string>;
  values: Record<string, any>;
}) {
  const exprs = `${result.keyCondition} ${result.filterExpression}`;
  const usedNames = new Set(exprs.match(/#n\d+/g) ?? []);
  const usedValues = new Set(exprs.match(/:v\d+/g) ?? []);
  for (const ref of usedNames) {
    expect(result.names, `unresolved name ref ${ref}`).toHaveProperty([ref]);
  }
  for (const ref of usedValues) {
    expect(result.values, `unresolved value ref ${ref}`).toHaveProperty([ref]);
  }
  for (const key of Object.keys(result.values)) {
    expect(usedValues.has(key), `unused value entry ${key}`).toBe(true);
  }
  for (const key of Object.keys(result.names)) {
    expect(usedNames.has(key), `unused name entry ${key}`).toBe(true);
  }
}

/** Resolves the single `#nX = :vX`-style key condition to its [field, value]. */
function keyBinding(result: {
  keyCondition: string;
  names: Record<string, string>;
  values: Record<string, any>;
}): [string, unknown] {
  const [, nameRef, valueRef] = result.keyCondition.match(/(#n\d+) = (:v\d+)/)!;
  return [result.names[nameRef], result.values[valueRef]];
}

describe("mergeKeyAndFilterExpressions", () => {
  it("returns key condition unchanged when no filter is provided", () => {
    const kc = {
      expression: "#n0 = :v0",
      expressionAttributeNames: { "#n0": "email" },
      expressionAttributeValues: { ":v0": "a@b.com" },
    };

    const result = mergeKeyAndFilterExpressions(kc);

    expect(result.keyCondition).toBe("#n0 = :v0");
    expect(result.filterExpression).toBe("");
    expect(result.names).toEqual({ "#n0": "email" });
    expect(result.values).toEqual({ ":v0": "a@b.com" });
  });

  it("returns key condition unchanged when filter has empty expression", () => {
    const kc = {
      expression: "#n0 = :v0",
      expressionAttributeNames: { "#n0": "email" },
      expressionAttributeValues: { ":v0": "a@b.com" },
    };
    const filter = {
      expression: "",
      expressionAttributeNames: {},
      expressionAttributeValues: {},
    };

    const result = mergeKeyAndFilterExpressions(kc, filter);

    expect(result.keyCondition).toBe("#n0 = :v0");
    expect(result.filterExpression).toBe("");
    expect(result.names).toEqual({ "#n0": "email" });
  });

  it("REGRESSION (0.1.6): filter :v0 must not clobber the key condition's :v0", () => {
    // The exact prod shape that broke Google sign-in: findOne ssoProvider
    // where [{domain eq "gmail.com"}, {domainVerified eq true}] planned as a
    // Tier-2 query on domain-index. Both convertWhereClause calls start at
    // :v0 — before the fix, Object.assign overwrote the key's "gmail.com"
    // with the filter's `true`, and DynamoDB rejected the boolean key with
    // "Condition parameter type does not match schema type".
    const kc = {
      expression: "#n0 = :v0",
      expressionAttributeNames: { "#n0": "domain" },
      expressionAttributeValues: { ":v0": "gmail.com" },
    };
    const filter = {
      expression: "#n0 = :v0",
      expressionAttributeNames: { "#n0": "domainVerified" },
      expressionAttributeValues: { ":v0": true },
    };

    const result = mergeKeyAndFilterExpressions(kc, filter);

    assertWellFormed(result);
    // The key condition still binds domain = "gmail.com".
    expect(result.keyCondition).toBe("#n0 = :v0");
    expect(keyBinding(result)).toEqual(["domain", "gmail.com"]);
    // The filter binds domainVerified = true through its own (shifted) slots.
    const [, fNameRef, fValueRef] = result.filterExpression.match(/(#n\d+) = (:v\d+)/)!;
    expect(result.names[fNameRef]).toBe("domainVerified");
    expect(result.values[fValueRef]).toBe(true);
  });

  it("keeps every binding when the filter has multiple colliding refs", () => {
    // userId = "u1" (key) AND expiresAt > <date> AND ipAddress = "1.2.3.4" —
    // filter refs :v0/:v1 both collide-adjacent with the key's :v0.
    const kc = {
      expression: "#n0 = :v0",
      expressionAttributeNames: { "#n0": "userId" },
      expressionAttributeValues: { ":v0": "u1" },
    };
    const filter = {
      expression: "#n0 > :v0 AND #n1 = :v1",
      expressionAttributeNames: { "#n0": "expiresAt", "#n1": "ipAddress" },
      expressionAttributeValues: { ":v0": "2026-07-05T00:00:00.000Z", ":v1": "1.2.3.4" },
    };

    const result = mergeKeyAndFilterExpressions(kc, filter);

    assertWellFormed(result);
    expect(keyBinding(result)).toEqual(["userId", "u1"]);
    // Filter bindings survive intact: expiresAt > date, ipAddress = 1.2.3.4.
    const gt = result.filterExpression.match(/(#n\d+) > (:v\d+)/)!;
    expect(result.names[gt[1]]).toBe("expiresAt");
    expect(result.values[gt[2]]).toBe("2026-07-05T00:00:00.000Z");
    const eq = result.filterExpression.match(/(#n\d+) = (:v\d+)/)!;
    expect(result.names[eq[1]]).toBe("ipAddress");
    expect(result.values[eq[2]]).toBe("1.2.3.4");
  });

  it("does not cascade shifts when filter refs overlap the shifted range", () => {
    // Filter owns #n0..#n2/:v0..:v2 and kc owns one slot: shifting #n1→#n2
    // must not re-hit the slot #n2→#n3 just vacated (descending order), and
    // #n1 must not match inside #n10-style refs (boundary lookahead).
    const kc = {
      expression: "#n0 = :v0",
      expressionAttributeNames: { "#n0": "organizationId" },
      expressionAttributeValues: { ":v0": "org_1" },
    };
    const filter = {
      expression: "#n0 = :v0 AND #n1 = :v1 AND #n2 = :v2",
      expressionAttributeNames: { "#n0": "status", "#n1": "role", "#n2": "teamId" },
      expressionAttributeValues: { ":v0": "active", ":v1": "admin", ":v2": "team_9" },
    };

    const result = mergeKeyAndFilterExpressions(kc, filter);

    assertWellFormed(result);
    expect(keyBinding(result)).toEqual(["organizationId", "org_1"]);
    // Each filter binding must map to its own original value — no swaps.
    const bindings = [...result.filterExpression.matchAll(/(#n\d+) = (:v\d+)/g)].map(
      (m) => [result.names[m[1]], result.values[m[2]]],
    );
    expect(bindings).toEqual([
      ["status", "active"],
      ["role", "admin"],
      ["teamId", "team_9"],
    ]);
  });

  it("shifts refs past double-digit boundaries without prefix corruption", () => {
    // 11 kc names/values force shifted filter refs into #n11+/:v11+ — a plain
    // (non-boundary) regex would corrupt #n1 inside #n11.
    const kcNames: Record<string, string> = {};
    const kcValues: Record<string, any> = {};
    const kcParts: string[] = [];
    for (let i = 0; i < 11; i++) {
      kcNames[`#n${i}`] = `field${i}`;
      kcValues[`:v${i}`] = `value${i}`;
      kcParts.push(`#n${i} = :v${i}`);
    }
    const kc = {
      expression: kcParts.join(" AND "),
      expressionAttributeNames: kcNames,
      expressionAttributeValues: kcValues,
    };
    const filter = {
      expression: "#n0 = :v0 AND #n1 = :v1",
      expressionAttributeNames: { "#n0": "fStatus", "#n1": "fRole" },
      expressionAttributeValues: { ":v0": "on", ":v1": "member" },
    };

    const result = mergeKeyAndFilterExpressions(kc, filter);

    assertWellFormed(result);
    const bindings = [...result.filterExpression.matchAll(/(#n\d+) = (:v\d+)/g)].map(
      (m) => [result.names[m[1]], result.values[m[2]]],
    );
    expect(bindings).toEqual([
      ["fStatus", "on"],
      ["fRole", "member"],
    ]);
  });

  it("merges same-field filters under their own slots (duplicate field names are legal)", () => {
    const kc = {
      expression: "#n0 = :v0",
      expressionAttributeNames: { "#n0": "email" },
      expressionAttributeValues: { ":v0": "a@b.com" },
    };
    // Same field "email" also appears in the filter with a different value.
    const filter = {
      expression: "#n0 <> :v0 AND #n1 = :v1",
      expressionAttributeNames: { "#n0": "email", "#n1": "status" },
      expressionAttributeValues: { ":v0": "other@b.com", ":v1": "active" },
    };

    const result = mergeKeyAndFilterExpressions(kc, filter);

    assertWellFormed(result);
    expect(keyBinding(result)).toEqual(["email", "a@b.com"]);
    const ne = result.filterExpression.match(/(#n\d+) <> (:v\d+)/)!;
    expect(result.names[ne[1]]).toBe("email");
    expect(result.values[ne[2]]).toBe("other@b.com");
  });
});
