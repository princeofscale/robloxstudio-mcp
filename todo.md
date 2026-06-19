# TODO - MCP

Roadmap for unresolved work in the MCP itself (this repo / npm packages), not games built with it.
Completed notable changes move to [CHANGELOG.md](./CHANGELOG.md).

## Architecture / maintainability

- [ ] Continue splitting `packages/core/src/tools/index.ts` into a smaller `RobloxStudioTools` facade plus domain tool classes/modules for scene, scripts, assets, runtime/playtest, diagnostics, and marketplace/media tools.
- [ ] Audit schema bloat from ~120 tool definitions loading upfront; trim verbose descriptions and evaluate a `search_tools` / lazy-schema mode for agents that load everything at once.

## Reliability

- [ ] Extend `typedError` codes from the marketplace/insert paths to all remaining tool error returns.

## Documentation / external validation

- [ ] README: document the discover -> analyze thumbnails -> insert loop and the token-saving `fields`, `limit`, `offset`, and `get_scene_summary` workflow.
- [ ] `get_asset_details`: surface `canCopy`, `isPublicDomain`, and owner data for pre-insert checks.
- [ ] Live-verify the toolbox `items/details` response shape; `parseDetails` is defensive, but field names may need tuning against real data.
