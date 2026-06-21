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
