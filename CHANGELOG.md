# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added async Luau jobs — `execute_luau_async` returns a `jobId` immediately and runs heavy code in a plugin-side coroutine; `get_job_status` / `get_job_result` poll it; `cancel_job` flags it (best-effort). This removes the false-timeout class on long execute_luau calls: every individual MCP call returns fast while the work happens between polls. New plugin modules `JobRegistry` + `JobHandlers` (bounded registry, runs the same `LuauExec.execute` path). **Requires a plugin reinstall + Studio restart to take effect.**
- Added `asset_preflight_insert` — an authoritative pre-insert check that loads an asset with `AssetService:LoadAssetAsync` (the modern replacement for `InsertService:LoadAsset`, which supports third-party assets) into an isolated, unparented container, inspects it (root summary, descendant + script counts), and destroys it without touching the scene. Returns `insertabilityVerdict` with a typed error code (`AUTH` for copy-locked/unowned assets) and `hasScripts` as a safety signal. Verified live: even a `isFree` asset can return `AUTH`, confirming a real load — not metadata — is the source of truth for insertability.
- Added `get_world_snapshot` — a token-lean world model (place info, descendant/tag/sound/script counts, top classes, notable subtree roots, environment summary) for reasoning before drill-down, and `get_node_batch` — read several instances' chosen fields in one round-trip (compact value serialization) instead of a cascade of per-instance reads. Both run via execute-luau (no plugin change) and were verified live against a connected place; `Lighting.Technology` is read through pcall since it throws under PluginSecurity.
- Added `tool_catalog_search` — a token-lean discovery tool that searches the server's own tool catalog by task/domain and returns compact, ranked matches (name, domain, read/write, when-to-use, required args) without loading every tool's full schema. New `tool-catalog.ts` module classifies all tools into semantic domains (scene, mutation, scripts, runtime, assets, ui, environment, terrain, build, media, sync, safety, core) with `expandToolsets()` groundwork for future on-demand toolset loading.
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
