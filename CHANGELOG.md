# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.6](https://github.com/ebratz/dynamodb-better-auth/compare/v0.1.5...v0.1.6) (2026-07-05)


### Bug Fixes

* **query-planner:** remap `:vX` value placeholder collisions when merging key-condition and filter expressions — previously the filter's values silently overwrote the key condition's via `Object.assign`, causing GSI queries with extra where clauses to fail with `ValidationException` (or return wrong results when types coincided); also hardened `#nX` remapping against cascade and prefix mismatches (`#n1` matching inside `#n10`)

## [0.1.5](https://github.com/ebratz/dynamodb-better-auth/compare/v0.1.4...v0.1.5) (2026-06-05)


### Bug Fixes

* **ci:** add --legacy-peer-deps to resolve AWS SDK peer dependency conflicts ([be01d20](https://github.com/ebratz/dynamodb-better-auth/commit/be01d2017942c66a62323fb69d6db8e20436e8c0))


### Refactoring

* eliminate remaining duplication with shared helpers ([2f73084](https://github.com/ebratz/dynamodb-better-auth/commit/2f73084b5977e0bd591e4dc34a06156659ba4644))
* implement all 5 SOLID audit fixes via parallel agents ([ee6664a](https://github.com/ebratz/dynamodb-better-auth/commit/ee6664afce2062dafb9ed4374a06f40bb267a79a))

## [0.1.4](https://github.com/ebratz/dynamodb-better-auth/compare/v0.1.3...v0.1.4) (2026-06-05)


### Bug Fixes

* commit resolveFilter export needed by update-many refactor ([02cd57f](https://github.com/ebratz/dynamodb-better-auth/commit/02cd57f7d20d75eb6d68b92940749c90db47b4fc))


### Refactoring

* centralize query planning in update, update-many, delete ([b69aaed](https://github.com/ebratz/dynamodb-better-auth/commit/b69aaed5d5fa4d3d1e716469bf8dbbd285bf3112))

## [0.1.3](https://github.com/ebratz/dynamodb-better-auth/compare/v0.1.2...v0.1.3) (2026-05-31)


### Bug Fixes

* **adapter:** omit empty ExpressionAttribute maps to avoid DDB ValidationException ([6eed843](https://github.com/ebratz/dynamodb-better-auth/commit/6eed843ebac2ddbecc3593ff681bfeea015b4828)), closes [#3](https://github.com/ebratz/dynamodb-better-auth/issues/3)

## [0.1.2](https://github.com/ebratz/dynamodb-better-auth/compare/v0.1.1...v0.1.2) (2026-05-31)


### Bug Fixes

* **adapter:** apply transformInput to buffered transactional writes ([59a0510](https://github.com/ebratz/dynamodb-better-auth/commit/59a05109f26fe2b26130de85f14d7949f52b1e89))

## [0.1.1](https://github.com/ebratz/dynamodb-better-auth/compare/v0.1.0...v0.1.1) (2026-05-31)


### Bug Fixes

* **ci:** add overrides to resolve @better-auth/test-utils peer-dep conflict ([84fc4f0](https://github.com/ebratz/dynamodb-better-auth/commit/84fc4f020bc127aef4d5ae305d6d3218ed07b7fb))
* **ci:** delete lockfile before install to bypass npm bug [#4828](https://github.com/ebratz/dynamodb-better-auth/issues/4828) ([b051490](https://github.com/ebratz/dynamodb-better-auth/commit/b0514901d8614a9f9141b0b8b4dd7a4c9074c2e9))
* **ci:** use npm install instead of npm ci to work around rollup platform deps ([6210f38](https://github.com/ebratz/dynamodb-better-auth/commit/6210f387a3894ba611685af6c4506dd3148ce577))

## [Unreleased]

### Added

- **Centralized query planner:** all findOne, findMany, update, delete, and deleteMany methods now route through `resolveQueryPlan` from `helpers/query-planner.ts`, eliminating per-method planning code.
- **Guards against accidental operations:**
  - `deleteMany` with empty/undefined `where` throws `DynamoAdapterError` (`code: "INVALID_WHERE"`).
  - `findMany` with `limit: 0` returns `[]` immediately with no DynamoDB call.
  - PK/SK fields are silently stripped from `update` payloads (DynamoDB rejects key-attribute mutation).
- **Edge-case test coverage:** 26 new tests in `test/edge-cases.test.ts` covering `limit:0`, empty where guards, PK/SK stripping, `between`/`not_in` operators, OR connector grouping, IN clause chunking, non-existent item update, and KEYS_ONLY UnprocessedKeys retry.

### Fixed

- **`not_in` and `between` operator support:** `convertWhereClause` now correctly handles `not_in` (NOT IN) and `between` (BETWEEN :lo AND :hi) operators, including chunking for >100 values.
- **update.ts upsert prevention:** Tier 1 `UpdateItem` now includes `ConditionExpression: "attribute_exists(#pk)"` to prevent creating a new item when the target key doesn't exist. `ConditionalCheckFailedException` is caught and returned as `null`.
- **KEYS_ONLY UnprocessedKeys retry in findMany:** `BatchGetCommand` retries with exponential backoff when `UnprocessedKeys` are returned, ensuring all items are eventually resolved.
- **deleteMany KEYS_ONLY follow-up:** replaced sequential per-item `GetItem` calls with chunked `BatchGetCommand` (100 per batch), reducing round trips.
- **buildSimpleFilter AND/OR grouping:** filter expressions now correctly group AND/OR clauses with proper parentheses instead of flattening all into AND.
- **Inflated count in `unsafeBatchUpdate`:** count no longer inflates when a BatchWrite stream returns duplicate insertions.
- **`consumeOne` email-lookup leak in transactions:** email-lookup entries are now properly included in the transactional buffer for `consumeOne` operations.

### Changed

- **generateToken extracted to shared utility:** the session/verification token generation is now centralized in `helpers/generate-token.ts`.
- **Dead code removed:** per-method `buildSimpleFilter`, `resolveXxxPlan` functions deleted in favor of the centralized planner and `convertWhereClause`. Significant code deduplication across `findOne`, `findMany`, `update`, `delete`, and `deleteMany`.
- **Documentation:** added "Limitations & Edge Cases" section to README with supported operators table, guard behaviors, PK/SK stripping, and item size caveat.

## [0.1.0] - 2026-05-30

### Added

- Initial release.
- Multi-table DynamoDB adapter for Better Auth (user, session, account, verification, optional email-lookup sidecar).
- Three-tier query planner: GetItem → GSI Query → Scan + filter.
- Hybrid-buffer TransactWriteItems pattern with eager pre-state reads for `update` and conditional Delete for `consumeOne`.
- `enableEmailUniqueness` config for atomic email-claim sidecar.
- Plugin-extensible config: arbitrary `tables`, rich `GsiDeclaration`, optional `keySchemas` overrides.
- Errors: `DynamoAdapterError`, `UnsupportedOperatorError`, `UnsupportedOptionError`, `InvalidWhereError`.
- 239 unit tests covering all methods, helpers, transaction wrapper, and email uniqueness.
- Integration test suite using DynamoDB Local.
- `unsafeBatchUpdate` option for faster bulk writes with documented last-write-wins caveat.
- Coverage thresholds: ≥85% statements, ≥75% branches, ≥80% functions.
