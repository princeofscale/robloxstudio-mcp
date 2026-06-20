// Trajectory + token metrics for the MCP eval harness. Pure functions over a
// recorded run trace — no model/network here, so they're deterministic and
// unit-checkable (see selfcheck.ts). The harness (harness.ts) produces traces;
// these turn them into the numbers the research review asked for: bootstrap tax,
// tool-selection precision/recall, unnecessary calls, success-per-1k-tokens.

export interface TraceEvent {
  t: number;
  type: 'model' | 'tool_call' | 'tool_result' | 'error';
  name?: string;
  args?: unknown;
  resultSummary?: unknown;
  tokensIn?: number;
  tokensOut?: number;
  isError?: boolean;
}

export interface RunMetrics {
  initInputTokens: number; // cost up to the first useful world read
  cumulativeInputTokens: number;
  cumulativeOutputTokens: number;
  toolSchemaTokensSeen: number;
  toolCalls: number;
  distinctToolsCalled: number;
  unnecessaryToolCalls: number;
  invalidToolCalls: number;
  retriesAfterRecoverableError: number;
  wallClockMs: number;
  success: boolean;
}

export interface TrajectoryScores {
  toolSelectionPrecision: number; // share of calls that were expected/allowed
  toolSelectionRecall: number; // share of gold tools that were actually called
  unnecessaryCallsPerRun: number;
  invalidCallRate: number;
}

const firstWorldReadTools = new Set([
  'get_world_snapshot',
  'get_scene_summary',
  'get_node_batch',
  'get_instance_children',
  'get_descendants',
]);

/** Tokens spent before the first real world read — what lazy loading should cut. */
export function bootstrapTax(trace: TraceEvent[]): number {
  let tokens = 0;
  for (const e of trace) {
    if (e.type === 'model') tokens += e.tokensIn ?? 0;
    if (e.type === 'tool_call' && e.name && firstWorldReadTools.has(e.name)) break;
  }
  return tokens;
}

/** Successful runs per 1k cumulative input tokens — penalizes cheap-but-dumb modes. */
export function successPer1kInputTokens(runs: RunMetrics[]): number {
  const totalInput = runs.reduce((s, r) => s + r.cumulativeInputTokens, 0);
  const successes = runs.filter((r) => r.success).length;
  if (totalInput === 0) return 0;
  return (successes / totalInput) * 1000;
}

/**
 * Score the tool-call trajectory against a gold spec. `goldToolsAnyOf` is a list of
 * acceptable tool-name sets (any one fully satisfies recall); `allowedTools`
 * constrains precision (calls outside it are "unnecessary").
 */
export function scoreTrajectory(
  trace: TraceEvent[],
  spec: { goldToolsAnyOf: string[][]; allowedTools?: string[]; forbiddenTools?: string[] },
): TrajectoryScores {
  const calls = trace.filter((e) => e.type === 'tool_call' && e.name).map((e) => e.name as string);
  const invalid = trace.filter((e) => e.type === 'tool_call' && e.isError).length;
  const allowed = spec.allowedTools ? new Set(spec.allowedTools) : undefined;
  const forbidden = new Set(spec.forbiddenTools ?? []);

  // Best-matching gold set: the one with the highest recall.
  let bestRecall = 0;
  for (const gold of spec.goldToolsAnyOf) {
    if (gold.length === 0) continue;
    const called = new Set(calls);
    const hit = gold.filter((g) => called.has(g)).length;
    bestRecall = Math.max(bestRecall, hit / gold.length);
  }

  const goldUnion = new Set(spec.goldToolsAnyOf.flat());
  const necessary = calls.filter((c) => goldUnion.has(c) && !forbidden.has(c)).length;
  const unnecessary = calls.filter((c) => (allowed ? !allowed.has(c) : !goldUnion.has(c)) || forbidden.has(c)).length;

  return {
    toolSelectionPrecision: calls.length === 0 ? 0 : necessary / calls.length,
    toolSelectionRecall: bestRecall,
    unnecessaryCallsPerRun: unnecessary,
    invalidCallRate: calls.length === 0 ? 0 : invalid / calls.length,
  };
}
