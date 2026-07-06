# Code Review — `@ebratz/dynamodb-better-auth` v0.1.6

**Date:** 2026-07-05
**Scope:** Full `src/` review (adapter methods, query planner, expression building, transactions, email-uniqueness plugin, config/infra) plus contract verification against the installed `better-auth@1.6.x` / `@better-auth/core` sources.
**Method:** Line-by-line review of every source file by a lead reviewer, plus five parallel specialist review passes (CRUD methods, query layer, transaction layer, infra/plugin, better-auth contract compliance). Findings were cross-verified against better-auth's reference adapters (`@better-auth/memory-adapter`, `@better-auth/kysely-adapter`) and `createAdapterFactory` (`@better-auth/core/dist/db/adapter/factory.mjs`); several CRUD findings were additionally confirmed with temporary executable repro tests against the real source (mocked DocumentClient, real adapter code; repro files deleted afterwards). Unit suite baseline: 539 passed / 25 skipped; the one failing file only needs DynamoDB Local on port 8001.

Line numbers refer to `main` at commit `0313fde`.

---

## Summary

| # | Severity | Finding | File |
|---|----------|---------|------|
| 1 | 🔴 Critical | Incomplete Tier-1 plans fall into an **unfiltered** Scan — `update`/`delete` mutate an arbitrary wrong row | `resolve-item.ts`, `update.ts`, `delete.ts` |
| 2 | 🔴 Critical | `updateMany` with a PK-equality where clause degrades to a full unfiltered table Scan — updates **every row** | `update-many.ts`, `find-items.ts` |
| 3 | 🔴 Critical | `Limit: 1` + `FilterExpression` never paginated — false "not found" in findOne/update/delete/consumeOne | `resolve-item.ts` |
| 4 | 🔴 Critical | Email uniqueness unenforced on non-tx `update`/`delete` — orphaned & stale email claims | `methods/*`, `email-uniqueness.ts` |
| 5 | 🔴 Critical | Transaction adapter hands better-auth raw methods — reads bypass all framework transforms; no read-your-writes | `transaction.ts` |
| 6 | 🔴 Critical | Tier-2 `findMany` truncates to `limit` **before** client-side sort — breaks better-auth's verification-token flow | `find-many.ts` |
| 7 | 🟠 High | Middleware before/after hooks silently discard mutations; `onBeforeCreate` JSDoc contradicts implementation | `apply-middleware.ts` |
| 8 | 🟠 High | `in`/`not_in` with an empty array emits invalid `IN ()` — `ValidationException` crash | `where-converter.ts` |
| 9 | 🟠 High | `txUpdateMany`/`txDeleteMany` silently capped at 100 rows by `findMany`'s default limit | `tx-update-many.ts`, `tx-delete-many.ts` |
| 10 | 🟠 High | `tx.update` email-uniqueness branch fires on *unchanged* email — Delete+Put on the same key kills the transaction | `tx-update.ts`, `email-uniqueness.ts` |
| 11 | 🟠 High | `txUpdateMany` Update actions lack `ConditionExpression` — TOCTOU can resurrect deleted rows as corrupt partial items | `tx-update-many.ts` |
| 12 | 🟠 High | OR connectors ignored by tier selection; duplicate same-field clauses silently dropped | `query-planner.ts`, `where-converter.ts` |
| 13 | 🟠 High | `Date` where-values are never sanitized — marshaller crash on tx-path and direct reads | `where-converter.ts` |
| 14 | 🟠 High | `{ include: [...] }` GSI projections treated like `ALL` — truncated records returned to better-auth | `query-planner.ts` |
| 15 | 🟠 High | `ends_with` throws, but it's a first-class better-auth operator used by the admin plugin's user search | `where-converter.ts` |
| 16 | 🟠 High | `consumeOne` / `deleteMany` Tier-1 paths ignore extra where clauses — fail-open consume, over-deletion | `consume-one.ts`, `find-items.ts` |
| 17 | 🟠 High | Composite-key model queried by PK only → `GetItem` with a partial key → `ValidationException` on real DynamoDB | `find-one.ts`, `find-many.ts`, `query-planner.ts` |
| 18 | 🟡 Medium | `txUpdate` on a missing row returns a fabricated record and poisons the whole transaction | `tx-update.ts` |
| 19 | 🟡 Medium | Transaction capacity guard off-by-N on email-uniqueness paths (asserts 1, pushes 2–3) | `tx-*.ts`, `assert-capacity.ts` |
| 20 | 🟡 Medium | Silent partial results after retry exhaustion (`deleteMany`, `updateMany` batch, KEYS_ONLY batch-get) | `delete-many.ts`, `update-many.ts`, `batch-get.ts` |
| 21 | 🟡 Medium | Three files interpret the `indexes` config shape three different ways | `query-planner.ts`, `count.ts`, `find-many.ts` |
| 22 | 🟡 Medium | "Forgiving tables" Proxy defeats `UNKNOWN_MODEL` and the email-uniqueness `MISSING_TABLE` guards | `factory.ts` |
| 23 | 🟡 Medium | All `TransactionCanceledException` reasons collapse into one error; concurrent `consumeOne` fails the whole tx | `transaction.ts`, `tx-consume-one.ts` |
| 24 | 🟡 Medium | No guard against two buffered tx actions targeting the same item — opaque `ValidationException` at flush | `transaction.ts` |
| 25 | 🟡 Medium | Two comparisons on the same GSI range key produce an invalid `KeyConditionExpression` | `query-planner.ts` |
| 26 | 🟡 Medium | Built-in `rateLimit` model defaults to `pkField: "id"` but is always queried by `key` — full Scan per request | `key-builder.ts`, `validate-config.ts` |
| 27 | 🟡 Medium | Email-uniqueness hardcodes `"id"` as the user PK, ignoring `keySchemas` overrides | `email-uniqueness.ts` |
| 28 | 🟡 Medium | `matchesClientFilters` gaps: no `between`, string-only `contains`, connectors ignored, unknown ops fail closed | `resolve-item.ts` |
| 29 | 🟢 Low | Tier-2 `offset` throws; Tier-1 `findMany` ignores `offset` entirely | `find-many.ts` |
| 30 | 🟢 Low | `updateUserEmailWithUniqueness`: duplicate `email` SET clause; old-email Delete lacks ownership condition | `email-uniqueness.ts` |
| 31 | 🟢 Low | Tier-3 no-sortBy branch has no cap on offset-driven scan cost | `find-many.ts` |
| 32 | 🟢 Low | `create` on a composite-key model doesn't validate SK presence — opaque `DYNAMODB_ERROR` | `create.ts` |
| 33 | 🟢 Low | `validateConfig` doesn't detect colliding table names across models | `validate-config.ts` |
| 34 | 🟢 Low | Public API omits `DynamoAdapterMiddleware` / `AdapterLogger` / `WhereClause` types | `index.ts` |

---

## Critical

### 1. Incomplete Tier-1 plans fall into an **unfiltered** Scan — `update`/`delete` mutate an arbitrary wrong row

**Files:** `src/adapter/methods/update.ts:51-73`, `src/adapter/methods/delete.ts:39-64`; root cause `src/helpers/resolve-item.ts:27-84`

When `resolveQueryPlan` returns a Tier-1 (`getItem`) plan that is *incomplete* —
either the where clause has an extra non-key field (`needsClientSideFilter:
true`) or a composite-key model is missing its SK — `update()`/`delete()` fall
back to `resolveItemByPlan`. That helper only special-cases `plan.tier === 2`;
a Tier-1 plan falls through to the **Scan branch**, which reads
`plan.filterExpression` / expression maps — fields a Tier-1 plan never populates
(it carries `key` + `clientSideFilters` instead). The result is a
`ScanCommand({ TableName, Limit: 1 })` with **no filter whatsoever**: "return
whatever the first item in the table happens to be." The method then extracts
that item's key and updates/deletes **it**.

**Failure scenario** (confirmed with an executable repro against the real
source): `update({ model: "user", where: [{id eq "u1"}, {banned eq false}],
update: { name: "X" } })` → unfiltered Scan returns some unrelated first row →
that user gets renamed; `u1` is untouched; the caller receives the wrong row
back as an apparent success. The same path deletes the wrong row for
`delete()`. Also triggered for composite-key models (`account`) queried with PK
but no SK.

**Fix:** in `update`/`delete`, handle incomplete Tier-1 plans with a
`GetCommand` on `plan.key` + `matchesClientFilters` (exactly what `find-one.ts`
does), and make `resolveItemByPlan` throw if handed a Tier-1 plan.

---

### 2. `updateMany` with a PK-equality where clause updates **every row in the table**

**File:** `src/adapter/methods/update-many.ts:57`; root cause `src/helpers/find-items.ts:52-90` + `src/helpers/fetch-all.ts:80-99`

`updateMany` calls `findAllItems(...)` **without** `includeTier1: true`. For a
where clause that resolves to Tier 1 (e.g. `[{id eq "u1"}]`), the Tier-1 branch
is skipped, the `"query"` branch doesn't match, and the plan is handed to
`fetchAllByPlan`, which treats everything non-`"query"` as a **Scan**. Tier-1
plans have empty filter/expression fields → an **unfiltered full-table Scan** →
an `UpdateCommand` for *every row in the table*.

**Failure scenario** (confirmed with an executable repro):
`updateMany({ model: "user", where: [{id eq "u1"}], update: { banned: true } })`
returns count 3 on a 3-row table — **all** users banned, not just `u1`.

**Fix:** pass `includeTier1: true` (as `delete-many.ts` already does), make the
Tier-1 branch apply `clientSideFilters` (finding 16), and add a
`plan.operation === "scan"` assertion in `fetchAllByPlan`'s scan branch so a
`getItem` plan can never silently become a table scan again.

---

### 3. `resolveItemByPlan` uses `Limit: 1` with a `FilterExpression` and never paginates

**File:** `src/helpers/resolve-item.ts:35-83`
**Consumers:** `findOne` (Tier 2/3), `update`/`delete` (Tier 2/3), `consumeOne` (Tier 2)

DynamoDB applies `Limit` to items **evaluated**, *before* the filter runs. With
`Limit: 1`, exactly one item is examined; if it fails the filter the page is
empty even though `LastEvaluatedKey` points at more data — and the helper never
loops. Confirmed with an executable repro (single `QueryCommand` issued, `null`
returned despite matching items on later pages).

- **Tier 3 (Scan + filter):** unless the matching row is *physically first* in
  scan order, `findOne` returns `null` for a row that exists. A `user` table
  with no email GSI makes `signInEmail` effectively always fail once the table
  has more than a handful of rows.
- **Tier 2 (Query + residual filter):** e.g.
  `findOne({model:"session", where:[{userId eq "u1"}, {revoked eq false}]})` —
  if the first session in the partition is revoked, an existing valid session is
  reported as not found.

The unit suite doesn't catch this because the mocked DocumentClient bakes in the
wrong (filter-then-limit) assumption — `test/resolve-item.test.ts:256` even
asserts `Limit === 1` as desired behavior.

**Fix:** paginate on `LastEvaluatedKey` until an item passes or pages are
exhausted (reuse `fetchAllByPlan` with `limit: 1`, which already loops
correctly), bounded by `maxScanItems`.

---

### 4. Email uniqueness is only enforced on `create` and transactional paths

**Files:** `src/adapter/methods/update.ts`, `update-many.ts`, `delete.ts`, `delete-many.ts`; `src/email-uniqueness.ts:140,178`

`updateUserEmailWithUniqueness()` and `deleteUserWithEmailRelease()` are
implemented and exported but **never called** (zero call sites outside their own
module). Only `create.ts` and the `tx-*` handlers touch `EmailLookups`. Traced
against the installed better-auth dist:

- `/change-email` and the verify-email confirmation callback resolve through
  `updateWithHooks` → plain `adapter.update()` — **never a transaction**. The
  old email stays claimed forever (nobody can ever register it) and the new
  email is never claimed (a second user can take it — the uniqueness invariant
  silently evaporates).
- `/delete-user` → `internalAdapter.deleteUser()` → plain `adapter.delete()` —
  every self-service account deletion permanently orphans the user's
  `EmailLookups` row.
- OAuth account linking's `overrideUserInfo` also updates `email` via the plain
  path. Only OAuth *signup* (`createOAuthUser`) is protected, because it happens
  to run inside `runWithTransaction`.

**Fix:** route `update`/`updateMany`/`delete`/`deleteMany` on `model === "user"`
through the existing (currently dead) helpers when `enableEmailUniqueness` is
on, mirroring `create.ts`. Add integration tests that exercise the *plain*
methods, since that's what better-auth actually calls.

---

### 5. Transaction adapter hands better-auth raw methods — reads bypass every framework transform

**File:** `src/adapter/transaction.ts:96-109`; contract: `@better-auth/core/dist/db/adapter/factory.mjs:400-409`, `index.d.mts` (`DBTransactionAdapter = Omit<DBAdapter, "transaction">`), `@better-auth/core/dist/context/transaction.mjs`

better-auth passes the user callback **directly** to `config.transaction(cb)`;
its own fallback (`createAsIsTransaction(adapter)`) hands the callback the
**framework-level adapter** (where transforms, field/model-name mapping, and
output transforms are applied per call). That is the contract. Moreover,
`runWithTransaction(adapter, fn)` wraps *entire request flows* — the whole
`/sign-up/email` route — and installs the `trx` object as the **ambient adapter
for every DB call in that flow** via AsyncLocalStorage.

This adapter's `txAdapter` instead exposes **raw native methods** for
`findOne`/`findMany`/`count`, and `buildTxKey` matches raw `where[].field`
against logical key names. Consequences (all reachable from stock sign-up
whenever `client` is set — exactly when `transaction` is enabled):

1. **Reads return untransformed rows** — `customTransformOutput` never runs, so
   date fields come back as ISO strings, not `Date`s; custom
   `fieldName`/`modelName`/`usePlural` mappings aren't applied — "works
   everywhere except inside transactions."
2. **Raw `Date` where-values reach the marshaller** (see finding 13) and throw
   `Unsupported type passed`.
3. **No read-your-writes** — `create` buffers the Put; a subsequent
   `findOne`/`findMany`/`count` in the same flow reads DynamoDB directly and
   sees nothing (`updateMany` after a buffered create silently reports count 0).

**Fix:** thread the factory's where/output transforms through
`TransactionFactoryHelpers` and apply them on every tx read and key-resolution
path (only `transformInput`/`transformOutput`/`getDefaultModelName` are threaded
today); consider an in-memory overlay of buffered writes for Tier-1 reads.
Until parity is reached, shipping `transaction: false` is the *safer* default —
better-auth then falls back to its as-is transaction, which is non-atomic but
correct.

---

### 6. Tier-2 `findMany` truncates to `limit` *before* client-side sort — breaks the verification-token flow

**File:** `src/adapter/methods/find-many.ts:82-119` (+ broken `findGsiRangeKey` at `212-225`)

Two compounding bugs:

- **Truncate-before-sort:** when `sortBy.field` ≠ the GSI range key,
  `fetchAllByPlan` is still called with the caller's `limit`, fetching only
  `limit` items in *GSI-native order*, then sorting that truncated subset. The
  correct fetch-all-then-sort-then-slice fix exists in Tier 3 ("Gap D",
  lines 131-177) but was never ported to Tier 2. Confirmed by repro: with 6
  sessions and `sortBy: lastActiveAt desc, limit: 2`, the true top-2 are never
  fetched.
- **`findGsiRangeKey` never matches:** `config.indexes` is
  `Record<model, Record<fieldName, GsiDeclaration>>` (types.ts:54), but the
  helper iterates a level too deep (`Object.values(fieldIndexes)`), comparing
  `("someString").indexName` — always `undefined`. So `needsClientSort` is
  `true` whenever `sortBy` is set; the native `ScanIndexForward` path is
  unreachable and the "sorting client-side" warning always fires.

**Failure scenario in a core auth flow:** the README's own recommended setup
(`verification: { identifier: { indexName: "identifier-index", hashKey:
"identifier" } }`, no range key) plus better-auth's verification consumption
(`internal-adapter.mjs`: `findMany({model:"verification", where:[identifier],
sortBy:{createdAt desc}, limit:1})` — used by email verification, magic link,
password reset, email OTP). The adapter fetches **one arbitrary row** from the
GSI and returns it as "the latest token". A user who requests two OTPs in a row
can have the stale one treated as current. (This call also runs inside the
transaction scope — see finding 5 — via the raw `findMany`.)

**Fix:** fix `findGsiRangeKey` to iterate one level (`Object.values(modelIndexes)`);
when `needsClientSort` is true, fetch **all** matching items (bounded by
`maxScanItems`, like Tier 3), sort, then slice; only set `ScanIndexForward` from
`sortBy.direction` when `sortBy.field` *is* the range key.

---

## High

### 7. Middleware before/after hooks silently discard mutations

**File:** `src/helpers/apply-middleware.ts:48-69`; JSDoc contract `src/types.ts:158-159`

1. Every before-hook is called with the **original** `args` (line 54), never the
   accumulated `modifiedArgs`, and the patch merge is **top-level** (line 56) —
   with two extensions on the same hook, the second's `{ update: {...} }`
   wholesale replaces the first's. Only the last extension survives.
2. `onBeforeCreate`'s JSDoc says "return modified data to replace `args.data`",
   but the implementation requires `{ data: {...} }`. A hook returning the raw
   data object has its fields merged as *siblings* of `data` — silently dropped
   even with a single extension. (A multi-tenancy extension stamping `tenantId`
   per the JSDoc writes every row **without** `tenantId`, no error anywhere.)
3. After-hooks also receive the original `args` (line 65) — audit hooks log what
   was *requested*, never what was *written*.

**Fix:** thread `modifiedArgs` through successive hooks; merge into the
operation key (`data`/`update`/`where`), not the top level; align the JSDoc;
pass `modifiedArgs` to after-hooks; add a two-extension test.

### 8. `in` / `not_in` with an empty array produces invalid DynamoDB syntax

**File:** `src/helpers/where-converter.ts:113-176`

`[]` yields `#f IN ()` / `NOT #f IN ()` — DynamoDB rejects both with
`ValidationException: Syntax error; token: ")"`. Any caller building
`operator: "in"` from an empty collection (e.g. members of an empty
organization) crashes instead of getting `[]`.

**Fix:** empty `in` is vacuously false — short-circuit to an empty result;
empty `not_in` is vacuously true — omit the fragment.

### 9. `txUpdateMany` / `txDeleteMany` silently process at most 100 rows

**Files:** `src/adapter/tx-update-many.ts:35`, `src/adapter/tx-delete-many.ts:31`

Both call `ctx.nativeAdapter.findMany({ model, where })` with **no `limit`** —
and because this bypasses the framework's default-limit injection, the raw
method's own `DEFAULT_FIND_MANY_LIMIT = 100` applies. If 250 rows match, 100
are processed and the method returns `100` with no error. Reachable from core:
`internal-adapter.mjs` calls `txAdapter.deleteMany({model:"verification", …})`
during token consumption — >100 stale rows for an identifier leaves orphaned,
potentially consumable verification records. The non-tx path correctly fetches
all pages (gated by `maxUpdateManyItems`/`maxDeleteManyItems`).

**Fix:** use the `findAllItems`-style unlimited pagination the non-tx path uses,
then let `assertTransactionCapacity` reject >100 **loudly**.

### 10. `tx.update` email-uniqueness branch fires on *unchanged* email

**Files:** `src/adapter/tx-update.ts:51-56`, `src/email-uniqueness.ts:330-355`

The guard is `update.email !== undefined` — never compared with
`preState.email` — and `buildEmailUniquenessActions("updateEmail", …)` never
checks `oldEmailLower === newEmailLower`. A profile update that includes the
current email unchanged (e.g. `{email: "jane@x.com", name: "Jane"}`) buffers a
`Delete` **and** a `Put` on the identical `EmailLookups` key in one
`TransactWriteItems` → DynamoDB rejects the whole request synchronously with
`ValidationException: Transaction request cannot include multiple operations on
one item` — surfaced as an opaque `DYNAMODB_ERROR` for a harmless name update.
(The dead standalone `updateUserEmailWithUniqueness` has the same missing
check.)

**Fix:** take the email branch only when
`update.email.toLowerCase() !== preState.email.toLowerCase()`.

### 11. `txUpdateMany` Update actions lack `ConditionExpression` — deleted rows resurrected as corrupt partial items

**File:** `src/adapter/tx-update-many.ts:58-66`

Unlike `txUpdate` (`attribute_exists(#pk)`), the per-item Update has no
condition. `findMany` reads the matching rows non-transactionally; if one is
deleted (e.g. concurrent logout) before commit, the unconditional `Update`
performs an implicit **upsert**, creating a new item containing only the key +
patched fields — a corrupt partial row (`{token, impersonatedBy}` with no
`userId`/`expiresAt`).

**Fix:** add `ConditionExpression: "attribute_exists(#pk)"` per item, mirroring
`txUpdate` — and decide explicitly how a failed condition should interact with
the rest of the transaction (see finding 23).

### 12. OR connectors ignored by tier selection; duplicate same-field clauses silently dropped

**Files:** `src/helpers/query-planner.ts:112-161,173-258,290-301`, `src/helpers/where-converter.ts:297-327`

- `findEqClause` and both tiers' "already handled" bookkeeping match clauses
  **by field name only**, ignoring `connector` and duplicates:
  - `[{id eq "1"}, {id eq "2", connector:"OR"}]` (an OR-of-two-ids) → Tier-1
    `GetItem(id="1")` with **no filter at all** — the second clause vanishes.
  - `[{providerId eq "google"}, {providerId ne "legacy"}]` — the `ne` clause is
    silently dropped in Tier 1/2.
  - `[{id eq A}, {email eq B, connector:"OR"}]` → `GetItem(A)` + ANDed client
    filter — OR became AND.
- Even Tier 3's `buildExpression` uses a third grouping dialect
  (consecutive-AND groups joined by OR). better-auth's own references disagree
  with each other — the memory adapter is a strict left-to-right fold
  (`(A OR B) AND C`), the kysely adapter produces
  `AND(and-clauses) AND OR(or-clauses)` — but the adapter should match one of
  them (the memory adapter is what better-auth's adapter test-kit exercises).

**Fix:** bail out of Tier 1/2 to Tier 3 whenever any clause has
`connector: "OR"` **or** the key field appears more than once; mark clauses as
consumed by identity, not field name; align `buildExpression` with the memory
adapter's left-fold and document the choice.

### 13. `Date` where-values are never sanitized

**File:** `src/helpers/where-converter.ts:77-203` (contrast `src/helpers/update-item.ts:57-59`)

Every operator writes the raw value into `ExpressionAttributeValues`;
`WhereEntry.value` explicitly includes `Date`. The write path sanitizes
(`sanitizeValue`), the read path doesn't. Through the *framework* path this is
masked (better-auth's `transformWhereClause` runs `customTransformInput` on
where values), but **tx-scoped reads** (finding 5) and any direct adapter call
deliver raw `Date`s — and `client.ts` sets `convertClassInstanceToMap: false`,
so the marshaller throws `Unsupported type passed: Date`. A
`tx.findMany({model:"session", where:[{expiresAt lt new Date()}]})` inside any
transactional flow crashes.

**Fix:** run every operator's value(s) through the same Date→ISO conversion the
write path uses. Cheap, and makes the adapter robust regardless of entry path.

### 14. `{ include: [...] }` GSI projections treated like `ALL`

**File:** `src/helpers/query-planner.ts:234-254`

`needsFollowUpGetItem` is gated on `gsi.projection === "KEYS_ONLY"` only, but
`GsiDeclaration.projection` also supports `{ include: string[] }` — a sparse
projection that, like KEYS_ONLY, lacks most base-table attributes. Tier-2
results from an INCLUDE GSI are returned to better-auth **truncated** (e.g. a
session without `expiresAt`/`token`), silently.

**Fix:** trigger the follow-up `BatchGet` for any non-`"ALL"` projection.

### 15. `ends_with` throws, but better-auth treats it as a first-class operator

**File:** `src/helpers/where-converter.ts:205-210`; contract `@better-auth/core/dist/db/adapter/index.d.mts` (`whereOperators` includes `ends_with`); consumer `better-auth/dist/plugins/admin/routes.mjs`

`GET /admin/list-users?searchField=email&searchValue=foo&searchOperator=ends_with`
is schema-valid in the admin plugin and lands directly on
`findMany`/`count` → hard 500 (`UnsupportedOperatorError`) for a documented
feature. (The memory adapter implements `ends_with` natively.)

**Fix:** implement `ends_with` via client-side post-filtering on the scan/query
result (correct if inefficient), or a reversed-field + `begins_with` pattern
where configured — and surface the limitation at construction time, not as a
runtime 500 in an admin dashboard.

### 16. `consumeOne` / `deleteMany` Tier-1 paths ignore extra where clauses

**Files:** `src/adapter/methods/consume-one.ts:42-52`, `src/helpers/find-items.ts:52-62`

- `consumeOne` Tier 1 validates SK completeness but never checks
  `plan.needsClientSideFilter` — `consumeOne({model:"account", where:[{providerId…},{accountId…},{revoked eq false}]})`
  deletes and returns the item **even when `revoked` is `true`** — a
  "consume only if unused" guard fails open (confirmed by repro).
- `findAllItems`' `includeTier1` branch (used by `deleteMany`) returns the
  GetItem result unconditionally — `deleteMany({where:[{id eq u1},{banned eq true}]})`
  deletes `u1` even when `banned` is `false` (confirmed by repro).

**Fix:** apply `matchesClientFilters` after the Tier-1 fetch in both places (or
fold the extra clauses into a `ConditionExpression` on the delete).

### 17. Composite-key model queried by PK only → partial-key `GetItem` crash

**Files:** `src/adapter/methods/find-one.ts:33-50`, `find-many.ts:55-71`; root cause `src/helpers/query-planner.ts:123-130`

`tryTier1` treats the SK as optional and returns a Tier-1 plan with an
incomplete key; `findOne`/`findMany` pass it straight to `GetCommand`. Against
real DynamoDB (unlike the mocks), a HASH+RANGE table rejects a partial key with
`ValidationException: The provided key element does not match the schema` —
uncaught. `findOne({model:"account", where:[{providerId eq "google"}]})` is a
hard crash instead of a Query/Scan fallback.

**Fix:** only return a Tier-1 plan when the key is *complete* (SK present for
composite models); otherwise fall through to Tier 2/3.

---

## Medium

### 18. `txUpdate` on a missing row returns a fabricated record and dooms the transaction

**File:** `src/adapter/tx-update.ts:123`

With `preState === null` the handler still buffers a conditional Update and
returns `{ ...update }` — a record that never existed (contract: `null`). At
commit the doomed update cancels the **entire** transaction.

**Fix:** return `null` and buffer nothing when `preState` is `null`.

### 19. Transaction capacity guard off-by-N on email-uniqueness paths

**Files:** `src/adapter/tx-create.ts:44` (asserts 1, may push 2), `tx-update.ts:45` (asserts 1, may push 3), `tx-delete.ts:28` and `tx-consume-one.ts:31` (assert 1, may push 2)

Every handler asserts capacity for 1 before knowing whether the email branch
adds actions. A buffer at 99 passes the guard, then lands at 101 → the flush is
rejected by DynamoDB with a raw `ValidationException` after the whole callback
already ran, instead of the friendly guard error. The existing test
(`test/transaction.test.ts:945`) only covers the count-accurate
`updateMany`/`deleteMany` paths.

**Fix:** compute the real action count first, assert once with that number.

### 20. Silent partial results after retry exhaustion

**Files:** `src/adapter/methods/delete-many.ts:120-123`, `update-many.ts:202-204`, `src/helpers/batch-get.ts:89`

After `MAX_RETRY_ATTEMPTS`, leftover unprocessed items/keys are dropped: counts
quietly shrink, and `findMany` on a KEYS_ONLY GSI returns fewer rows than
matched. Callers can't distinguish "3 matched" from "10 matched, 7 throttled".

**Fix:** throw `DynamoAdapterError("PARTIAL_FAILURE", …)` with the processed
count, or at minimum warn through the logger unconditionally.

### 21. Three incompatible readings of the `indexes` config shape

**Files:** `src/helpers/query-planner.ts:180` (values as `GsiDeclaration`, keys ignored), `src/adapter/methods/count.ts:39` (key **is** the field name; never checks `gsiDecl.hashKey === w.field`), `src/adapter/methods/find-many.ts:219-222` (iterates a level too deep — never matches)

With `indexes: { user: { byEmail: {indexName, hashKey: "email"} } }`, the
planner uses the GSI, `count()` misses it (full Scan), and `findGsiRangeKey`
never matches. With `{ email: {hashKey: "emailAddress"} }`, `count()` queries
the **wrong key attribute**.

**Fix:** one shared `findGsiForField(model, field, config)` used by all three,
matching on `gsi.hashKey`.

### 22. "Forgiving tables" Proxy defeats several validation guards

**File:** `src/adapter/factory.ts:54-62`

The Proxy returns the property name for any missing key, so:

- `UNKNOWN_MODEL` (`client.ts:71-83`, `query-planner.ts:85-91`) is unreachable —
  a typo'd model scans a nonexistent table → raw `ResourceNotFoundException`.
- `config.tables.emailLookups` is always truthy → the `MISSING_TABLE` guards in
  `email-uniqueness.ts:81,147,188,288` can never fire. With
  `enableEmailUniqueness: true` and no `emailLookups` configured, every signup
  writes to a table literally named `emailLookups`.
- The one guard that would catch it — `validateConfig`'s warning — is only
  printed `if (config.debugLogs)` (`factory.ts:43`), default `false`: silent in
  production until the first signup fails opaquely.

**Fix:** restrict the fallback to unknown *plugin* models; read `emailLookups`
from the raw config in guards; always emit `validateConfig` warnings through
`getLogger` (consider a hard throw for enableEmailUniqueness-without-table).

### 23. Transaction failure reporting: reasons collapsed, `consumeOne` races become whole-tx 500s

**Files:** `src/adapter/transaction.ts:128-153`, `src/adapter/tx-consume-one.ts:53-62`

All `CancellationReasons` (`ConditionalCheckFailed`, `TransactionConflict`,
throttling…) map to one generic `TRANSACTION_FAILED`, so callers can't
distinguish "retry me" (transient conflict) from "this is now invalid". A
concrete case: two racing `consumeOne` calls on the same verification token both
buffer conditional deletes; the loser's **entire transaction** cancels and
surfaces as `TRANSACTION_FAILED` (500-shaped) where better-auth expects
`consumeOne → null` (an "invalid token" 4xx).

**Fix:** map cancellation codes to distinct error codes
(`TRANSACTION_CONFLICT`/`THROTTLED`/`CONDITIONAL_CHECK_FAILED`), identify which
buffered item failed, and translate consume-one condition failures to the
null-result contract where possible.

### 24. No guard against two buffered actions targeting the same item

**File:** `src/adapter/transaction.ts:79-127`

`TransactWriteItems` rejects two operations on one item. A callback that
updates then deletes the same row (revoke-then-cleanup), or overlapping
`updateMany`+`deleteMany`, produces an opaque `ValidationException` at flush.

**Fix:** track `(TableName, serializedKey)` while buffering and throw a clear
`DynamoAdapterError` at buffer time.

### 25. Two comparisons on the same GSI range key → invalid `KeyConditionExpression`

**File:** `src/helpers/query-planner.ts:200-206,303-309`

Every sort-key-operator clause on the range key is pushed into
`keyConditionClauses`. A natural date-range query (`createdAt gt t0` +
`createdAt lt t1`) produces a key condition referencing the sort key twice →
`ValidationException`.

**Fix:** allow only the first sort-key clause into the key condition; route the
rest to the filter (or synthesize `BETWEEN`).

### 26. Built-in `rateLimit` model is unindexed by default — full Scan on every request

**Files:** `src/helpers/key-builder.ts:48-51`, `src/helpers/validate-config.ts:83-87`

better-auth's `rateLimit` schema is `{key, count, lastRequest}` and is always
queried by `field: "key"`; the adapter defaults unknown models to
`pkField: "id"` and validate-config skips plugin models entirely. With
`rateLimit.storage === "database"`, **every incoming request** runs a Tier-3
full-table Scan (and hits finding 3's false-negative behavior on top).

**Fix:** document/validate that database rate limiting requires
`keySchemas: { rateLimit: { pkField: "key" } }` — ideally warn at construction
when known plugin models lack a matching key schema.

### 27. Email-uniqueness hardcodes `"id"` as the user PK

**File:** `src/email-uniqueness.ts:101-102,158,216-218`

Every other method resolves the PK via `getKeySchema("user", config)` (which
honors `config.keySchemas.user` overrides); this module hardcodes `"id"` in
three places. With a `keySchemas.user.pkField` override, the
`attribute_not_exists(#pk)` create guard checks a nonexistent attribute —
always true — so the duplicate-create protection silently stops working.

**Fix:** use `getKeySchema("user", config).pkField` throughout.

### 28. `matchesClientFilters` gaps

**File:** `src/helpers/resolve-item.ts:93-128`

No `between` case (falls to `default: return false` — silent "no match"),
`contains` is string-only (native DynamoDB `contains` also matches
lists/sets — the same where clause gives different answers depending on which
tier the planner picks), connectors are ignored (everything ANDs), and unknown
operators fail closed with no error.

**Fix:** add `between` and list-aware `contains`; throw
`UnsupportedOperatorError` in the default arm; connector handling per
finding 12.

---

## Low

### 29. `offset` semantics: Tier 2 throws, Tier 1 ignores

**File:** `src/adapter/methods/find-many.ts:55-79`

Tier-2 `offset > 0` throws `UnsupportedOptionError` (paginated admin/organization
listings over a GSI crash loudly); Tier-1 ignores `offset` entirely
(`findMany({where:[{id eq "1"}], offset: 1})` returns the row instead of `[]`).
Tier 3 emulates offset by discarding — the three tiers disagree.

### 30. `updateUserEmailWithUniqueness` landmines (currently dead code)

**File:** `src/email-uniqueness.ts:198-208,340-345`

(a) `buildUpdateExpression(patch)` already emits a SET for `patch.email`; the
function appends a second clause for the same attribute → "Two document paths
overlap" (`tx-update.ts` strips `email` first; this function doesn't). (b) The
old-email `Delete` has no `userId` ownership condition — a stale `oldEmail` can
delete a lookup row now owned by someone else. Fix both before wiring the
function in per finding 4.

### 31. Tier-3 no-sortBy branch has no cap on offset-driven scan cost

**File:** `src/adapter/methods/find-many.ts:180-202`

The sortBy branch enforces `maxScanItems`; this branch requests
`limit + offset` items with no cap — `offset: 1_000_000` scans unbounded.

### 32. `create` doesn't validate SK presence for composite-key models

**File:** `src/adapter/methods/create.ts:46-64`

A missing SK attribute surfaces as an opaque wrapped `DYNAMODB_ERROR` instead of
a descriptive `INVALID_DATA` naming the missing field.

### 33. `validateConfig` doesn't detect colliding table names

**File:** `src/helpers/validate-config.ts:53-109`

`tables.user` and `tables.verification` pointing at the same physical table
(both PK `"id"`) silently share a keyspace — data corruption with no startup
warning.

### 34. Public API omits extension-authoring types

**File:** `src/index.ts`

`DynamoAdapterMiddleware`, `AdapterLogger`, and `WhereClause` are needed to
author `config.extensions`/`config.logger` but aren't exported from the main
entry (only via the easy-to-miss `/types` subpath).

---

## Improvements (non-bug)

1. **Error taxonomy & retries** — everything besides conditional-check /
   transaction-cancel collapses into `DYNAMODB_ERROR`; no distinct code for
   transient throttling, and single-item create/update/delete have no
   retry/backoff (only the batch paths do). A transient throttle during login
   is an immediate hard failure.
2. **`ConsistentRead` is never used and not configurable** — all base-table
   reads are eventually consistent; expose a `consistentReads` flag for Tier-1
   `GetItem` on session/verification lookups.
3. **No pre-flight 4 MB transaction-size check** — only the 100-action count is
   guarded; oversized payloads surface as opaque service errors.
4. **Dead code:** `QueryPlan.needsClientSideSort` is set but never read;
   `toValueRef`/`nextValueIndex` on `buildExpressionNames` are unused (a future
   caller assuming `nextValueIndex` tracks usage gets a wrong answer);
   `NotImplementedError` has zero usages; `create.ts:33`'s
   `config.tables[model] ?? model` duplicates the Proxy fallback.
5. **`count.ts` reimplements key/filter merging** with its own `#hk`/`:hv`
   scheme instead of `merge-expressions.ts` — a second, divergent implementation
   of the exact bug class fixed in 0.1.6; safe today only because the prefixes
   differ. Consolidate.
6. **Tier-2 GSI selection is first-match** (`Object.entries` order), not
   most-selective (e.g. prefer a GSI whose range key is also constrained).
7. **`uuid.ts`** — try `globalThis.crypto?.randomUUID` before falling back to
   `Math.random`; with `engines.node >= 20` the fallback is dead weight anyway.
8. **`parseEmailUniquenessError`** re-checks `TransactionCanceledException`
   though its only caller already guards on it; the `TRANSACTION_FAILED`
   message could name the failing model/key (map reason index →
   `TransactItems[i]`) for much easier production debugging.
9. **`validate-config`** — give `emailLookups` a known-fields entry
   (`email`, `userId`) instead of skipping it like a plugin model.
10. **`create.ts:65`** returns the pre-sanitization `data` instead of `item` —
    equivalent today only because upstream transforms already normalized dates;
    worth a comment or returning `item`.
11. **Docs** — the README should state the operational requirements the design
    implies: GSIs on `user.email` and `verification.identifier` are effectively
    mandatory (finding 3); `ends_with` and `mode: "insensitive"` are
    unsupported server-side; `keySchemas.rateLimit` is required for DB rate
    limiting (finding 26); reads inside transactions are non-transactional.
12. **Test-suite gap** — mocks encode incorrect DynamoDB semantics
    (limit-before-filter, partial-key GetItem, unconditional-update upsert).
    The docker-compose DynamoDB Local integration suite should grow cases for:
    Tier-1 + extra filter clause, findOne-by-email without GSI on a multi-row
    table, sortBy ≠ range key with limit, `in: []`, and >100-row tx
    updateMany/deleteMany.

---

## What looks good

- **Placeholder-collision merge (`merge-expressions.ts`)** — the 0.1.6 fix is
  correct: descending-order remap with a numeric-boundary lookahead is
  cascade-safe and prefix-safe; both name and value namespaces are shifted.
- **`compactExpr`** correctly avoids the empty-`ExpressionAttributeNames`
  ValidationException.
- **`#nX` unconditional name-prefixing** sidesteps all 573 reserved words with
  zero runtime checks.
- **`fetchAllByPlan`** handles the Limit-vs-filter pagination interaction
  *correctly* (the loop continues while `LastEvaluatedKey` is present and the
  collected count is short) — the fix for finding 3 can reuse it directly.
- **Non-tx `create` email-uniqueness path** (user Put + conditional lookup Put
  in one `TransactWriteItems`, `_meta`-tagged cancellation-reason mapping) is a
  solid atomic claim pattern.
- **`updateMany` per-item conditional updates** (`attribute_exists`) correctly
  avoid resurrecting rows deleted between read and write — the exact protection
  `txUpdateMany` is missing (finding 11).
- Config surface (`maxScanItems`, `maxUpdateManyItems`, `warnOnLargeCount`,
  metrics hook, middleware extensions) shows good operational awareness, and
  the three-tier planner design itself is sound — most findings are
  integration seams between tiers, not the architecture.

---

## Suggested fix order

1. **Stop wrong-row/whole-table writes** — findings 1, 2, 16 (same root:
   Tier-1 plans leaking into scan-shaped helpers). One shared fix + an
   assertion in `fetchAllByPlan`/`resolveItemByPlan`.
2. **Stop false not-founds** — finding 3 (paginate single-item resolution).
3. **Make email uniqueness actually hold** — findings 4, 10, 27, 30, 22.
4. **Transaction contract** — findings 5, 9, 11, 18, 19, 23, 24 (or ship
   `transaction: false` until done).
5. **Query correctness** — findings 6, 8, 12, 13, 14, 15, 17, 21, 25.
6. Everything else as convenient.
