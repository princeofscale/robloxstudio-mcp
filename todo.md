# TODO - MCP

Roadmap for unresolved work in the MCP itself (this repo / npm packages), not games
built with it. Completed work moves to [CHANGELOG.md](./CHANGELOG.md).

## Round-6 (post-2.20.0) content-quality frontier

From the round-6 research pass (sourcing assets · generating 3D · UI design quality).
Ordered do-now: A, B, D, then C and E.

- [x] **Track B — native AI 3D generation.** `generate_model_native` over
  `GenerationService:GenerateModelAsync` (Body1/Car5 predefined or custom `parts`).
  Shipped + live-dogfooded. Image-conditioning input deferred (ponytail). External
  multi-provider text-to-3D and EditableMesh-as-upload-lane deliberately NOT built.
- [~] **Track A — provenance-first external ingest.** SHIPPED: `import_external_asset`
  (URL/file → Open Cloud upload → provenance → optional insert) + `get_asset_provenance`.
  Reuses the proven `uploadAsset` path. ALSO SHIPPED (round-6 round-2): multi-provider
  `asset_source_search` over CC0 libs (Poly Haven + ambientCG live; Kenney/Quaternius as
  browse-only pointers) with license-aware normalized descriptors; provenance as an MCP
  resource (`roblox://asset/provenance[/{assetId}]`). REMAINING: live Open Cloud upload
  dogfood (needs credentials). Confirm-packet (no-key) mode not built — chose full Open
  Cloud automation.
- [x] **Track D — design system + lint + review.** SHIPPED: `ui_component_catalog`
  (tokens + canonical components + guidance), `design_lint` (deterministic scored
  metric), `apply_theme` (dark/light token standardization), `design_review` (vision
  screenshot critique via Pollinations). Full set landed. `design_review` end-to-end
  dogfood pending an MCP server restart (its novel parts — vision endpoint, CoreGui
  staging — verified live).
- [~] **Track E — self-driving loop polish.** SHIPPED: deterministic
  `propose_next_action` (next-step from stored episodes, no LLM turn for the obvious
  move) + richer episode diff (`diffEpisodes`: error-count delta, new/resolved error
  lines, per-assertion transitions) in `summarize_episode`. REMAINING: cut marketplace
  search/preflight churn (caching/dedup of repeat lookups).

## Open

- [ ] **Track C — calibrated grader.** Three layers: deterministic
  (structuredContent/resources/artifacts) → LLM-judge for ambiguous → 30–40
  human-labelled trajectories for calibration. Add 10–12 cases in under-powered
  buckets (runtime debug/fix-verify, error recovery, rollback, vague-prompt
  multi-step build, multi-place targeted mutation). Accept: judge ≥0.85 agreement
  with humans on binary PASS/FAIL; bucket metrics report false-pass/false-fail
  causes. Only worth it if evals/ is run regularly as a regression gate.

- [ ] **Headless Luau CI** — run the Luau-adjacent logic (codecs, diff,
  progress/cancel helpers, chunk planners) under a luau/lune CLI in CI. Lower ROI
  (generated Luau is already verified live) but raises coverage.

- [~] **Broader `outputSchema` sweep** — the self-driving-loop tools
  (`run_playtest_episode`, `summarize_episode`, `propose_next_action`) now publish
  strict-ish schemas (server-owned outputs). REMAINING: the host-/Roblox-state-dependent
  mutation/runtime/client-coupled tools whose output shapes vary with live state.

## Parked (data- / host-gated — revisit only on trigger)

- [~] **Track F — MCP App (interactive UI)** for asset-insertion review and
  bulk-change approval. Host-gated: needs an MCP-Apps-capable host (Cursor / Codex /
  ChatGPT) to render the UI. Not verifiable here until then.

- [~] **Track H — Semantic scene search (embeddings)** — data-gated. The
  decision-grade A/B eval (2026-06-21, deepseek-v4-flash, median of 3 over 19 cases)
  confirmed the bottleneck is upfront schema tokens, not lexical recall — the
  `scene_semantic` bucket scored 100% recall. **Trigger to revisit:** an eval where
  lexical `scene_search` measurably misses (low recall on "where is X") on a
  populated place — only then build the embedding index over
  name+class+tags+attrs+script-summaries.
