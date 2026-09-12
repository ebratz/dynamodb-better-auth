/**
 * Shape ratchet (ports §8.3.3 of
 * app.ebratz.com `docs/build/12-better-auth-dynamodb-adapter-fix.md`).
 *
 * Re-derives Better Auth's where-clause shape inventory from the **installed
 * dist** on every run, so a dependency bump fails CI instead of a production
 * sign-in. `test/where-converter.test.ts` pins the operators the adapter
 * supports from the inside; this file pins the operators Better Auth actually
 * issues from the outside. The incident the source document describes fell
 * through the gap between those two views, because the adapter's own test
 * suite never saw the new shape.
 *
 * What this ratchet asserts, against `better-auth/dist` + `@better-auth/core/dist`:
 *   1. Every literal `operator: "..."` is one the adapter implements.
 *   2. Every expression-built `operator: <expr>` sits in a plugin allowlist
 *      (admin / organization — request-controlled search/filter operators).
 *      A new one anywhere else fails with `file:line`.
 *   3. Every `field: "expiresAt"` occurrence is in the known sweep file.
 *
 * If the installed dist is absent (deps not installed) the suite is skipped.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

const DIST_DIRS = [
  path.join(ROOT, "node_modules/better-auth/dist"),
  path.join(ROOT, "node_modules/@better-auth/core/dist"),
];

/** Operators the adapter implements (see src/helpers/where-converter.ts). */
const SUPPORTED_OPERATORS = new Set([
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "in",
  "not_in",
  "contains",
  "starts_with",
  "ends_with",
]);

/**
 * Files allowed to build an operator from an expression rather than a
 * literal. Both are request-controlled (`ctx.query.searchOperator` /
 * `filterOperator`) and belong to plugins this adapter does not mount;
 * mounting either one requires a deliberate decision about that operator.
 */
const EXPRESSION_OPERATOR_ALLOWLIST = [
  "better-auth/dist/plugins/organization/",
  "better-auth/dist/plugins/admin/",
];

/** Files allowed to contain a `field: "expiresAt"` clause. */
const EXPIRES_AT_ALLOWLIST = ["better-auth/dist/db/internal-adapter.mjs"];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (entry.endsWith(".mjs") || entry.endsWith(".js")) {
      // Type declarations describe the shape but do not execute.
      if (!entry.includes(".d.")) out.push(full);
    }
  }
  return out;
}

function rel(file: string): string {
  return path.relative(ROOT, file).split(path.sep).join("/");
}

interface Hit {
  value: string;
  file: string;
  line: number;
}

function collect(files: string[], regex: RegExp): Hit[] {
  const hits: Hit[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const lines = source.split("\n");
    lines.forEach((line, idx) => {
      // Fresh regex per line so lastIndex never leaks between lines.
      const re = new RegExp(regex.source, regex.flags);
      let match: RegExpExecArray | null;
      while ((match = re.exec(line)) !== null) {
        hits.push({ value: match[1] ?? "", file, line: idx + 1 });
      }
    });
  }
  return hits;
}

const FILES = DIST_DIRS.flatMap((dir) => walk(dir));
const HAS_DIST = FILES.length > 0;

const literalOperators = collect(FILES, /operator:\s*"([^"]+)"/g);
const expressionOperators = collect(FILES, /operator:\s*([^"\s][^,\n}]*)/g);
const expiresAtFields = collect(FILES, /field:\s*"expiresAt"/g);

describe.skipIf(!HAS_DIST)("Better Auth installed-dist shape ratchet", () => {
  it("only issues literal operators the adapter implements", () => {
    const unknown = literalOperators
      .filter((h) => !SUPPORTED_OPERATORS.has(h.value))
      .map((h) => `${rel(h.file)}:${h.line} → operator: "${h.value}"`);

    expect(unknown, `Unknown operators in installed dist:\n${unknown.join("\n")}`).toEqual([]);
  });

  it("only builds operators from expressions inside the allowlisted plugins", () => {
    const outside = expressionOperators
      .filter(
        (h) =>
          !EXPRESSION_OPERATOR_ALLOWLIST.some((prefix) => rel(h.file).includes(prefix)),
      )
      .map((h) => `${rel(h.file)}:${h.line} → operator: ${h.value.trim()}`);

    expect(
      outside,
      `Expression-built operators outside the allowlist:\n${outside.join("\n")}`,
    ).toEqual([]);
  });

  it("only sweeps expiresAt from the known internal-adapter sites", () => {
    const outside = expiresAtFields
      .filter((h) => !EXPIRES_AT_ALLOWLIST.some((prefix) => rel(h.file).includes(prefix)))
      .map((h) => `${rel(h.file)}:${h.line}`);

    expect(
      outside,
      `expiresAt clauses outside the allowlist:\n${outside.join("\n")}`,
    ).toEqual([]);
  });
});
