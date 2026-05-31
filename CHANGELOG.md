# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.2](https://github.com/ebratz/dynamodb-better-auth/compare/v0.1.1...v0.1.2) (2026-05-31)


### Bug Fixes

* **adapter:** apply transformInput to buffered transactional writes ([59a0510](https://github.com/ebratz/dynamodb-better-auth/commit/59a05109f26fe2b26130de85f14d7949f52b1e89))

## [0.1.1](https://github.com/ebratz/dynamodb-better-auth/compare/v0.1.0...v0.1.1) (2026-05-31)


### Bug Fixes

* **ci:** add overrides to resolve @better-auth/test-utils peer-dep conflict ([84fc4f0](https://github.com/ebratz/dynamodb-better-auth/commit/84fc4f020bc127aef4d5ae305d6d3218ed07b7fb))
* **ci:** delete lockfile before install to bypass npm bug [#4828](https://github.com/ebratz/dynamodb-better-auth/issues/4828) ([b051490](https://github.com/ebratz/dynamodb-better-auth/commit/b0514901d8614a9f9141b0b8b4dd7a4c9074c2e9))
* **ci:** use npm install instead of npm ci to work around rollup platform deps ([6210f38](https://github.com/ebratz/dynamodb-better-auth/commit/6210f387a3894ba611685af6c4506dd3148ce577))

## [Unreleased]

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
