# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- Moved `data/logo.png` and `data/banner.png` to `assets/`; updated README references.
- Added `.superpowers/` to `.gitignore`.
- Added CHANGELOG reminder to CLAUDE.md.
- Zeroed eslint warnings: added overrides for test files and client-coupled sources; `no-explicit-any` warnings eliminated.

## [2.19.3] - 2026-06-21

### Added

- Published first-wave MCP `outputSchema` contracts for stable, object-shaped tools:
  discovery (`tool_catalog_search`, `load_toolset`), world-model reads
  (`get_world_snapshot`, `get_node_batch`, `get_changes_since`, `scene_search`),
  asset preflight, playtest telemetry, gameplay assertions, transactional mutation
  plans, and recipes. Responses remain dual-format: `structuredContent` for newer
  clients and the same JSON text block for compatibility.
- Added schema conformance tests with representative golden payloads so published
  contracts are validated in CI before they are advertised to MCP clients.
- **Declarative `ToolRegistry` + `defineTool()` + standard execution pipeline.**
  New `tool-pipeline.ts` keeps tool metadata, schemas, and handler together in one
  place. The pipeline wraps every call with structuredContent attachment and typed
  error envelopes (via errorEnvelope). First-wave contracted tools are registered
  through the pipeline; both stdio and streamable HTTP servers dispatch through the
  registry first, falling back to `TOOL_HANDLERS` for non-migrated tools.
- **Mirrored lazy tool loading to the streamable HTTP `/mcp` path.** The `ListTools`
  handler now uses the `ToolRegistry` (which respects `ROBLOX_MCP_LAZY_TOOLS`) when
  available, so the streamable HTTP endpoint also benefits from reduced bootstrap
  token costs. `listChanged` capability is advertised in lazy mode.
- Eval benchmark suite expanded to 15 cases across 5 buckets (discovery,
  marketplace, scene-read, mutation, runtime), up from 3 in discovery-only.
  Each case has typed gold tools, forbidden tools, and answer-fact checks.
- Added 12 unit tests for the declarative tool pipeline — `defineTool`,
  `ToolRegistry`, and lazy mode — now at 419 total tests.
- `get_asset_details` now normalizes responses from both OpenCloud and cookie
  auth paths into a structured shape with `creatorName`, `creatorId`,
  `isCopyLocked`, `isPublicDomain`, `price`, `voting`, and `assetTypeId` fields.

### Changed

- Centralized MCP tool-list shaping so stdio and streamable HTTP advertise
  `inputSchema`/`outputSchema` consistently from the same helper.
- Converted raw error returns across all major tool domains (`exportRbxm`,
  `importRbxm`, `getAssetDetails`, `marketplaceSearch`, `imageGenerate`,
  `imageGenerateAndUpload`, `captureScreenshot`, `getScriptSource`,
  `environmentSetLightingPreset`) to use `toolErrorResult()`, so every tool
  surface returns the uniform typed error envelope instead of opaque error strings.
- **Extracted `AssetTools` domain class** from the facade (`index.ts` −1129 lines).
  Moved 20 asset/build/marketplace/image tools and all private helpers
  (normalizePalette, normalizeBuildParts, computeBounds, findLibraryPath,
  _generateImageToFile, resolveImageId) into `asset-tools.ts`. Same delegation
  pattern as SceneReadTools / ScriptTools / MutationTools — signatures and
  `instance_id` invariants unchanged.

## [2.19.2] - 2026-06-21

### Changed

- **Eval-validated lazy tool loading.** First real A/B run of the `evals/` harness
  (deepseek-v4-flash via OpenModel, discovery cases) confirms `ROBLOX_MCP_LAZY_TOOLS`
  pays off: mean bootstrap tax dropped **77%** (187k → 43k input tokens) with **no
  success regression** (67% → 67%) and ~5× better success-per-1k-tokens. The bottleneck
  is upfront tool-schema tokens (which lazy loading cuts), not lexical search recall —
  so the embeddings/semantic-search upgrade stays parked until an eval shows a real
  lexical-recall ceiling.
- **Domain-split of the `index.ts` facade (maintainability).** Extracted three more
  domain classes — `SceneReadTools` (14 read/inspect tools), `ScriptTools` (8 script
  tools), and `MutationTools` (19 scene-write tools) — each delegated from the facade
  with identical public signatures, so the tool surface and `instance_id` schema-parity
  invariants are unchanged. `index.ts` dropped ~605 lines (3983 → 3378). No behavior
  change; 387 unit tests green. (Asset + Runtime domains remain inline, deferred to a
  separately dogfooded pass — they're the most client-coupled.)
- Synced all package versions + the bundled Studio plugin to 2.19.2 (clears the
  plugin/server version-mismatch banner after a Studio restart).

## [2.19.1] - 2026-06-21

### Added

- Reworked the `evals/` harness to drive any Anthropic-Messages-compatible model: the runner auto-detects the provider from the environment (`OPENMODEL_API_KEY` → OpenModel gateway with the free `deepseek-v4-flash`, else `ANTHROPIC_API_KEY` → the real Anthropic API), with `EVAL_MODEL` / `*_BASE_URL` / `EVAL_REQUEST_DELAY_MS` knobs. The adapter drops the gateway's unsolicited `thinking` blocks from replayed history and retries 429s with backoff. Lets the eval suite run for free against `deepseek-v4-flash`.
- Added `run_gameplay_assertions` — run named boolean checks against the DataModel and get structured per-assertion pass/fail + an `allPassed` summary (the prove-the-fix QA primitive; pair with start_playtest + target="server" to assert live runtime state). Research review #7 (fix→verify loop).
- Added `list_recipes` + `apply_recipe` — typed, proven, idempotent build macros (proximity_door, ambient_sound, kill_brick) the agent picks by id + params instead of re-synthesizing gameplay Luau. Re-running replaces named instances rather than duplicating. Research review #5; higher success and fewer tokens than ad-hoc generation.
- Added `apply_mutation_plan` — transactional batch edits in one round-trip (set_property primitives, set_attribute, add_tag, remove_tag) with a `dryRun` diff, per-op before/after, and a ready-to-run `rollback` reverse plan in the receipt (stateless — the rollback is itself a mutation plan, no server handle/TTL). Large plans gate on `confirm` via the safety layer's object-count limit (new `bulk_mutate` op kind). Research review #4; ops travel as JSONDecode data (injection-safe). Verified live (dry-run).
- Added `playtest_sample_state` — sample LIVE runtime state during a playtest: players (position/health/team/tool/humanoid state), named world state in `ValueBase` objects, currently-playing audio, and runtime/role flags. Domain-masked; defaults to `target="server"`. The top Roblox-specific frontier from the research review — turns the MCP from a scene editor into a runtime-aware debugging surface. Verified live.
- Added an MCP **resources** data plane (research review #2) over the existing world-model tools — the same data as cacheable canonical URIs, exposed from both the stdio and HTTP `/mcp` servers: `roblox://world/snapshot?view=overview|standard`, `roblox://node/<dot.path>`, `roblox://world/changes?since=<snapshotId>` (+ resource templates). Lets hosts (Cursor, Codex) read and reuse world state independently of the tool surface; a thin layer on top of the snapshot-store, tools unchanged.
- Server now returns MCP `instructions` at initialization (the cross-tool workflows — inspect→drill-down→refresh, marketplace discover→preflight→insert, dry-run→confirm, async-Luau polling, typed-error branching — stated once server-wide instead of duplicated per tool). Hosts like ChatGPT read these alongside tool metadata.
- Every tool now also returns `structuredContent` (the machine-readable object channel) alongside the existing text block, applied centrally at dispatch when the payload is a JSON object — backward-compatible dual-format output, no strict `outputSchema` declared (which would break mixed clients). Contract-plane groundwork from the post-2.19.0 research review.

## [2.19.0] - 2026-06-20

### Added

- Added `scene_search` — a ranked, multi-signal "where is X" search (research review's #7, the pragmatic no-vector form): scores each instance across name, tags, attribute keys, parent name, and class, returning the top matches with a score and matched terms. Answers "find the door system", "where is the shop UI", "what controls day/night" — more intent-aware than the single-field `search_objects`. Verified live.
- Added an **eval harness** under `evals/` (research review's #6) to measure optimizations objectively instead of by feel: pure trajectory/token metrics (`bootstrapTax`, tool-selection precision/recall, unnecessary calls, success-per-1k-tokens), a paired A/B `runSuite` (`upfront` vs `lazy`) with CI `evaluateGates` (success must not regress; bootstrap tax must drop), a provider-agnostic `McpHarnessAdapter` interface, a benchmark case set, and a deterministic `selfcheck.ts` for the graders.
- Marketplace search is now a **provider abstraction** (second research review's #5): the proven key-free public toolbox **v1** stays the default, while the official Creator Store **v2** (`/v2/assets:search`, currently Beta / Not Recommended) can be opted into via `ROBLOX_MARKETPLACE_PROVIDER=v2` or a constructor option, with automatic fallback to v1 if v2 errors. `buildV2SearchUrl` + a defensive `parseV2Results` are unit-tested. `asset_preflight_insert` remains the source of truth for insertability regardless of provider. No runtime change by default.
- Async Luau jobs now support **cooperative progress**: server-generated long-running Luau can call `_G.__mcp.progress(done, total, message, stage)` and `_G.__mcp.checkCancelled()`, and `get_job_status` surfaces `progress`/`total`/`stage`. Concurrency-safe via a `coroutine.running()` → job-id binding (no clash between parallel jobs). Per the second research review, this is an opt-in sanctioned API — NOT auto-injected into arbitrary user Luau. (Requires plugin reinstall + Studio restart.)

### Changed

- Every tool now surfaces a uniform typed error envelope on failure ("envelope by topology"): the CallTool dispatch in both the stdio server and the HTTP `/mcp` server wraps any thrown error via `toolErrorResult`, so the agent always gets `{ ok:false, error:{ code, message, retryable, suggestedRecovery, stage } }` with a stable code instead of an opaque internal error — without per-handler changes. (Full `outputSchema`/`structuredContent` on every tool remains a follow-up.)
- `get_changes_since` now diffs **three signature channels per node** — `structure` (class/parent/name/childCount), `semantics` (domain-specific properties: BasePart geom/material/anchored, Sound id/playing/looped/volume, scripts enabled/source-length, lights), and `meta` (tags + attributes) — keyed by a **stable per-session node id** (`GetDebugId`) instead of a fragile path. Changed nodes now report *which* channels moved, so an agent sees the kind of change (a re-parent vs a material tweak vs a tag) instead of a blind "childCount differs". Verified live (GetDebugId/Source/GetTags/GetAttributes all pcall-guarded). Second research review's #2.
- `tool_catalog_search` now returns a machine-readable `recommendedToolsets` block (domain + recommended tools + the exact `load_toolset` call to make) and a `client_hint`, so an agent/lazy client knows to load a domain instead of guessing. Bootstrap-contract from the second research review; deferred loading stays stdio-only (the HTTP `/mcp` path keeps the full, stable, non-side-effectful tool list).

## [2.18.0] - 2026-06-20

### Added

- Added `get_changes_since` — an incremental changefeed: captures a cheap world fingerprint (path -> class|child-count) and returns the added/removed/changed instances since a prior snapshot, so an agent refreshes only what moved instead of re-pulling the world after each action. First call returns a `snapshotId` baseline; subsequent calls diff and roll the baseline forward. New pure `world-changes.ts` (diff + bounded `SnapshotStore`) and `world-fingerprint.ts` generator.
- Added async Luau jobs — `execute_luau_async` returns a `jobId` immediately and runs heavy code in a plugin-side coroutine; `get_job_status` / `get_job_result` poll it; `cancel_job` flags it (best-effort). This removes the false-timeout class on long execute_luau calls: every individual MCP call returns fast while the work happens between polls. New plugin modules `JobRegistry` + `JobHandlers` (bounded registry, runs the same `LuauExec.execute` path). **Requires a plugin reinstall + Studio restart to take effect.**
- Added `asset_preflight_insert` — an authoritative pre-insert check that loads an asset with `AssetService:LoadAssetAsync` (the modern replacement for `InsertService:LoadAsset`, which supports third-party assets) into an isolated, unparented container, inspects it (root summary, descendant + script counts), and destroys it without touching the scene. Returns `insertabilityVerdict` with a typed error code (`AUTH` for copy-locked/unowned assets) and `hasScripts` as a safety signal. Verified live: even a `isFree` asset can return `AUTH`, confirming a real load — not metadata — is the source of truth for insertability.
- Added `get_world_snapshot` — a token-lean world model (place info, descendant/tag/sound/script counts, top classes, notable subtree roots, environment summary) for reasoning before drill-down, and `get_node_batch` — read several instances' chosen fields in one round-trip (compact value serialization) instead of a cascade of per-instance reads. Both run via execute-luau (no plugin change) and were verified live against a connected place; `Lighting.Technology` is read through pcall since it throws under PluginSecurity.
- Added `load_toolset` + opt-in deferred tool loading (`ROBLOX_MCP_LAZY_TOOLS=1`): the stdio server advertises only a small always-on core (the meta + critical-path tools) upfront and expands the advertised list as the agent calls `load_toolset` for a domain, emitting `tools/list_changed`. Off by default (full catalog), so existing clients are unaffected. Without the flag, `load_toolset` just reports which tools a domain contains.
- Added `tool_catalog_search` — a token-lean discovery tool that searches the server's own tool catalog by task/domain and returns compact, ranked matches (name, domain, read/write, when-to-use, required args) without loading every tool's full schema. New `tool-catalog.ts` module classifies all tools into semantic domains (scene, mutation, scripts, runtime, assets, ui, environment, terrain, build, media, sync, safety, core) with `expandToolsets()` groundwork for future on-demand toolset loading.
- Surfaced `isFree` and `hasScripts` on marketplace search results so an agent can judge a candidate (and avoid copy-locked/paid models that fail `LoadAsset`) before inserting.
- Documented the token-saving inspect workflow (`get_scene_summary` → `fields`/`limit`/`offset` drill-down) and the marketplace discover → analyze → insert loop in the README.

### Changed

- Extended the typed-error system (research review track 6): added `CONFIRMATION_REQUIRED`, `AMBIGUOUS_TARGET`, `INVALID_ARGUMENT`, `UNSUPPORTED_CLASS`, `INSERT_NOT_PERMITTED`, `RESOURCE_TOO_LARGE`, and `BETA_FEATURE_REQUIRED` codes (auto-classified from messages, so existing `typedError`/`responseErrorCode` call sites benefit immediately), plus `isRetryable(code)` and an `errorEnvelope()` builder that attaches `retryable` + `suggestedRecovery` for a uniform, agent-branchable failure shape.

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

[unreleased]: https://github.com/princeofscale/robloxstudio-mcp/compare/v2.19.3...HEAD
[2.19.3]: https://github.com/princeofscale/robloxstudio-mcp/compare/v2.19.2...v2.19.3
[2.19.2]: https://github.com/princeofscale/robloxstudio-mcp/compare/v2.19.1...v2.19.2
[2.19.1]: https://github.com/princeofscale/robloxstudio-mcp/compare/v2.19.0...v2.19.1
[2.19.0]: https://github.com/princeofscale/robloxstudio-mcp/compare/v2.18.0...v2.19.0
[2.18.0]: https://github.com/princeofscale/robloxstudio-mcp/compare/v2.17.0...v2.18.0
[2.17.0]: https://github.com/princeofscale/robloxstudio-mcp/compare/v2.16.3...v2.17.0
