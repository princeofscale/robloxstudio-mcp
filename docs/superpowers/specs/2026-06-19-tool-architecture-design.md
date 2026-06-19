# Tool Architecture Cleanup Design

## Goal

Reduce the large tool entrypoint files while preserving the public MCP tool names, schemas, handler behavior, and `instance_id` routing.

## Current State

- `packages/core/src/tools/index.ts` is a single `RobloxStudioTools` class with transport helpers, safety state, generated-Luau tools, sync logic, runtime routing helpers, and many individual tool methods.
- `packages/core/src/tools/definitions.ts` is a single data file containing every MCP input schema in one `TOOL_DEFINITIONS` array.
- `packages/core/src/http-server.ts` maps MCP tool names to `RobloxStudioTools` methods through `TOOL_HANDLERS`.
- `packages/core/src/__tests__/tool-schema.test.ts` guards schema validity, `instance_id` exposure, HTTP handler wiring, and implementation signatures.

## Design

Keep `RobloxStudioTools` and `TOOL_DEFINITIONS` as compatibility facades. Split internals behind them in small, domain-oriented modules so callers and tests see the same surface.

First split `definitions.ts`, because schemas are pure data and can move with minimal behavioral risk. Each domain exports `ToolDefinition[]`; the root file imports and concatenates them in the existing order.

Then start splitting `index.ts` by extracting shared types/runtime helpers before moving domain methods. The target shape is a small facade class backed by domain tool classes such as scene, script, simulation, asset, builder, sync, and diagnostics tools. Each domain class receives a shared runtime object containing the bridge, Studio HTTP client, safety manager, sync manager, marketplace/image clients, and formatting helpers it needs.

## Constraints

- Public MCP tool names must not change.
- Existing handler signatures must remain compatible while refactoring.
- Studio-routing tools must keep `instance_id` in schema, handler body, and implementation.
- No unrelated feature changes during the architecture split.
- `todo.md` tracks only unresolved work.
- `CHANGELOG.md` follows Keep a Changelog style with an `Unreleased` section.

## Verification

- Run schema-focused tests after schema refactors:
  `npm test -w packages/core -- --runTestsByPath src/__tests__/tool-schema.test.ts`
- Run the token-response tests added in the previous work:
  `npm test -w packages/core -- --runTestsByPath src/__tests__/response-shape.test.ts src/__tests__/scene-summary.test.ts`
- Before claiming completion, run full core tests, typecheck, lint, and build if practical.
