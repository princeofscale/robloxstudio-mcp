# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Surfaced `isFree` and `hasScripts` on marketplace search results so an agent can judge a candidate (and avoid copy-locked/paid models that fail `LoadAsset`) before inserting.
- Documented the token-saving inspect workflow (`get_scene_summary` → `fields`/`limit`/`offset` drill-down) and the marketplace discover → analyze → insert loop in the README.

### Fixed

- Fixed `marketplace-client` `parseDetails` to read the real live toolbox field names (`asset.typeId`, `fiatProduct.isFree`) instead of the older synthetic ones (`assetTypeId`, `product.price`), so asset type and free/paid status are now correctly enriched onto search results. Verified against a live `items/details` response.

## [2.17.0] - 2026-06-19

### Added

- Added `limit`, `offset`, and `fields` response shaping for `get_descendants` and `search_objects`.
- Added `get_scene_summary` for token-lean scene aggregation by descendant class.
- Added `breakpoints` for MCP-managed Studio debugger breakpoints with persisted registry and log breakpoint support.
- Added `capture_script_profiler` for focused short ScriptProfilerService captures on server or `client-N` peers.
- Added focused tests for response shaping and scene summary Luau generation.
- Added domain-specific tool definition modules under `packages/core/src/tools/definitions/`.
- Added `runtime-support`, `GeneratedBuilderTools`, and `SyncTools` modules to start shrinking the monolithic tool facade.
- Added this changelog.

### Changed

- Changed `get_instance_properties` to omit script `Source` by default; callers can pass `excludeSource: false` or use `get_script_source`.
- Changed runtime logging to seed buffers from `LogService:GetLogHistory()` so early playtest logs are available through `get_runtime_logs`.
- Changed playtest output handling to use `get_runtime_logs` instead of separate playtest/output log buffers.
- Changed `packages/core/src/tools/definitions.ts` into a 31-line compatibility aggregator that preserves `TOOL_DEFINITIONS`.
- Changed `packages/core/src/tools/index.ts` to delegate generated builder/template tools and local sync tools to domain classes.
- Changed `todo.md` to track unresolved work only.

### Removed

- Removed legacy `get_playtest_output` and `get_output_log` tools.

[unreleased]: https://github.com/princeofscale/robloxstudio-mcp/compare/v2.17.0...HEAD
[2.17.0]: https://github.com/princeofscale/robloxstudio-mcp/compare/v2.16.3...v2.17.0
