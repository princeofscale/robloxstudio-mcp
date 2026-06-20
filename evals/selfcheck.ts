// Deterministic self-check for the eval graders — no model/network. Run with:
//   npx tsx evals/selfcheck.ts
// Exits non-zero on failure so it can gate CI even without a live model adapter.

import { bootstrapTax, scoreTrajectory, successPer1kInputTokens, type TraceEvent, type RunMetrics } from './metrics.js';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (!cond) {
    failures += 1;
    console.error(`FAIL: ${name}`);
  } else {
    console.log(`ok: ${name}`);
  }
}

const trace: TraceEvent[] = [
  { t: 0, type: 'model', tokensIn: 1200 },
  { t: 1, type: 'tool_call', name: 'tool_catalog_search' },
  { t: 2, type: 'tool_result', name: 'tool_catalog_search' },
  { t: 3, type: 'model', tokensIn: 300 },
  { t: 4, type: 'tool_call', name: 'load_toolset' },
  { t: 5, type: 'model', tokensIn: 200 },
  { t: 6, type: 'tool_call', name: 'get_world_snapshot' }, // first world read
  { t: 7, type: 'tool_call', name: 'execute_luau', isError: true }, // forbidden + invalid
];

// bootstrap tax counts model tokens before the first world read: 1200 + 300 + 200 = 1700
check('bootstrapTax sums model tokens before first world read', bootstrapTax(trace) === 1700);

const scores = scoreTrajectory(trace, {
  goldToolsAnyOf: [['tool_catalog_search', 'load_toolset', 'get_world_snapshot']],
  allowedTools: ['tool_catalog_search', 'load_toolset', 'get_world_snapshot'],
  forbiddenTools: ['execute_luau'],
});
check('recall is full when all gold tools were called', scores.toolSelectionRecall === 1);
check('execute_luau counted as unnecessary (forbidden/not allowed)', scores.unnecessaryCallsPerRun === 1);
check('invalid call rate reflects the errored call', scores.invalidCallRate > 0);

const runs: RunMetrics[] = [
  { initInputTokens: 1700, cumulativeInputTokens: 5000, cumulativeOutputTokens: 400, toolSchemaTokensSeen: 800, toolCalls: 4, distinctToolsCalled: 4, unnecessaryToolCalls: 1, invalidToolCalls: 1, retriesAfterRecoverableError: 0, wallClockMs: 1000, success: true },
  { initInputTokens: 1700, cumulativeInputTokens: 5000, cumulativeOutputTokens: 400, toolSchemaTokensSeen: 800, toolCalls: 4, distinctToolsCalled: 4, unnecessaryToolCalls: 0, invalidToolCalls: 0, retriesAfterRecoverableError: 0, wallClockMs: 1000, success: false },
];
// 1 success / 10000 input tokens * 1000 = 0.1
check('successPer1kInputTokens computes correctly', Math.abs(successPer1kInputTokens(runs) - 0.1) < 1e-9);

if (failures > 0) {
  console.error(`\n${failures} self-check(s) failed.`);
  process.exit(1);
}
console.log('\nAll eval graders pass.');
