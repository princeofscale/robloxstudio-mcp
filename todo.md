# TODO - MCP

Roadmap for unresolved work in the MCP itself (this repo / npm packages), not games
built with it. Completed notable changes move to [CHANGELOG.md](./CHANGELOG.md).

## Next up (priority order)

### 1. Finish deferred Track F / Track H

- [ ] **Track F — MCP App (interactive UI)** for asset-insertion review and
  bulk-change approval. Host-gated: needs an MCP-Apps-capable host to render the UI.
  Revisit when the host (Cursor / Codex / ChatGPT) supports it; not verifiable here
  until then.
- [~] **Track H — Semantic scene search (embeddings)** — **PARKED (data-gated)**. The
  first real A/B eval (2026-06-21, deepseek-v4-flash) showed the bottleneck is upfront
  schema tokens (lazy loading cut bootstrap tax 77%, no success regression), NOT
  lexical-search recall. So embeddings aren't justified by data. **Trigger to revisit:**
  an eval where lexical `scene_search` measurably misses (low recall on "where is X")
  — only then build the embedding index over name+class+tags+attrs+script-summaries.

### 2. Finish the domain-split of `index.ts`

The facade `RobloxStudioTools` delegates to domain classes with identical signatures
(so the schema-parity invariants hold). DONE: `GeneratedBuilderTools`, `SyncTools`,
`DiscoveryTools`, `WorldModelTools`, `SafetyTools`, `SceneReadTools`. REMAINING domains
still inline in the facade, to extract the same way (one PR each, keep tests green):

- [x] `SceneReadTools` — get_file_tree, get_place_info, get_services, search_objects,
  get_instance_properties/children, search_by_property, get_class_info,
  get_project_structure, get_descendants, get_scene_summary, compare_instances,
  get_memory_breakdown, get_scene_analysis, get_selection (extracted; index.ts −192
  lines; multi-peer reads share a `_fanOutRead` helper). search_files left inline.
- [x] `ScriptTools` — get/set/edit/insert/delete script lines, grep,
  find_and_replace, diagnose_scripts (extracted; index.ts −171 lines;
  set_script_source keeps its gate + backup-before-overwrite via injected runtime fns).
- [x] `MutationTools` — set/mass set+get property, create/mass-create/delete/clone/
  smart+mass duplicate, attributes, tags, bulk_set_attributes, apply_mutation_plan
  (extracted; index.ts −242 lines; bulk/destructive ops keep safetyGate + history).
- [ ] `AssetTools` — search_assets, get_asset_details/thumbnail, insert/preview/upload,
  marketplace_*, import/export rbxm, image_generate*, import_scene. **DEFERRED — the
  most client-coupled domain:** uses 4 clients (openCloud/cookie/image/marketplace) +
  private pipeline helpers (`_generateImageToFile`, `resolveImageId`) + static
  `findLibraryPath` + heavy fs/fetch/SSRF logic (import/export rbxm, import_scene ~140
  lines). Unit tests cover builders, NOT this client wiring, so a verbatim move still
  needs **live dogfooding** through the Studio bridge before trusting it. Do as its own
  dogfooded pass.
- [ ] `RuntimeTools` — playtest, multiplayer, eval_*, simulate_*, device/network sim,
  breakpoints, profiler, logs, screenshots, async jobs
  (execute_luau_async/get_job_*/cancel_job), playtest_sample_state,
  run_gameplay_assertions, undo/redo. **DEFERRED** — biggest + most stateful domain
  (image capture/encoding helpers, job registry, peer routing via `_resolveRuntime`);
  same "needs live dogfooding" caveat as AssetTools.
- [ ] Optionally then: a declarative `registerTool(...)` + `withStandardToolPipeline`
  registry so validation/timing/envelope/outputSchema are applied by construction
  (the error envelope is already applied centrally at dispatch).

### 3. New research-prompt round

- [x] Wrote `research-prompt.md` (round 4) — grounded in the first eval datapoint
  (lazy −77% bootstrap), with explicit questions on making `evals/` decision-grade,
  whether to un-park Track F/H, and the next frontier. Paste into ChatGPT → next
  prioritized roadmap.

## Other open items

- [ ] **`outputSchema` per tool.** The `structuredContent` + error-envelope halves are
  done by topology (every tool returns `structuredContent`; failures return the typed
  envelope). Remaining: declare a strict `outputSchema` per read/orchestration tool +
  client-validation testing. Deferred deliberately — a strict schema would break mixed
  clients, so it ships only with the structured-returns sweep.
- [ ] **Propagate `errorEnvelope()` to every remaining tool error return** (large
  mechanical sweep; the dispatch-level envelope already covers thrown errors).
- [ ] **Mirror deferred tool loading in the `http-server.ts` `/mcp` streamable path** —
  currently full-catalog there (stdio has `ROBLOX_MCP_LAZY_TOOLS`).
- [ ] **Headless Luau CI**: run the Luau-adjacent logic (codecs, diff, progress/cancel
  helpers, chunk planners) under a luau/lune CLI in CI. Lower ROI (our Luau is
  generated strings already verified live) but raises coverage.
- [ ] **`get_asset_details` (keyed/cookie path)**: surface `canCopy`,
  `isPublicDomain`, and owner data for pre-insert checks. (The key-free pre-insert
  signal currently comes from marketplace `isFree`.)
