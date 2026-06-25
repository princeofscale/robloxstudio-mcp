// Deterministic reasoning over stored playtest episodes (Track E — self-driving
// loop polish). Pure functions, no Studio round-trip: they read the episode
// objects produced by run_playtest_episode and decide (a) what changed between
// two runs (richer than the old verdict-only diff) and (b) the single concrete
// next action an agent should take. Keeping this deterministic means the
// edit→playtest→observe→fix loop doesn't burn an LLM turn just to pick the
// obvious next step. ponytail: heuristics over error/assertion text, not a model.

export interface EpisodeLike {
  episodeId?: unknown;
  verdict?: unknown;
  mode?: unknown;
  logs?: unknown;
  assertions?: unknown;
}

export interface EpisodeDiff {
  comparedTo: string;
  previousVerdict: unknown;
  currentVerdict: unknown;
  fixed: boolean;        // fail/error → pass
  regressed: boolean;    // pass → fail/error
  stillFailing: boolean; // non-pass → non-pass
  errorCountDelta: number;
  newErrors: string[];     // error lines present now but not before
  resolvedErrors: string[]; // error lines present before but not now
  assertionTransitions: Array<{ name: string; was: boolean | undefined; now: boolean | undefined }>;
}

export interface NextAction {
  action: 'run_episode' | 'fix_startup' | 'fix_assertion' | 'fix_script' | 'prove_fix' | 'done';
  done: boolean;
  rationale: string;
  // The concrete MCP call the agent should make next, when one is mechanical.
  // null when the next step is a human/LLM edit (we name the target instead).
  tool: string | null;
  args?: Record<string, unknown>;
  // Scripts/assertions the agent should look at before the next call.
  focus?: string[];
}

function errorLinesOf(ep: EpisodeLike): string[] {
  const logs = (ep.logs ?? {}) as { errors?: Array<{ message?: unknown }> };
  return (logs.errors ?? [])
    .map((e) => String(e?.message ?? '').trim())
    .filter((m) => m.length > 0);
}

function errorCountOf(ep: EpisodeLike): number {
  const logs = (ep.logs ?? {}) as { errorCount?: unknown; errors?: unknown[] };
  if (typeof logs.errorCount === 'number') return logs.errorCount;
  return errorLinesOf(ep).length;
}

function assertionResultsOf(ep: EpisodeLike): Map<string, boolean | undefined> {
  const a = ep.assertions as { results?: Array<{ name?: unknown; passed?: unknown }> } | undefined;
  const out = new Map<string, boolean | undefined>();
  for (const r of a?.results ?? []) {
    const name = typeof r?.name === 'string' ? r.name : undefined;
    if (name === undefined) continue;
    out.set(name, typeof r?.passed === 'boolean' ? r.passed : undefined);
  }
  return out;
}

export function failedAssertionsOf(ep: EpisodeLike): string[] {
  const out: string[] = [];
  for (const [name, passed] of assertionResultsOf(ep)) {
    if (passed === false) out.push(name);
  }
  return out;
}

// Best-effort: pull script-ish dotted names (Foo.Bar, ServerScriptService.X) out
// of error text so the agent knows which script to open.
export function implicatedScriptsOf(ep: EpisodeLike): string[] {
  const names = errorLinesOf(ep).flatMap(
    (line) => line.match(/[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+/g) ?? [],
  );
  return Array.from(new Set(names)).slice(0, 10);
}

const isPass = (v: unknown) => v === 'pass';

export function diffEpisodes(prev: EpisodeLike, curr: EpisodeLike, comparedTo: string): EpisodeDiff {
  const prevErrors = new Set(errorLinesOf(prev));
  const currErrors = new Set(errorLinesOf(curr));
  const newErrors = [...currErrors].filter((e) => !prevErrors.has(e)).slice(0, 20);
  const resolvedErrors = [...prevErrors].filter((e) => !currErrors.has(e)).slice(0, 20);

  const prevAssertions = assertionResultsOf(prev);
  const currAssertions = assertionResultsOf(curr);
  const assertionTransitions: EpisodeDiff['assertionTransitions'] = [];
  for (const name of new Set([...prevAssertions.keys(), ...currAssertions.keys()])) {
    const was = prevAssertions.get(name);
    const now = currAssertions.get(name);
    if (was !== now) assertionTransitions.push({ name, was, now });
  }

  const prevPass = isPass(prev.verdict);
  const currPass = isPass(curr.verdict);
  return {
    comparedTo,
    previousVerdict: prev.verdict,
    currentVerdict: curr.verdict,
    fixed: !prevPass && currPass,
    regressed: prevPass && !currPass,
    stillFailing: !prevPass && !currPass,
    errorCountDelta: errorCountOf(curr) - errorCountOf(prev),
    newErrors,
    resolvedErrors,
    assertionTransitions,
  };
}

// Deterministic next-step from the latest episode (and optionally the prior one,
// so a clean run that follows a failing run is recognized as a fix to prove).
export function proposeNextAction(
  latest: EpisodeLike | undefined,
  priorFailing?: EpisodeLike,
): NextAction {
  if (!latest) {
    return {
      action: 'run_episode',
      done: false,
      tool: 'run_playtest_episode',
      args: { mode: 'play' },
      rationale: 'No episode recorded yet — run one to gather runtime evidence.',
    };
  }

  const episodeId = typeof latest.episodeId === 'string' ? latest.episodeId : undefined;
  const verdict = latest.verdict;

  if (verdict === 'error') {
    return {
      action: 'fix_startup',
      done: false,
      tool: null,
      rationale:
        'The playtest never reached a ready runtime. Check the place compiles and that no other playtest is already running, then re-run run_playtest_episode.',
    };
  }

  if (verdict === 'fail') {
    const failed = failedAssertionsOf(latest);
    if (failed.length > 0) {
      return {
        action: 'fix_assertion',
        done: false,
        tool: null,
        focus: failed,
        rationale: `Assertion(s) failed: [${failed.join(', ')}]. Edit the logic behind them, then re-run run_playtest_episode${
          episodeId ? ` and summarize_episode with comparedToEpisodeId="${episodeId}"` : ''
        } to confirm fail→pass.`,
      };
    }
    const scripts = implicatedScriptsOf(latest);
    return {
      action: 'fix_script',
      done: false,
      tool: null,
      focus: scripts,
      rationale: `Runtime errors were logged${
        scripts.length ? ` implicating [${scripts.join(', ')}]` : ''
      }. Open the implicated script(s), fix the error, then re-run run_playtest_episode${
        episodeId ? ` and compare with comparedToEpisodeId="${episodeId}"` : ''
      }.`,
    };
  }

  // verdict === 'pass' (or anything non-failing): if it follows a failing run,
  // the mechanical next step is to PROVE the fix rather than declare done.
  if (priorFailing && !isPass(priorFailing.verdict) && episodeId) {
    const priorId = typeof priorFailing.episodeId === 'string' ? priorFailing.episodeId : undefined;
    if (priorId) {
      return {
        action: 'prove_fix',
        done: false,
        tool: 'summarize_episode',
        args: { episodeId, comparedToEpisodeId: priorId },
        rationale: `This clean run follows failing episode "${priorId}". Summarize with comparedToEpisodeId to record the fail→pass transition.`,
      };
    }
  }

  return {
    action: 'done',
    done: true,
    tool: null,
    rationale: 'Latest episode passed with no runtime errors or failed assertions. Nothing to fix.',
  };
}
