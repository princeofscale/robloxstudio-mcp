# tests/

Integration tests that drive a live `@princeofscale/robloxstudio-mcp` subprocess via
stdio MCP, exercising real Studio behavior through the plugin. Each test
spawns its own subprocess and is responsible for cleaning up any playtest
state it starts.

## Prerequisites

1. **Roblox Studio open to a place** with the project's plugin installed and
   connected (toolbar icon green or yellow, not red). Opening only Studio's
   launcher is not enough because plugins do not load there.
2. **Port `localhost:58741` available or already held by this MCP server.**
   Tests start their own subprocesses when the port is free. If a primary
   subprocess is already running, tests use proxy mode and forward through it.
3. **The built dist** at `packages/robloxstudio-mcp/dist/index.js` —
   `npm run build` if it's stale. If you've also changed plugin code, fully
   restart Studio so it picks up the new `.rbxmx`.
4. **`HttpEnabled = true`** in Studio Experience Settings (Security tab).

## Run

```bash
# All tests, sequential
node tests/run-all.mjs

# Or one at a time
node tests/eval-bridge-error-preservation.mjs
node tests/execute-luau-error-preservation.mjs
node tests/proxy-mode-peer-fanout.mjs
node tests/execute-luau-output-capture.mjs
```

Each test prints `✅ PASSED` or `❌ FAILED` plus the failing assertion. On
failure the test's MCP subprocess stderr tail is dumped for context.

## Release smoke: regular Studio tools

`tests/studio-tooling-smoke.mjs` is a destructive release smoke test for the
normal main-plugin tool surface. It closes Studio, auto-installs the local main
plugin into a backed-up plugin folder, opens a temporary `.rbxlx` place, verifies
edit-mode read/write/script/tag/attribute/execute tools, then runs
`tests/run-all.mjs` against the same primary server to cover playtest, runtime,
proxy, and multiplayer paths. It restores the original plugin files afterward.

```bash
RSMCP_E2E_CLOSE_ALL_STUDIO=1 npm run test:studio:tools
```

## Release E2E: auto-install + Studio restart

`tests/auto-install-plugin-e2e.mjs` is a destructive release verification that
closes Roblox Studio, installs the main and inspector plugins, launches Studio,
checks version/variant metadata, verifies mismatch warnings, and restores the
original plugin files.

```bash
RSMCP_E2E_CLOSE_ALL_STUDIO=1 npm run test:e2e:auto-install
```

The E2E targets published `@latest` first. If `@latest` does not yet include the
new auto-install behavior, it falls back to a local packed tarball and prints
`artifactSource: local-pack`. It requires port `58741` to be free before it
starts and refuses to close Studio unless `RSMCP_E2E_CLOSE_ALL_STUDIO=1` is set.

Studio lifecycle helpers are available directly:

```bash
node scripts/studio-lifecycle.mjs status
RSMCP_E2E_CLOSE_ALL_STUDIO=1 node scripts/studio-lifecycle.mjs close-all
node scripts/studio-lifecycle.mjs launch
node scripts/studio-lifecycle.mjs wait-connected --variant main --version <expected-version>
```

## What each test exercises

| File | What it checks |
|---|---|
| `eval-bridge-error-preservation.mjs` | `eval_server_runtime` / `eval_client_runtime` surface actual user errors instead of Roblox's generic `"Requested module experienced an error while loading"` wrapper for explicit errors, nil derefs, parser errors, and nested `require()` module-load failures |
| `eval-context-routing.mjs` | `execute_luau target=server/client-N` runs in plugin context on the selected peer, while `eval_server_runtime` / `eval_client_runtime` run through the server Script and client LocalScript eval bridges |
| `runtime-bridge-lifecycle.mjs` | Runtime eval bridges are created inside play DataModels, stay out of edit mode, work for managed and manually-started playtests, and direct multiplayer logs get peer attribution |
| `execute-luau-error-preservation.mjs` | `execute_luau` surfaces user error messages, parser errors, and nested `require()` module-load failures without leaking plugin-internal paths or Roblox's generic module-load wrapper |
| `proxy-mode-peer-fanout.mjs` | `get_runtime_logs target=all`, `get_connected_instances`, and `get_memory_breakdown target=all` return non-empty capture/peer data when invoked from a proxy-mode subprocess (the multi-session path) |
| `execute-luau-output-capture.mjs` | `execute_luau target=server` captures user `print()` and `warn()` calls in the response `output` array, matching the `target=edit` baseline |
| `multiplayer-test-lifecycle.mjs` | `multiplayer_test_start`, add-player, client-leave, state, and end-test flow against real StudioTestService multiplayer peers |

## Lifecycle and cleanup

- Most tests call `start_playtest` once at the top and `stop_playtest` in a
  `finally` block. The multiplayer lifecycle test uses `multiplayer_test_*`
  tools and falls back to `stop_playtest` for cleanup if interrupted.
- Tests do not modify the place's persistent state — they only print, eval,
  and read from the runtime log buffer.

## Layout

- `lib/mcp-client.mjs` — shared utility for spawning + driving subprocesses
  via stdio JSON-RPC, plus minimal assertion helpers.
- `<feature>.mjs` — one test file per concern, each runnable directly with
  `node`.
- `run-all.mjs` — runs every test sequentially.
