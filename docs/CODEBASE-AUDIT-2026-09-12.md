# Better Auth DynamoDB adapter audit

> Historical pre-fix audit. The implementation and dependency updates are tracked in [AUDIT-RESOLUTION-2026-09-12.md](AUDIT-RESOLUTION-2026-09-12.md); the original failure evidence below is retained.

The adapter has a useful structure and substantial unit coverage, but its current implementation has security and data-integrity defects that should be fixed before expanding its compatibility claims. The highest-priority finding is an expired-verification acceptance bug in the transactional consumption path. Predicate enforcement, email-claim maintenance, and transaction behavior also differ across methods. Updating dependencies alone does not correct these problems.

This assessment covers the working code for package version `1.1.0`, the installed Better Auth `1.6.14` implementation, and an isolated compatibility experiment using Better Auth `1.7.4` and current AWS SDK packages. Versions were verified against the npm registry on September 12, 2026. Production source, package.json, and the lockfile were not changed.

## Evidence and validation

| Validation | Installed dependencies | Latest-dependency experiment |
| --- | --- | --- |
| Existing unit suite | 614 passed, 41 files | 614 passed, 41 files |
| Typecheck | Passed | Passed |
| Build | Passed | Not separately run |
| Audit contract checks | 19 failed, 2 controls passed, 2 skipped | 21 failed, 2 controls passed |
| Better Auth | 1.6.14 | 1.7.4 |
| Vitest | 3.2.4 | 3.2.7 |

The audit checks assert desired behavior. Their failures demonstrate the defects described below; they are deliberately isolated from the normal test glob. The two skipped checks on 1.6.14 concern `incrementOne`, introduced in the newer contract. Passing controls verify ordinary predicate filtering and the existing atomic primary-key consume condition.

The checks execute actual adapter source, the actual Better Auth factory, and—where relevant—Better Auth's actual internal adapter. Only the DynamoDB network boundary is replaced with deterministic command doubles. That establishes returned values, generated commands, predicate omission, operation ordering, and controlled race behavior. It does not establish production throughput, real GSI propagation behavior, or exact service exception messages. DynamoDB Local integration tests were not run: no running local Docker daemon was available. Validation used Node `24.20.0`, not the CI Node 20/22 matrix.

Artifacts:

- [Runnable contract checks](audit-reproductions.mjs).
- [Explicit audit test configuration](audit-vitest.config.mjs).
- [Machine-readable versions and results](AUDIT-EVIDENCE-2026-09-12.json).

Run from the repository root:

```sh
npm run test:unit
npm run typecheck
npx vitest run --config docs/audit-vitest.config.mjs
```

The last command currently exits unsuccessfully by design. It is evidence for the audit, not a replacement release gate. As fixes land, move appropriate regression checks into the normal suite and replace command-shape checks with service-backed behavior tests where practical.

## Dependency assessment

| Package | Installed / declared minimum | Registry latest | Recommendation |
| --- | --- | --- | --- |
| `@aws-sdk/client-dynamodb` | 3.1063.0 | 3.1131.0 | Update alongside lib-dynamodb; verify with DynamoDB Local and a real-service smoke test. |
| `@aws-sdk/lib-dynamodb` | 3.1063.0 | 3.1131.0 | Update together with the client. Its latest peer requires client `^3.1131.0`. |
| `@aws-sdk/util-dynamodb` | 3.996.3 | 3.996.9 | Update if retaining the direct declaration; consider removing the unused direct peer/dev dependency. |
| `better-auth` | 1.6.14 | 1.7.4 | Address F01–F03/F12/F16 before claiming safe 1.7 support. |
| `@better-auth/test-utils` | 1.6.14 | 1.7.4 | Align with Better Auth when integrating its actual adapter suite. |

Registry sources: [client-dynamodb](https://registry.npmjs.org/@aws-sdk/client-dynamodb/latest), [lib-dynamodb](https://registry.npmjs.org/@aws-sdk/lib-dynamodb/latest), [util-dynamodb](https://registry.npmjs.org/@aws-sdk/util-dynamodb/latest), [Better Auth](https://registry.npmjs.org/better-auth/latest), and [test utilities](https://registry.npmjs.org/@better-auth/test-utils/latest). Search-result snippets were stale relative to the registry and were not used as the final version authority.

The latest three AWS packages declare Node `>=20.0.0`. Their versions do not all advance together: `util-dynamodb@3.996.9` is the current utility release, not an indication that a `3.1131.0` utility package is missing. The adapter has no direct import of `util-dynamodb`; lib-dynamodb already depends on it. Removing that direct peer would simplify consumer installation, but should be validated with the package consumer smoke test.

All existing caret ranges already admit these latest versions, including `better-auth@1.7.4` under `^1.6.14`. The checked-in lockfile supplies the older installed versions. CI deletes that lockfile and performs a fresh install, so CI and local development do not necessarily exercise the same dependency graph. The compatibility claim therefore already extends further than the current tests demonstrate. See [package.json](../package.json) and [CI](../.github/workflows/ci.yml).

The isolated experiment installed the exact five latest versions in `/tmp/dynamodb-better-auth-audit-latest`, with scripts disabled. Other allowed development and transitive dependencies resolved freshly too, including Vitest `3.2.7`. The 614 passing tests are useful compatibility evidence, but are not a controlled AWS-only comparison or proof of authentication correctness.

Better Auth's 1.7 upgrade guide specifically requires correct conditional writes and affected-row counts for atomic-method fallbacks. Native methods became optional again after 1.7.2; this does not remove the semantic requirements. The latest source uses `incrementOne` in database rate limiting, two-factor failure accounting, and organization counters. F16 reproduces the incompatibility. [Better Auth 1.7 upgrade guide](https://better-auth.com/docs/guides/1-7-upgrade-guide#custom-adapters-and-storage), [1.7.4 release](https://github.com/better-auth/better-auth/releases/tag/v1.7.4).

The updated test-utils package advertises Vitest 4/5 peers; this repository overrides its Vitest requirement to 3.x and does not actually invoke its adapter suite. Keeping that override and obtaining a green custom unit suite does not validate upstream test-kit compatibility. Integrate the test kit and upgrade Vitest/coverage together as a separate test-infrastructure change.

## Findings by priority

Priority means repair order, not a formal CVSS score. P0 identifies demonstrated authentication-validity failure. P1 covers integrity, predicate, and atomicity failures. P2 covers narrower contract or operational defects. F16 is specific to the newer dependency contract; the other failures also reproduce with installed dependencies.

| ID | Priority | Finding |
| --- | --- | --- |
| F01 | P0 | Transactional verification consumption can accept expired records. |
| F02 | P1 | Transactional delete ignores extra predicates when a primary key is present. |
| F03 | P1 | Conditional writes and indexed consumption are not atomically guarded by their predicates. |
| F04 | P1 | Email uniqueness is not maintained across ordinary update/delete and bulk paths. |
| F05 | P1 | An unchanged email cancels an otherwise valid transaction. |
| F06 | P1 | Query planner emits illegal GSI-key filter expressions. |
| F07 | P1 | Sparse-index hydration breaks filtering, ordering, and pagination semantics. |
| F08 | P1 | Transactional deleteMany silently skips rows already buffered for update. |
| F09 | P1 | Disabling bulk limits silently truncates transactional operations at 100. |
| F10 | P1 | Transactional updateMany leaves old TTL values in place. |
| F11 | P2 | TTL cleanup optimization suppresses legitimate reads and writes. |
| F12 | P1 | Null equality does not match missing nullable fields. |
| F13 | P2 | Scan budgets are checked after the complete fetch. |
| F14 | P2 | Transactional update returns untransformed fields and dates. |
| F15 | P2 | Case-insensitive query behavior varies by access path. |
| F16 | P1 | Better Auth 1.7 atomic increments lose updates; transaction method is missing. |
| F17 | P1 when hooks enforce invariants | Transaction writes bypass configured operation middleware. |

### F01 — Expired-verification acceptance

**Location:** [tx-consume-one.ts](../src/adapter/tx-consume-one.ts), line 82; [transaction.ts](../src/adapter/transaction.ts), transaction method construction.

`txConsumeOne` returns the raw DynamoDB row. Unlike ordinary factory-wrapped reads and consumption, it does not call `transformOutput`. Stored ISO date strings therefore remain strings. Better Auth's `consumeVerificationValue` retrieves a verification, consumes it inside a transaction, and checks `consumed.expiresAt < new Date()` afterward. An ISO string compared with a Date through `<` converts to `NaN`, so this comparison is false even when the timestamp is decades old.

The reproduction supplies a stored verification expiring in 2000 to the actual Better Auth internal adapter. An ordinary read hydrates the same expiry into a Date; transactional consumption instead returns the expired record. The same failure reproduces with 1.7.4. The installed magic-link implementation calls this internal consumption method and relies on its validity result. This establishes a security-relevant failure on that consumption path; it is not a claim that every authentication endpoint bypasses expiry. [Better Auth 1.6.14 internal adapter source](https://github.com/better-auth/better-auth/blob/v1.6.14/packages/better-auth/src/db/internal-adapter.ts).

**Fix:** Apply the framework output transformation before returning transaction consumption results, including logical field mapping. Add a real magic-link expiry test and transaction/non-transaction Date parity tests. Retain atomic deletion predicates. DynamoDB TTL is eventual cleanup, not an authorization check; the adapter's seven-day TTL grace also leaves a substantial period in which expired rows can remain stored. [AWS TTL documentation](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html).

### F02 — Transaction delete drops predicates

**Location:** [tx-delete.ts](../src/adapter/tx-delete.ts), line 42; [tx-key-builder.ts](../src/adapter/tx-key-builder.ts).

Given `id = u1 AND email = someone-else@example.test`, `tryBuildTxKey` extracts `id` and `txDelete` immediately buffers an unconditional delete. It never checks the additional predicate. This is a deterministic wrong-row deletion, requiring no concurrent writer. With email uniqueness enabled, an extra read can return null, but the primary-row delete is still buffered.

The key helper also does not account for OR semantics. The buffered-Put branch of `txUpdate` uses the same extracted-key shortcut and patches the row without evaluating additional conditions.

**Fix:** Evaluate the complete logical predicate and retain it at commit time. A full primary key identifies a candidate; it does not establish that the candidate satisfies the entire request. Check both ordinary and buffered rows.

### F03 — Check-then-write races

**Location:** [update.ts](../src/adapter/methods/update.ts), line 115; [update-many.ts](../src/adapter/methods/update-many.ts), `_updateOne`; [consume-one.ts](../src/adapter/methods/consume-one.ts), line 68; [tx-consume-one.ts](../src/adapter/tx-consume-one.ts), line 76.

Ordinary update checks extra conditions using a separate read and writes with only `attribute_exists(pk)`. Two concurrent `update(id=u1 AND name=Before)` calls both succeed, even though only one should retain the old-value predicate. Bulk update and transactional update have the same underlying omission.

Indexed `consumeOne` explicitly clears the condition filters after discovering the candidate. The subsequent delete is unconditional. Transactional consumption protects existence, but not the predicate or returned snapshot: the record may change after it was read and before it is deleted. The primary-key consume path already emits conditions for most supported predicates and provides a useful implementation starting point. Its suffix-filter precheck still has a race.

Ordinary delete and BatchWrite-backed deleteMany also do not retain predicates at deletion time. BatchWrite cannot attach per-item conditions or return deleted preimages; the number of acknowledged delete requests cannot prove how many rows still existed or matched. [AWS BatchWriteItem](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_BatchWriteItem.html).

**Fix:** Share a condition compiler across all mutation paths. Include the complete predicate in the actual write; for predicates requiring client evaluation, guard the relevant observed values or reject the unsupported atomic operation. Use conditional individual deletes where exact affected-row semantics are required.

### F04 — Incomplete email-claim lifecycle

**Location:** [update.ts](../src/adapter/methods/update.ts), [delete.ts](../src/adapter/methods/delete.ts), [email-uniqueness.ts](../src/email-uniqueness.ts), [README](../README.md), line 527.

Creation uses the sidecar claim, but ordinary update does not call the email-swap helper and ordinary deletion does not call the release helper. The audit observes only a direct Update/Delete command with uniqueness enabled. After changing A to B, A remains claimed and B is not newly claimed; updating to an existing user's email also lacks the uniqueness check. Deletion leaves the old email reserved. Bulk update/delete paths likewise do not maintain claims.

This is explicitly encoded as a known limitation in [adapter.test.ts](../test/adapter.test.ts), around line 602, while the README promises symmetric maintenance. Existing helper functions do not supply a guarantee if the public adapter never calls them.

Further source evidence: buffered create-then-update changes the user email without rewriting the buffered claim; old-email deletion lacks an ownership condition; concurrent distinct email changes can leave orphan claims; helpers hardcode user `id` rather than the configured key schema. These require separate concurrency and custom-key regressions.

**Fix:** Centralize user-plus-claim mutation planning and use it across all relevant methods. Condition the user update on the observed old email and claim release on the owning user. Until bulk semantics are implemented, reject uniqueness-changing bulk operations explicitly. Plan a reconciliation of existing sidecar data when deploying the repair; code changes cannot release already orphaned claims.

### F05 — Unchanged email generates duplicate targets

**Location:** [tx-update.ts](../src/adapter/tx-update.ts), email branch; [email-uniqueness.ts](../src/email-uniqueness.ts), `updateEmail` action builder.

Any supplied `email` activates the swap branch. If old and new emails normalize to the same value, it builds a Delete and Put on the same sidecar key. The adapter's duplicate-target guard rejects this valid user update. Case-only changes have the same problem.

**Fix:** Compare normalized email values before planning claim actions; preserve the claim on a no-op identity change. DynamoDB allows at most one transaction action per item, so disabling the duplicate guard would merely move the failure to the service. [AWS TransactWriteItems](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html).

### F06 — Invalid Query filters on index keys

**Location:** [query-planner.ts](../src/helpers/query-planner.ts), lines 271–287; [count.ts](../src/adapter/methods/count.ts), extra-predicate handling.

After consuming a GSI hash-key equality and at most one range condition, the planner puts every remaining clause into `FilterExpression`, including additional clauses on those same GSI key attributes. For example, `email = A AND email != B` becomes a Query whose filter references its partition key. Count independently follows a similar path and also leaves range-key conditions in filters.

AWS explicitly prohibits Query filter expressions from containing partition or sort key attributes. This is a service-contract violation established by inspecting the generated plan, not a service exception captured in this audit. [AWS Query API](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_Query.html).

**Fix:** Simplify redundant key predicates, combine compatible range bounds, or move residual key checks to a client stage. Route irreducible cases to a valid alternative. Share the planner with count so its legality rules cannot diverge.

### F07 — Sparse projections are hydrated too late

**Location:** [find-many.ts](../src/adapter/methods/find-many.ts), lines 143–156; [batch-get.ts](../src/helpers/batch-get.ts); [find-items.ts](../src/helpers/find-items.ts); [resolve-item.ts](../src/helpers/resolve-item.ts).

For a KEYS_ONLY or INCLUDE index, findMany sorts and slices the projected rows before fetching complete records. Sorting by an unprojected field compares undefined values. The reproduction asks for the alphabetically first name and gets Zoe instead of Amy. Separately, BatchGet results are returned in service order, so even correct native Query ordering can be lost. AWS does not guarantee BatchGet response order. [AWS BatchGetItem](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_BatchGetItem.html).

Projection awareness is also missing from filter planning: predicates on absent projected fields are sent to the index. Bulk/findMany suffix post-filters are applied before hydration, and count does not hydrate sparse results. Hydration alone cannot recover candidates that the index-side filter already discarded or could not evaluate. GSI queries cannot retrieve unprojected base-table fields. [AWS GSI projections](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.html).

**Fix:** Split predicates into index-evaluable and base-row predicates. Hydrate before evaluating unavailable fields, sorting on them, and applying logical offset/limit. Reorder hydrated rows by a composite-key lookup, and continue paging when vanished or rejected candidates underfill the requested limit. Include stale-index cases in service-backed tests.

### F08 — Delete coalescing changes the requested operation

**Location:** [tx-delete-many.ts](../src/adapter/tx-delete-many.ts), lines 68–87.

`alreadyTargeted` treats buffered Put, Update, ConditionCheck, and Delete actions as equivalent. A callback that updates an existing row and then deletes it through deleteMany reports a deletion count, but flushes only the update. The row survives. The special case intended to avoid deleting an already-consumed verification has expanded into silently dropping different operations.

**Fix:** Coalesce by explicit operation-transition rules. An Update followed by Delete should become a Delete; a matching previously buffered Delete may be deduplicated. Where a combination cannot be represented faithfully, reject it instead of reporting success.

### F09 — Zero bulk limit means partial success

**Location:** [tx-update-many.ts](../src/adapter/tx-update-many.ts), line 62; [tx-delete-many.ts](../src/adapter/tx-delete-many.ts), line 43; [find-many.ts](../src/adapter/methods/find-many.ts), default limit.

The documented value `0` disables the configurable item cap. Transaction handlers interpret it by omitting the fetch limit; raw findMany then applies its default of 100. A match set of 101 becomes exactly 100 writes, passes the capacity guard, commits, and returns 100. The intended behavior is to detect the oversized transaction and reject it before any partial commit.

**Fix:** Use a bounded fetch that retrieves enough candidates to prove transaction-capacity overflow, independently of configurable bulk policy. Never use an omitted argument to represent an unlimited fetch when the callee has a finite default.

### F10 — Bulk transaction refresh can leave premature TTL

**Location:** [tx-update-many.ts](../src/adapter/tx-update-many.ts), input transformation and update construction.

Ordinary updateMany and single transactional update derive a new numeric TTL from the updated expiry. Transactional updateMany does not call `withTtlAttribute`. Extending `expiresAt` leaves the previous TTL, allowing eventual deletion before the newly declared expiry when the extension exceeds the old grace window.

**Fix:** Apply identical TTL derivation to every write path. Define how clearing an optional expiry removes its old TTL; the current helper returns an unchanged patch for null/invalid expiry, which can also leave a stale TTL.

### F11 — Cleanup detection changes general query semantics

**Location:** [query-planner.ts](../src/helpers/query-planner.ts), lines 106–149; [count.ts](../src/adapter/methods/count.ts).

The planner treats any sole `ttlField < cutoff` or `<= cutoff` predicate as a cleanup request. It does not know which adapter operation is executing or validate that the cutoff represents elapsed expiry. All methods subsequently short-circuit. A read asking for records expiring before 2040 returns null even when a matching record expires in 2030. Count and updates can also silently report no matches.

**Fix:** Scope cleanup delegation to an explicit deletion policy instead of a universal query-plan flag. Preserve normal reads, counts, updates, and future-cutoff behavior. Document any deliberately weakened deleteMany cleanup count contract.

### F12 — Missing nullable attributes do not match null

**Location:** [where-converter.ts](../src/helpers/where-converter.ts), equality operators; [resolve-item.ts](../src/helpers/resolve-item.ts), `matchesClientFilters`.

An omitted nullable `image` does not match `image = null`: client filtering compares undefined and null strictly, while server expressions use direct equality against a DynamoDB NULL value. This already yields wrong read results and becomes more consequential for 1.7 snapshot-based atomic fallbacks, which guard missing scalar values as null.

**Fix:** Define a consistent null/missing truth table and implement it in server predicates and client filters. Null equality should account for missing nullable attributes. Validate negative comparisons, lists, and structured values separately instead of extending JavaScript strict equality implicitly. The current adapter guide explicitly calls out absent nullable values for fallback correctness. [Better Auth adapter contract](https://better-auth.com/docs/guides/create-a-db-adapter).

### F13 — Budgets do not bound the scan

**Location:** [find-many.ts](../src/adapter/methods/find-many.ts), lines 122–139 and 177–184; [fetch-all.ts](../src/helpers/fetch-all.ts).

The sort path fetches all pages before checking `maxScanItems`. The reproduction configures a cap of one and observes all five pages requested before the error. The check uses matched-item length rather than evaluated-item count, so a highly selective filter can scan a large table without exceeding it. Bulk item caps are also enforced only after discovery finishes.

**Fix:** Carry evaluated-item and retained-item budgets into pagination; check them per page and before requesting the next page. Distinguish a resource budget from a limit on matching rows. Keep result-count semantics separate from DynamoDB's evaluated-item Limit.

### F14 — Transaction update output differs from ordinary update

**Location:** [tx-update.ts](../src/adapter/tx-update.ts), lines 155 and 178.

Updates to existing rows return `{ ...preState, ...update }` directly. Date strings and physical field names escape the framework output transform. The buffered-Put branch does transform output, making the result depend on whether the row existed before the callback. The reproduction receives `updatedAt` as a string.

**Fix:** Transform every transaction result through the same output pipeline. Build returned values from the actual accepted patch; key fields stripped from the write must not appear as successfully changed in the return value.

### F15 — Unsupported query mode is not consistently rejected

**Location:** [query-planner.ts](../src/helpers/query-planner.ts), primary-key selection; [where-converter.ts](../src/helpers/where-converter.ts), mode validation.

The converter rejects `mode: insensitive`, but primary-key planning bypasses it and discards mode from residual client filters. Thus the same unsupported feature may throw on a scan and silently behave case-sensitively on a key lookup. The check verifies that an insensitive primary-key request resolves successfully instead of producing the documented unsupported-mode error.

**Fix:** Validate modes and operators before access-path selection. Either implement the mode consistently or reject it consistently. Literal-operator inventory tests cannot establish this property.

### F16 — Better Auth 1.7 atomic counter incompatibility

**Location:** [factory.ts](../src/adapter/factory.ts), native methods; [transaction.ts](../src/adapter/transaction.ts), transaction methods; [update-many.ts](../src/adapter/methods/update-many.ts).

The adapter does not supply native `incrementOne`. Better Auth 1.7.4 supplies a fallback that reads a snapshot and uses guarded updateMany. Because updateMany does not enforce that guard atomically, two concurrent increments both succeed but leave the counter at one instead of two. The audit reproduces this through the real 1.7.4 factory. This can affect consumers relying on the new counter API for security or membership limits.

The custom transaction object separately lacks `incrementOne` entirely, despite being used as the transaction adapter. Its pervasive `any` casts prevent the missing method from being caught by the passing typecheck.

**Fix:** Implement a native conditional atomic increment and compatible transaction behavior, or make the entire fallback prerequisite set correct first. Validate null/missing counters, conditional limits, negative deltas, no-op increments, and concurrent updates. Strengthen compile-time checks against the supported Better Auth adapter interfaces. Passing the existing shape ratchet is insufficient: method additions and atomicity are outside that ratchet's scope.

### F17 — Transaction writes bypass operation middleware

**Location:** [factory.ts](../src/adapter/factory.ts), middleware wrapping; [transaction.ts](../src/adapter/transaction.ts), direct calls to extracted transaction handlers.

Ordinary methods are wrapped with create/update/delete middleware. Transaction handlers bypass those wrapped write methods and run only transaction-level flush hooks. The reproduction configures `onBeforeCreate`, creates a user inside a transaction, and observes zero calls. Validation, normalization, or other invariants implemented in operation hooks therefore depend on which path Better Auth happens to use.

**Fix:** Apply operation hooks consistently while preserving commit semantics for after-hooks. Do not simply call the ordinary write method from the transaction, because that would write before commit. Also resolve the existing middleware composition issue: each before-hook receives original arguments rather than the previous hook's modified arguments.

## Implementation strengths and remaining design limits

The most maintainable parts are the shared expression-name handling, collision-free expression merging, key-schema lookup, and bounded batch sizes. Create guards prevent ordinary duplicate-key overwrites. Update guards prevent accidental upserts. Pagination continues through empty filtered pages. Batch retries surface exhausted unprocessed items rather than silently dropping them. Transaction cancellation reasons and duplicate targets are more informative than raw SDK failures.

The model-name reverse mapping repairs an important distinction between Better Auth logical models and configured DynamoDB tables. Normal date transformations work, and several past planner defects have meaningful regression coverage. These are reasons to repair the implementation rather than discard it.

However, the transaction abstraction is a write buffer, not a general database transaction. Reads do not see buffered writes, do not provide a transactional snapshot, and most repeated mutations cannot be represented directly. This limitation is documented in the README and was deliberately deferred in the earlier repair plan. It still restricts compatibility with hooks and plugins that expect read-your-writes. F08 is more severe than that documented limitation because it silently reports a write that never occurs.

Additional source-review concerns warrant targeted tests, but were not counted as independently reproduced findings:

- Transaction findMany omits select from its output transform and does not map sortBy fields through the factory helpers. Transaction joins also do not receive the ordinary factory's emulation pipeline.
- `helpersRef.current` and the registered model resolver are shared across invocations of the returned factory. Reusing one configured adapter factory for distinct Better Auth option sets can overwrite helpers needed by an earlier instance.
- Key, index, TTL, and email logic often hardcode physical field names. Custom field mappings need explicit end-to-end coverage; accepting a keySchemas configuration is not proof that custom-key CRUD works.
- The forgiving table Proxy synthesizes names for missing entries, including the email sidecar. It can bypass missing-table checks and defer a configuration mistake into a surprising table access.
- Numeric configuration such as `updateManyConcurrency` is not validated. Zero workers can return zero updates even with matching records.
- Empty or undefined-only transactional patches can build an invalid empty SET expression. `sanitizeForWrite` is described as deep but only transforms top-level values.
- A user-defined metrics callback can throw after a successful write, turning a committed operation into an apparent failure. Instrumentation behavior should be explicitly defined.
- The compiled CommonJS entry requires Better Auth ESM. The declared broad Node 20 floor should be verified on the oldest supported Node patch, rather than inferred from tests on modern Node releases.

No claim is made that these additional cases all occur in Better Auth core's default flows. They identify exposed configurations or extension paths that the existing compatibility story leaves unverified.

## Test and release strategy

The 614 tests cover many helpers but do not adequately validate the composition of the adapter, framework, and database. `@better-auth/test-utils` is installed but `testAdapter`/`createTestSuite` are not invoked. The integration suite is custom, has no complete authentication-endpoint coverage, and even preserves the broken email-release behavior as an expectation. Its purported custom-PK CRUD test only checks configuration acceptance. These gaps explain how the expired-consumption and atomic-counter failures coexist with a green suite.

The older [code review](CODE-REVIEW-2026-07-05.md) and [repair plan](PLAN-adapter-contract-fixes.md) overlap with several remaining problems. Their presence was not treated as proof of either a defect or a fix. Current source and executable checks determine the findings here. In particular, transaction read transforms improved, but consumption and existing-row update outputs remain inconsistent; duplicate-target rejection improved diagnostics without making same-email updates correct.

Recommended repair sequence:

1. Fix F01 and transaction output parity immediately. Add expired/fresh single-use verification tests through the actual magic-link flow, including concurrent consumption.
2. Centralize atomic predicate enforcement and correct transaction operation transitions. Cover false predicates, races, exact counts, and commit failure behavior.
3. Repair email-claim lifecycle across methods and reconcile existing claims. Cover same-email changes, two competing changes, deletion/re-registration, and buffered creation followed by email changes.
4. Correct sparse-projection planning, hydration, ordering, null semantics, and in-loop budgets. Validate against DynamoDB Local and a small isolated AWS test table.
5. Add native increment support and transaction contract checks for Better Auth 1.7; then update the Better Auth package set and its test utilities together.
6. Update the AWS client/lib pair, refresh the lockfile, and test the packed artifact in a consumer. Keep reproducible lockfile CI and add a separate latest-compatible-dependencies job instead of deleting the lockfile in every job.

The upstream adapter test kit will require resolving deliberate deviations such as empty-where deleteMany, which currently throws outside a transaction and returns zero inside one. Do not weaken assertions simply to preserve existing adapter behavior. Define supported semantics, document explicit constraints, and test them at the public adapter boundary.

## Primary references

- [Better Auth adapter guide](https://better-auth.com/docs/guides/create-a-db-adapter): adapter methods, transformations, atomic fallback requirements, and test-kit entry points.
- [Better Auth 1.7 upgrade guide](https://better-auth.com/docs/guides/1-7-upgrade-guide): custom adapter changes and atomic-method requirements.
- [Better Auth v1.6.14 internal adapter](https://github.com/better-auth/better-auth/blob/v1.6.14/packages/better-auth/src/db/internal-adapter.ts): verification consumption and expiry comparison; checked against the installed distribution.
- [Better Auth v1.7.4 release](https://github.com/better-auth/better-auth/releases/tag/v1.7.4): current stable release, dated September 10, 2026; installed distribution supplied the exact new fallback implementation used in the checks.
- [AWS Query](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_Query.html): evaluated-item limits, pagination, key filters, and index consistency.
- [AWS GSI guide](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.html): sparse projections and base-table attributes.
- [AWS BatchGetItem](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_BatchGetItem.html): unordered responses and retries.
- [AWS BatchWriteItem](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_BatchWriteItem.html): lack of conditional item writes and deleted preimages.
- [AWS TransactWriteItems](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html): action limits and duplicate-target restrictions.
- [AWS TTL](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html): numeric expiry timestamps and asynchronous deletion.

All upstream references were checked on September 12, 2026. Repository code links point to the audited working tree; the companion evidence file records dependency versions and concise outcomes so that subsequent source or dependency changes can be compared with this assessment.
