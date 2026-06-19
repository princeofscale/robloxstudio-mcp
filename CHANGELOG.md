# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added `limit`, `offset`, and `fields` response shaping for `get_descendants` and `search_objects`.
- Added `get_scene_summary` for token-lean scene aggregation by descendant class.
- Added focused tests for response shaping and scene summary Luau generation.
- Added domain-specific tool definition modules under `packages/core/src/tools/definitions/`.
- Added `runtime-support`, `GeneratedBuilderTools`, and `SyncTools` modules to start shrinking the monolithic tool facade.
- Added this changelog.

### Changed

- Changed `get_instance_properties` to omit script `Source` by default; callers can pass `excludeSource: false` or use `get_script_source`.
- Changed `packages/core/src/tools/definitions.ts` into a 31-line compatibility aggregator that preserves `TOOL_DEFINITIONS`.
- Changed `packages/core/src/tools/index.ts` to delegate generated builder/template tools and local sync tools to domain classes.
- Changed `todo.md` to track unresolved work only.

[unreleased]: https://github.com/princeofscale/robloxstudio-mcp/compare/v2.16.3...HEAD
