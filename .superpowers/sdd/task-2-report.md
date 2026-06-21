# Task 2 Report: First-Wave Output Schema Registry

## What I implemented

- Created `packages/core/src/tools/output-schemas.ts` with the central first-wave output schema registry exactly as specified in the task brief.
- Added:
  - `CONTRACTED_OUTPUT_TOOL_NAMES`
  - `OUTPUT_SCHEMAS`
  - `getOutputSchema(toolName)`
  - `withOutputSchemas(definitions)`
- Updated `packages/core/src/tools/definitions.ts` to build `RAW_TOOL_DEFINITIONS` first and then attach output schemas centrally with `withOutputSchemas(...)`.
- Updated `packages/core/src/index.ts` to export the registry entrypoints.
- Extended `packages/core/src/__tests__/tool-schema.test.ts` with the required registry coverage tests.
- Adjusted the existing canonical composition test to compare against `withOutputSchemas([...domain definitions])`, which matches the new production composition path.

## Test results

Focused command run:

```bash
npm test -w packages/core -- tool-schema.test.ts --runInBand
```

Result:

- Red step: failed as expected with `TS2307` because `../tools/output-schemas.js` did not exist yet.
- Green step: passed with `15 passed, 15 total`.

## TDD evidence

1. Added the three new registry tests to `tool-schema.test.ts` before creating `output-schemas.ts`.
2. Ran the focused suite and observed the expected missing-module failure.
3. Implemented the registry and central attachment wiring.
4. Re-ran the focused suite.
5. Observed one additional failure in the pre-existing canonical-order test because `TOOL_DEFINITIONS` is now decorated while the grouped baseline was raw.
6. Updated that test to apply `withOutputSchemas(...)` to the grouped baseline, preserving the original intent while reflecting the new architecture.
7. Re-ran the same focused suite and verified it passed cleanly.

## Files changed

- `packages/core/src/tools/output-schemas.ts`
- `packages/core/src/tools/definitions.ts`
- `packages/core/src/index.ts`
- `packages/core/src/__tests__/tool-schema.test.ts`

## Self-review findings

- The registry is centralized and only decorates explicitly contracted tool names.
- No new dependency was introduced.
- The focused conformance tests cover:
  - registry attachment,
  - registry exclusivity,
  - array `items` completeness for output schemas.
- Backward compatibility is preserved at the definition layer: this task only publishes `outputSchema` metadata and does not alter handler return payload behavior.

## Concerns

- Release metadata remains at `2.19.2` in the focused test output. I did not change versioned package metadata because the Task 2 brief explicitly scoped ownership to four files, and no release metadata file was listed there.

## Fix report

- Added `normalizeExecuteLuauToolResult(...)` and `wrapToolJsonText(...)` in `packages/core/src/tools/runtime-support.ts` to unwrap object-shaped JSON from `/api/execute-luau` bridge responses and emit the existing `{ content: [{ type: 'text', text: JSON.stringify(object) }] }` result shape.
- Switched the contracted execute-luau-backed handlers called out by review to use targeted normalization instead of the raw bridge envelope:
  - `get_world_snapshot`
  - `get_node_batch`
  - `scene_search`
  - `apply_mutation_plan`
  - `apply_recipe`
  - `playtest_sample_state`
  - `run_gameplay_assertions`
- Left `_runGeneratedLuau(...)` unchanged so unrelated generated-Luau tools keep their current behavior.
- Left `asset_preflight_insert` on its existing bespoke parse path after verifying it already unwraps `returnValue`.

### Focused tests

Red/green regression command:

```bash
npm test -w packages/core -- contracted-output-normalization.test.ts runtime-support.test.ts --runInBand
```

Observed results:

1. Red step: failed with two envelope-vs-domain-object assertion diffs plus `TS2305` because `normalizeExecuteLuauToolResult` did not exist yet.
2. Green step: passed with `2 passed, 2 total` test suites and `6 passed, 6 total` tests.

### Regression coverage added

- `packages/core/src/__tests__/contracted-output-normalization.test.ts`
  - proves `get_world_snapshot` now returns the parsed inner world object, not `{ success, returnValue, output }`
  - proves `playtest_sample_state` now returns the parsed inner telemetry object, not `{ success, returnValue, output }`
- `packages/core/src/__tests__/runtime-support.test.ts`
  - proves the shared helper unwraps object JSON and falls back to a safe object when `returnValue` is not a JSON string
