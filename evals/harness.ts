// Paired A/B harness skeleton for measuring MCP optimizations (research review #6).
// The model-driving adapter is intentionally an interface: plug in your own client
// (Claude/Codex) + an MCP client transport. The harness loads cases, runs each in
// the requested mode, and aggregates metrics + gates so CI can fail on regressions.
//
// Wire an adapter, then: `tsx evals/harness.ts` (or import runSuite from your runner).

import type { RunMetrics, TraceEvent, TrajectoryScores } from './metrics.js';
import { bootstrapTax, scoreTrajectory, successPer1kInputTokens } from './metrics.js';

export type HarnessMode = 'upfront' | 'lazy';

export interface EvalCase {
  id: string;
  prompt: string;
  allowed_domains?: string[];
  allowedTools?: string[];
  forbiddenTools?: string[];
  gold_tools_any_of: string[][];
  must_contain_facts?: string[];
  grade_type: 'trajectory' | 'answer' | 'trajectory+answer';
}

export interface RunResult {
  finalAnswer: string;
  trace: TraceEvent[];
  metrics: RunMetrics;
}

/** Implement this against your model + MCP client. */
export interface McpHarnessAdapter {
  startServer(mode: HarnessMode): Promise<void>;
  runTask(task: EvalCase): Promise<RunResult>;
  stopServer(): Promise<void>;
}

export interface CaseReport {
  id: string;
  mode: HarnessMode;
  success: boolean;
  bootstrapTax: number;
  scores: TrajectoryScores;
  metrics: RunMetrics;
}

export interface SuiteReport {
  mode: HarnessMode;
  cases: CaseReport[];
  successRate: number;
  successPer1kInputTokens: number;
  meanBootstrapTax: number;
}

export async function runSuite(adapter: McpHarnessAdapter, cases: EvalCase[], mode: HarnessMode): Promise<SuiteReport> {
  await adapter.startServer(mode);
  const reports: CaseReport[] = [];
  try {
    for (const c of cases) {
      const res = await adapter.runTask(c);
      reports.push({
        id: c.id,
        mode,
        success: res.metrics.success,
        bootstrapTax: bootstrapTax(res.trace),
        scores: scoreTrajectory(res.trace, {
          goldToolsAnyOf: c.gold_tools_any_of,
          allowedTools: c.allowedTools,
          forbiddenTools: c.forbiddenTools,
        }),
        metrics: res.metrics,
      });
    }
  } finally {
    await adapter.stopServer();
  }
  const metrics = reports.map((r) => r.metrics);
  return {
    mode,
    cases: reports,
    successRate: reports.length === 0 ? 0 : reports.filter((r) => r.success).length / reports.length,
    successPer1kInputTokens: successPer1kInputTokens(metrics),
    meanBootstrapTax: reports.length === 0 ? 0 : reports.reduce((s, r) => s + r.bootstrapTax, 0) / reports.length,
  };
}

/** CI gates from the review: success must not regress; efficiency must improve. */
export function evaluateGates(baseline: SuiteReport, candidate: SuiteReport, opts = { maxSuccessDropPct: 3, minBootstrapDropPct: 0 }): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const successDropPct = (baseline.successRate - candidate.successRate) * 100;
  if (successDropPct > opts.maxSuccessDropPct) {
    reasons.push(`success regressed ${successDropPct.toFixed(1)}pp (> ${opts.maxSuccessDropPct})`);
  }
  const bootstrapDropPct = baseline.meanBootstrapTax === 0
    ? 0
    : ((baseline.meanBootstrapTax - candidate.meanBootstrapTax) / baseline.meanBootstrapTax) * 100;
  if (bootstrapDropPct < opts.minBootstrapDropPct) {
    reasons.push(`bootstrap tax improved only ${bootstrapDropPct.toFixed(1)}% (< ${opts.minBootstrapDropPct})`);
  }
  return { pass: reasons.length === 0, reasons };
}
