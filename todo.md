# TODO - MCP

Roadmap for unresolved work in the MCP itself (this repo / npm packages), not games built with it.
Completed notable changes move to [CHANGELOG.md](./CHANGELOG.md).

## Larger follow-ups (from research review #2, deferred — high effort / host-gated)

- [ ] Split `packages/core/src/tools/index.ts` (~3500 lines) into registry/handlers/transport/error seams with a declarative `registerTool` + `withStandardToolPipeline`. High ROI for maintainability but a large refactor with regression risk — do it as a focused pass (with the schema/route-parity tests as invariants), not bundled with feature work or right before a release.
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
