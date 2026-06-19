# TODO — MCP

Roadmap for the **MCP itself** (this repo / npm packages), not any game built with it.
Bugs are detailed in [bugs.md](./bugs.md). Game-specific notes live in the Studio place, not here.

## ✅ Models workflow (get ↔ place ↔ AI analyzes & picks best)
- [x] **Enriched `marketplace_search`** — real name/creator/assetType + viewable thumbnail
      URL + popularity (votes) + price/isFree per result; ranked best-fit-first (B1).
- [x] **Reliable insert** — `insert_asset` / `marketplace_search_and_insert` walk ranked
      candidates, skip copy-locked/AUTH-blocked, return typed error + hint (B2).
- [x] **AI pick-best** — `rankByRelevanceAndPopularity` orders candidates; agent gets
      thumbnails + metadata to choose; search-and-insert auto-picks the first that loads.
- [x] **Path resolution** — shared resolver confirmed; `get_instance_children` retries once
      on transient `NOT_FOUND` (debounce lag) (B3, B5).

## ✅ Reliability
- [x] **execute_luau timeout** — `MCP_REQUEST_TIMEOUT_MS` env + `resolveRequestTimeout`
      gives heavy endpoints a ≥120s floor; error says work may still have succeeded (B4).
- [x] **Typed error codes** — `errors.ts` (`classifyError`/`typedError`/`responseErrorCode`)
      → TIMEOUT/AUTH/NOT_FOUND/PLUGIN_DISCONNECTED/RATE_LIMITED (B6).
- [x] **Playtest log capture** — `RuntimeLogBuffer` seeds from `LogService:GetLogHistory()`
      on install; pre-listener startup logs no longer lost (B8, needs plugin reinstall).

## ✅ Polish
- [x] **Lighting presets + post-FX** — `environment_set_lighting_preset(withPostFx)` adds
      Future + idempotent Bloom/ColorCorrection/SunRays (B7).

## 🪙 Token / agent efficiency (less water, more signal)
Two costs (per MCP research): **schema bloat** (tool defs in context) + **response bloat**
(tool outputs). Highest-leverage = leaner responses.
- [x] **`compact()` response util** — rounds float noise (175.00000001→175,
      0.9019607843→0.902; integer ids untouched) + drops null/undefined. Applied to the
      heaviest read tools: get_instance_properties/children, get_descendants, scene_analysis,
      memory_breakdown, project_structure, file_tree, mass_get_property, search_objects,
      get_selection. Big token cut on geometry dumps, zero info loss.
- [ ] **Response field selection** — optional `fields`/`select` on read tools so the agent
      pulls only what it needs (e.g. just Name+ClassName) instead of full property sets.
- [ ] **Pagination / caps** — default `limit`+`cursor` on unbounded list tools
      (get_descendants, search_*) to avoid 10k-line dumps.
- [ ] **Aggregation tools** — `get_scene_summary` (counts by class, not full tree);
      summaries computed server-side before entering context.
- [ ] **Schema bloat** — ~120 tools' defs load upfront. Audit/trim verbose descriptions;
      consider a `search_tools`/lazy-schema mode for agents that load everything at once.
- [ ] **Consistent typed errors** — extend `typedError` codes (B6) to all tool error paths.
- [ ] **Default `excludeSource`** on property reads of scripts (Source can be huge).

## 🟢 Next (optional)
- [ ] README: document the discover → analyze (thumbnails) → insert loop + the new fields.
- [ ] `get_asset_details` — surface `canCopy` / `isPublicDomain` / owner for pre-checks.
- [ ] Live-verify the toolbox `items/details` response shape (sandbox can't reach it);
      `parseDetails` is defensive but field names may need tuning against real data.

## ✅ Done
- [x] Free marketplace search + insert (no Open Cloud key) — `marketplace_search`,
      `marketplace_search_and_insert`, `insert_asset` (InsertService, key-free).
- [x] Safety layer, UI/Environment/Terrain/Template builders, Sync/Doctor/Dashboard,
      AI image gen, media + diagnostics tools, CI + release automation, npm publish.
