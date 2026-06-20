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

## Wiring it to a model

The model-driving part is intentionally an interface so it stays provider-agnostic.
Implement `McpHarnessAdapter` against your client (Claude/Codex) + an MCP client
transport: `startServer(mode)` launches the MCP server with `ROBLOX_MCP_LAZY_TOOLS`
on/off, `runTask` runs the agent loop and records a `TraceEvent[]` + `RunMetrics`.

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
