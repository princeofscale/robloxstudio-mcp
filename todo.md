# TODO - MCP

Roadmap for unresolved work in the MCP itself (this repo / npm packages), not games built with it.
Completed notable changes move to [CHANGELOG.md](./CHANGELOG.md).

## Larger follow-ups (from research review #2, deferred — high effort / host-gated)

- [~] Split `packages/core/src/tools/index.ts` into domain classes. DONE so far: `GeneratedBuilderTools`, `SyncTools`, `DiscoveryTools` (catalog/load_toolset), `WorldModelTools` (snapshot/node_batch/changes/scene_search/preflight). The facade delegates with identical signatures so the schema-parity invariants hold. REMAINING domains still inline in the facade, to extract the same way (one PR each, keep tests green):
  - `SceneReadTools` — get_file_tree, get_place_info, get_services, search_objects, get_instance_properties/children, search_by_property, get_class_info, get_project_structure, get_descendants, get_scene_summary, compare_instances, get_memory_breakdown, get_scene_analysis, get_selection
  - `MutationTools` — create/delete/clone/duplicate, set_property/properties, mass_*, attributes, tags
  - `ScriptTools` — get/set/edit/insert/delete script lines, grep, find_and_replace, diagnose_scripts
  - `RuntimeTools` — playtest, multiplayer, eval_*, simulate_*, device/network sim, breakpoints, profiler, logs, screenshots, async jobs (execute_luau_async/get_job_*/cancel_job), undo/redo
  - `AssetTools` — search_assets, get_asset_details/thumbnail, insert/preview/upload, marketplace_*, import/export rbxm, image_generate*, import_scene
  - `SafetyTools` — get_operation_history, list/restore script backups (+ the `_safetyGate`/`_formatSafety` helpers stay shared via runtime)
  - Then optionally: a declarative `registerTool(...)` + `withStandardToolPipeline` registry so validation/timing/envelope/outputSchema are applied by construction (the error envelope is already applied centrally at dispatch; this would also cover outputSchema).
- [ ] Headless Luau CI: run the Luau-adjacent logic (codecs, diff, progress/cancel helpers, chunk planners) under a luau/lune CLI in CI. Lower ROI for us than it sounds because our Luau is generated strings already verified live, but raises coverage.
- [ ] MCP `resources` + subscriptions as a first-class world interface (`roblox://world/snapshot?mask=...`, `roblox://node/<id>`, `roblox://world/changes?since=...`) plus TTL/cache hints on list/read. Real protocol addition; layer it on top of the existing snapshot-store rather than replacing it.
- [ ] `outputSchema` + `structuredContent` on every read/orchestration tool (the error-envelope half is already done by topology). Needs per-tool structured returns + client-validation testing.
- [ ] MCP App (interactive UI) for asset-insertion review and bulk-change approval. Host-gated (needs an MCP-Apps-capable host to render); revisit when the host supports it.
- [ ] Semantic scene search upgrade: optional embedding index over name+class+tags+attrs+script-summaries (the current `scene_search` is the lexical multi-signal version; embeddings would need an external/local model).

## Architecture / maintainability

- [ ] Continue splitting `packages/core/src/tools/index.ts` into a smaller `RobloxStudioTools` facade plus domain tool classes/modules for scene, scripts, assets, runtime/playtest, diagnostics, and marketplace/media tools.
- [x] Audit schema bloat from ~120 tool definitions loading upfront. Compressed the duplicated `instance_id` description; added `tool_catalog_search` + semantic `tool-catalog.ts`; added `load_toolset` + opt-in deferred loading (`ROBLOX_MCP_LAZY_TOOLS`) in `server.ts` (stdio) with `tools/list_changed`. (Remaining: mirror deferred loading in the `http-server.ts` /mcp streamable path — currently full-catalog there.)

## World model / read pipeline

- [x] `get_changes_since(snapshotId)` — incremental changefeed (added/removed/changed nodes) so the agent doesn't re-pull the world after each action. Server-side `SnapshotStore` + fingerprint diff.

## Reliability

- [~] Extended typed-error codes (added CONFIRMATION_REQUIRED/AMBIGUOUS_TARGET/INVALID_ARGUMENT/UNSUPPORTED_CLASS/INSERT_NOT_PERMITTED/RESOURCE_TOO_LARGE/BETA_FEATURE_REQUIRED + `isRetryable` + `errorEnvelope()`). TODO: propagate the `errorEnvelope()` shape to every remaining tool error return (large mechanical sweep).

## Documentation / external validation

- [x] README: document the discover -> analyze thumbnails -> insert loop and the token-saving `fields`, `limit`, `offset`, and `get_scene_summary` workflow.
- [x] Live-verify the toolbox `items/details` response shape; tuned `parseDetails` to the real field names (`asset.typeId`, `fiatProduct.isFree`) and surfaced `isFree`/`hasScripts` on results.
- [ ] `get_asset_details` (keyed/cookie path): surface `canCopy`, `isPublicDomain`, and owner data for pre-insert checks. (The key-free pre-insert signal now comes from marketplace `isFree`.)
