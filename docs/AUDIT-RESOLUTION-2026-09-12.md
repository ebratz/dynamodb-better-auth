# DynamoDB adapter updates and audit resolution

Implemented on 2026-09-12 following the [codebase audit](CODEBASE-AUDIT-2026-09-12.md). The original [failure evidence](AUDIT-EVIDENCE-2026-09-12.json) is retained as a historical baseline. Its failures do not describe the current working tree.

## Dependency updates

| Package | Previous | Updated |
| --- | --- | --- |
| better-auth | 1.6.14 | 1.7.4 |
| @better-auth/test-utils | 1.6.14 | 1.7.4 |
| @aws-sdk/client-dynamodb | 3.1063.0 | 3.1131.0 |
| @aws-sdk/lib-dynamodb | 3.1063.0 | 3.1131.0 |
| @aws-sdk/util-dynamodb | 3.996.3 | 3.996.9 |
| vitest / @vitest/coverage-v8 | 3.2.4 | 4.1.11 |

The incompatible Vitest peer override was removed. The lockfile was regenerated without `--legacy-peer-deps`; `npm ls --depth=0` reports a valid dependency tree. Peer dependency minimums now match the tested Better Auth/AWS baseline. Node.js requires 20.19.0 or newer, reflecting the CommonJS entry's ESM dependency loading and the updated test runner.

CI now uses `npm ci` with the committed lockfile and includes Node 20, 22, and 24. The integration job delegates table creation to the tests instead of maintaining duplicate AWS CLI table definitions. These are workflow changes; remote CI was not run during this local task.

## Repairs

All 23 original audit checks pass and are included in the regular unit suite through `test/audit-regressions.test.mjs`.

| Audit findings | Implemented repair |
| --- | --- |
| F01, F14: transaction output and expiry | Transaction update/consume results pass through Better Auth's output transforms. Dates retain their expected runtime type, and stripped key assignments are excluded from returned updates. |
| F02–F03: mutation predicates and races | Conditional write expressions recheck predicates at the write boundary. Transactions guard captured snapshots. Bulk deletes use conditional DeleteItem preimages for accurate affected-row counts. |
| F04–F05: email claims | User mutations update/release sidecar claims atomically; release checks ownership; unchanged normalized emails produce no duplicate transaction target. Bulk email changes with uniqueness enabled fail explicitly. |
| F06–F07: index expressions and hydration | Index-key predicates that cannot be server filters become post-filters. Sparse projections are hydrated before filtering, sorting, or limiting; BatchGet results retain requested order. Count uses the same planner rules. |
| F08–F09: buffered bulk operations | Update-then-bulk-delete replaces the pending update. Disabling a bulk item cap does not silently truncate transaction discovery at 100 rows; the transaction action limit remains explicit. |
| F10–F11: TTL | Transaction bulk updates refresh derived TTL. Expiry sweep deferral is confined to non-transactional deleteMany cleanup; ordinary query semantics are preserved. |
| F12: nullable predicates | Null equality matches omitted nullable attributes as well as stored DynamoDB NULL, consistently across server and client evaluation. |
| F13: scan budgets | Paginated findMany/bulk discovery checks evaluated-item counts after each page before requesting another. Sparse hydration follows the same discovery budget. |
| F15: unsupported modes | Unsupported query modes are validated before primary-key/index routing. |
| F16: atomic counters | Native incrementOne uses guarded optimistic updates with a five-attempt contention budget. Transaction adapters expose incrementOne and guard its buffered update. |
| F17: middleware | Transaction mutations run operation hooks. Before-hooks compose modified arguments; mutation after-hooks run after successful commit. |

Better Auth's own suites exposed two further defects that are now fixed: findMany field selection, including physical field mappings, and transaction reads after buffered creates. Transaction findOne/findMany/count now overlay buffered puts, updates, and deletes before filtering, sorting, and pagination. Transaction selection and sort fields also use factory mappings.

Additional reproduced fixes cover factory reuse leaking another Better Auth instance's transforms, nonpositive/fractional bulk concurrency, metrics callbacks masking committed writes or database failures, nested Date serialization, undefined assignments, clearing a nullable TTL expiry, and empty-array transaction bulk cleanup. UUID generation now uses Node's cryptographic implementation directly on the supported runtime baseline.

## Validation

Local environment: Node 24.20.0, DynamoDB Local 1.25.1, temporary in-memory database, fake credentials. No production AWS tables were used. The temporary server was stopped after validation.

| Check | Result |
| --- | --- |
| Unit suite, including audit regressions | **645 passed**, 43 files |
| DynamoDB Local integration | **147 passed**, 2 files |
| Better Auth upstream suites included above | Normal adapter, authentication flow, transaction rollback; 118 Vitest tests including suite setup checks |
| TypeScript typecheck and production build | Passed |
| Source-only statement coverage | **87.42%**; required 85% |
| Source-only branch coverage | **76.93%**; required 75% |
| Source-only function coverage | **90.86%**; required 80% |
| Source-only line coverage | **90.41%**; required 85% |
| Clean consumer installed from npm tarball | CommonJS and ESM imports passed; adapter construction exposes required methods |
| npm audit, updated lockfile | **0 reported vulnerabilities** |
| git diff --check | Passed |

The real-database regressions include concurrent guarded bulk updates, concurrent counter increments without lost updates, transaction update/delete visibility and counts, selected transaction fields, and expired verification Date output. The upstream authentication suite also exercises password reset with a single-use token. Coverage includes only `src/**/*.ts`, excluding the audit test implementation itself.

Run locally with DynamoDB Local listening on port 8001:

```sh
npm ci
npm run typecheck
npm run test:coverage
npm run test:integration
npm run build
```

## Remaining limits

Transactions still buffer writes for one TransactWriteItems request. Read overlays provide visibility of pending writes but not snapshot isolation from concurrent database activity. Reading a table with pending writes may scan it within maxScanItems. Repeated mutations of one item remain restricted; only explicitly coalesced combinations are supported, and write handlers generally resolve database pre-state. Transaction joins do not implement the ordinary factory's complete join emulation pipeline.

Bulk operations outside a transaction can partially commit on failure. Conditional per-row deletion costs more requests than the former unguarded BatchWrite path. The explicitly opt-in unsafeBatchUpdate path retains its documented whole-row, last-writer-wins behavior. Atomic increment can throw on sustained contention after its bounded retries.

Case-insensitive queries remain unsupported; the dedicated upstream case-insensitive suite was therefore not selected. Numeric IDs and arbitrary renaming of DynamoDB primary-key/email-claim fields are not newly claimed compatibility guarantees. Node 20/22 execution is configured in CI but was not locally exercised. DynamoDB Local cannot establish production GSI propagation timing, regional failures, or real provisioned-capacity throttling.

At the end of the September 12 implementation validation, the package version was still 1.1.0 and the changes were uncommitted. The subsequent release is tracked in the repository changelog and GitHub releases.
