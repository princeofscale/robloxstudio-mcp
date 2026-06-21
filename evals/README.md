# MCP eval harness

Measures whether the token/discovery optimizations actually help — not by feel, but
across three layers (per the research review): **bootstrap cost**, **trajectory
quality**, and **end-to-end task success**. Lets you A/B `upfront` vs `lazy` tool
loading on a fixed benchmark and gate CI on regressions.

## Pieces

- `metrics.ts` — pure metrics over a recorded run trace: `bootstrapTax` (tokens before
  the first world read), `scoreTrajectory` (tool-selection precision/recall,
  unnecessary calls, invalid-call rate), `successPer1kInputTokens`.
- `harness.ts` — `runSuite` + the `McpHarnessAdapter` interface and the CI `evaluateGates`
  (success must not drop > N pp; bootstrap tax must drop ≥ M%).
- `cases/*.json` — the benchmark task set (discovery / trajectory / e2e buckets).
- `selfcheck.ts` — deterministic check of the graders (no model). `npx tsx evals/selfcheck.ts`.

## Running it

A concrete adapter ships in `adapters/claude-mcp-adapter.ts` (Anthropic-Messages
protocol) and a runner in `run.ts`. Prereqs: the server is built (`npm run build` at
the repo root), an API key is set (below), and Roblox Studio is connected.

The runner auto-detects the provider from the environment, in priority order:

```sh
cd evals
npm install

# 1. OpenModel gateway — free `deepseek-v4-flash` (free event until 2026-06-26):
OPENMODEL_API_KEY=om-... npx tsx run.ts                 # A/B upfront vs lazy + gate
OPENMODEL_API_KEY=om-... npx tsx run.ts --mode=lazy     # single mode

# 2. Real Anthropic API (used if OPENMODEL_API_KEY is unset):
ANTHROPIC_API_KEY=sk-... npx tsx run.ts
```

Knobs (env):

- `EVAL_MODEL` — override the model id (default `deepseek-v4-flash` for OpenModel,
  `claude-opus-4-8` for Anthropic). Any Messages-protocol model on the gateway works
  (e.g. `deepseek-v4-pro`, `claude-opus-4-8`).
- `OPENMODEL_BASE_URL` / `ANTHROPIC_BASE_URL` — override the API base URL.
- `EVAL_REQUEST_DELAY_MS` — fixed delay before each model call (default `2000` for
  OpenModel to respect its per-user rate limit, `0` for Anthropic).

`ClaudeMcpAdapter` spawns the MCP server over stdio (`ROBLOX_MCP_LAZY_TOOLS` per
mode), lists its tools, runs a manual tool-use loop against the configured model,
re-lists tools after `load_toolset` in lazy mode, and records a `TraceEvent[]` +
`RunMetrics` per task. It drops the gateway's unsolicited `thinking` blocks from the
replayed history and retries 429s with backoff (`maxRetries`, default 8).

> **Note:** the harness spawns its *own* MCP server and needs the Studio bridge.
> Don't run it while another MCP client (e.g. an active Claude Code / Cursor session)
> already holds the bridge — the spawned server falls back to proxy mode and can't
> reach Studio. Close other MCP clients first, or run evals from a clean shell.

## Wiring a different model

The model-driving part is an interface so it stays provider-agnostic. Implement
`McpHarnessAdapter` (see the Claude adapter as the reference): `startServer(mode)`
launches the MCP server, `runTask` runs the agent loop and records the trace + metrics.

```ts
import { runSuite, evaluateGates } from './harness.js';
import discovery from './cases/discovery.json' assert { type: 'json' };

const upfront = await runSuite(adapter, discovery, 'upfront');
const lazy = await runSuite(adapter, discovery, 'lazy');
const gate = evaluateGates(upfront, lazy, { maxSuccessDropPct: 3, minBootstrapDropPct: 30 });
if (!gate.pass) { console.error(gate.reasons); process.exit(1); }
```

## Grading

Use rule-based graders (schemas, allowed/forbidden tools, trajectory) as the hard
gate, and reserve an LLM-as-judge only for answer sufficiency on `must_contain_facts`.
Keep a small human-calibration set to sanity-check the judge.
