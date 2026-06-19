# Tool Architecture Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the completed token-efficiency work while reducing the giant tool definition and implementation files.

**Architecture:** Keep the public `TOOL_DEFINITIONS` and `RobloxStudioTools` surfaces stable. Move schema data into domain modules first, then extract implementation support code and domain methods in smaller follow-up passes.

**Tech Stack:** TypeScript, Jest, Node ESM, MCP SDK, existing `packages/core` workspace.

## Global Constraints

- Public MCP tool names and input schemas must stay stable unless a test explicitly documents an intentional addition.
- Studio-routing tools must keep `instance_id` in schema, HTTP handler body, and implementation signatures.
- Do not revert existing uncommitted token-efficiency work.
- Use `CHANGELOG.md` for completed notable changes and `todo.md` only for unresolved work.
- Verify with Jest/typecheck/lint/build before reporting completion.

---

### Task 1: Baseline and Docs Ledger

**Files:**
- Create: `docs/superpowers/specs/2026-06-19-tool-architecture-design.md`
- Create: `docs/superpowers/plans/2026-06-19-tool-architecture.md`
- Create: `CHANGELOG.md`
- Modify: `todo.md`

**Interfaces:**
- Produces: a Keep a Changelog `CHANGELOG.md` with `## [Unreleased]`.
- Produces: a `todo.md` containing unresolved tasks only.

- [ ] Run focused baseline tests:
  `npm test -w packages/core -- --runTestsByPath src/__tests__/tool-schema.test.ts src/__tests__/response-shape.test.ts src/__tests__/scene-summary.test.ts`
- [ ] Add the design and plan documents.
- [ ] Create `CHANGELOG.md` with completed token-efficiency work under `Unreleased`.
- [ ] Rewrite `todo.md` to remove completed items and keep pending architecture/error/docs work.

### Task 2: Split Tool Definitions by Domain

**Files:**
- Modify: `packages/core/src/tools/definitions.ts`
- Create: `packages/core/src/tools/definitions/*.ts`
- Test: `packages/core/src/__tests__/tool-schema.test.ts`

**Interfaces:**
- Produces: `TOOL_DEFINITIONS: ToolDefinition[]` from `packages/core/src/tools/definitions.ts`.
- Produces: domain arrays typed as `ToolDefinition[]`.

- [ ] Move contiguous schema sections into domain files while preserving order.
- [ ] Keep shared schema fragments either in the root file or in `definitions/shared.ts`.
- [ ] Import and concatenate all domain arrays in `definitions.ts`.
- [ ] Run `npm test -w packages/core -- --runTestsByPath src/__tests__/tool-schema.test.ts`.

### Task 3: Begin Implementation Split Safely

**Files:**
- Modify: `packages/core/src/tools/index.ts`
- Create: focused support files under `packages/core/src/tools/`
- Test: `packages/core/src/__tests__/tool-schema.test.ts`

**Interfaces:**
- Public `RobloxStudioTools` remains constructible with `new RobloxStudioTools(bridge)`.
- Existing method names used by `TOOL_HANDLERS` remain available.

- [ ] Extract pure helper types/functions that do not need private class state.
- [ ] Keep facade method signatures unchanged.
- [ ] Run focused schema tests and relevant unit tests.

### Task 4: Final Verification and Git

**Files:**
- All changed files.

**Interfaces:**
- Produces: verified working tree ready to commit and push.

- [ ] Run `npm test -w packages/core`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run lint`.
- [ ] Run `npm run build`.
- [ ] Inspect `git diff --stat` and `git status --short`.
- [ ] Commit the completed work with a concise message.
