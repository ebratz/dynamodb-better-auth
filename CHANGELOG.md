# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
