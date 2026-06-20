# TODO - MCP

Roadmap for unresolved work in the MCP itself (this repo / npm packages), not games built with it.
Completed notable changes move to [CHANGELOG.md](./CHANGELOG.md).

## Architecture / maintainability

- [ ] Continue splitting `packages/core/src/tools/index.ts` into a smaller `RobloxStudioTools` facade plus domain tool classes/modules for scene, scripts, assets, runtime/playtest, diagnostics, and marketplace/media tools.
- [~] Audit schema bloat from ~120 tool definitions loading upfront. DONE: compressed the duplicated `instance_id` description; added `tool_catalog_search` + a semantic `tool-catalog.ts` (domains, search, `expandToolsets`). TODO (phase 2): opt-in `load_toolset` + hide-by-default deferred loading with `tools/list_changed` in both `server.ts` and `http-server.ts` ListTools handlers.

## World model / read pipeline

- [ ] `get_changes_since(snapshotId)` — incremental changefeed (added/removed/mutated nodes, tag/attribute/script-hash diffs) so the agent doesn't re-pull the world after each action. Needs server-side snapshot storage + diff.

## Reliability

- [ ] Extend `typedError` codes from the marketplace/insert paths to all remaining tool error returns.

## Documentation / external validation

- [x] README: document the discover -> analyze thumbnails -> insert loop and the token-saving `fields`, `limit`, `offset`, and `get_scene_summary` workflow.
- [x] Live-verify the toolbox `items/details` response shape; tuned `parseDetails` to the real field names (`asset.typeId`, `fiatProduct.isFree`) and surfaced `isFree`/`hasScripts` on results.
- [ ] `get_asset_details` (keyed/cookie path): surface `canCopy`, `isPublicDomain`, and owner data for pre-insert checks. (The key-free pre-insert signal now comes from marketplace `isFree`.)
