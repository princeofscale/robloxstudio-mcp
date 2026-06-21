// Eval runner: A/B the MCP server in `upfront` vs `lazy` tool-loading mode against
// the benchmark cases, print per-mode metrics, and apply the CI gates.
//
// Model wiring (auto-detected, in priority order):
//   1. OPENMODEL_API_KEY  -> OpenModel gateway (baseURL https://api.openmodel.ai),
//      model from EVAL_MODEL or default `deepseek-v4-flash` (free until 2026-06-26).
//   2. ANTHROPIC_API_KEY  -> real Anthropic API, model from EVAL_MODEL or
//      default `claude-opus-4-8`.
// Override the base URL with OPENMODEL_BASE_URL / ANTHROPIC_BASE_URL if needed.
//
// Prereqs: an API key (above), a connected Roblox Studio, and the server built
// (`npm run build`). Then from the repo root:
//   cd evals && npm install
//   OPENMODEL_API_KEY=om-... npx tsx run.ts
//
// Add --mode=lazy or --mode=upfront to run a single mode.

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { runSuite, evaluateGates, type EvalCase, type HarnessMode } from './harness.js';
import { ClaudeMcpAdapter } from './adapters/claude-mcp-adapter.js';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '..', 'packages', 'robloxstudio-mcp', 'dist', 'index.js');

const DEFAULT_OPENMODEL_BASE_URL = 'https://api.openmodel.ai';
const DEFAULT_OPENMODEL_MODEL = 'deepseek-v4-flash';
const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-8';

interface ModelConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
  label: string;
}

/** Pick the model provider from the environment (OpenModel first, then Anthropic). */
function resolveModelConfig(): ModelConfig | undefined {
  if (process.env.OPENMODEL_API_KEY) {
    return {
      apiKey: process.env.OPENMODEL_API_KEY,
      baseURL: process.env.OPENMODEL_BASE_URL ?? DEFAULT_OPENMODEL_BASE_URL,
      model: process.env.EVAL_MODEL ?? DEFAULT_OPENMODEL_MODEL,
      label: 'OpenModel',
    };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseURL: process.env.ANTHROPIC_BASE_URL,
      model: process.env.EVAL_MODEL ?? DEFAULT_ANTHROPIC_MODEL,
      label: 'Anthropic',
    };
  }
  return undefined;
}

function loadCases(): EvalCase[] {
  const raw = readFileSync(join(here, 'cases', 'discovery.json'), 'utf8');
  return JSON.parse(raw) as EvalCase[];
}

async function main(): Promise<void> {
  const config = resolveModelConfig();
  if (!config) {
    console.error('Set OPENMODEL_API_KEY (recommended — free deepseek-v4-flash) or ANTHROPIC_API_KEY first.');
    process.exit(1);
  }
  console.log(`Provider: ${config.label}  |  model: ${config.model}${config.baseURL ? `  |  baseURL: ${config.baseURL}` : ''}`);
  const only = process.argv.find((a) => a.startsWith('--mode='))?.split('=')[1] as HarnessMode | undefined;
  const cases = loadCases();
  // Free gateways (e.g. OpenModel deepseek) enforce a per-user rate limit; throttle
  // between model calls. Override with EVAL_REQUEST_DELAY_MS.
  const defaultDelay = config.label === 'OpenModel' ? 2000 : 0;
  const requestDelayMs = process.env.EVAL_REQUEST_DELAY_MS
    ? Number(process.env.EVAL_REQUEST_DELAY_MS)
    : defaultDelay;
  const adapter = new ClaudeMcpAdapter({
    serverEntry,
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    model: config.model,
    requestDelayMs,
  });

  const modes: HarnessMode[] = only ? [only] : ['upfront', 'lazy'];
  const reports = new Map<HarnessMode, Awaited<ReturnType<typeof runSuite>>>();
  for (const mode of modes) {
    console.log(`\n=== Running ${cases.length} cases in "${mode}" mode ===`);
    const report = await runSuite(adapter, cases, mode);
    reports.set(mode, report);
    console.log(`success rate:            ${(report.successRate * 100).toFixed(0)}%`);
    console.log(`mean bootstrap tax:      ${report.meanBootstrapTax.toFixed(0)} input tokens`);
    console.log(`success per 1k input:    ${report.successPer1kInputTokens.toFixed(3)}`);
  }

  const upfront = reports.get('upfront');
  const lazy = reports.get('lazy');
  if (upfront && lazy) {
    const gate = evaluateGates(upfront, lazy, { maxSuccessDropPct: 3, minBootstrapDropPct: 20 });
    console.log(`\n=== Gate (lazy vs upfront): ${gate.pass ? 'PASS' : 'FAIL'} ===`);
    for (const r of gate.reasons) console.log(`  - ${r}`);
    if (!gate.pass) process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
