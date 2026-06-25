import { diffEpisodes, proposeNextAction, failedAssertionsOf, implicatedScriptsOf } from '../tools/episode-reasoning.js';

const failEp = {
  episodeId: 'ep_fail',
  verdict: 'fail',
  logs: { errorCount: 2, errors: [{ message: 'attempt to index nil ServerScriptService.Main' }, { message: 'boom' }] },
  assertions: { allPassed: false, results: [{ name: 'has_spawn', passed: true }, { name: 'door_opens', passed: false }] },
};
const passEp = {
  episodeId: 'ep_pass',
  verdict: 'pass',
  logs: { errorCount: 0, errors: [] },
  assertions: { allPassed: true, results: [{ name: 'has_spawn', passed: true }, { name: 'door_opens', passed: true }] },
};

describe('episode-reasoning extractors', () => {
  it('extracts failed assertions and implicated scripts', () => {
    expect(failedAssertionsOf(failEp)).toEqual(['door_opens']);
    expect(implicatedScriptsOf(failEp)).toContain('ServerScriptService.Main');
    expect(failedAssertionsOf(passEp)).toEqual([]);
  });
});

describe('diffEpisodes', () => {
  it('reports fail→pass as fixed with resolved errors and assertion transitions', () => {
    const d = diffEpisodes(failEp, passEp, 'ep_fail');
    expect(d.fixed).toBe(true);
    expect(d.regressed).toBe(false);
    expect(d.errorCountDelta).toBe(-2);
    expect(d.resolvedErrors).toContain('boom');
    expect(d.newErrors).toEqual([]);
    expect(d.assertionTransitions).toEqual([{ name: 'door_opens', was: false, now: true }]);
  });

  it('reports pass→fail as regressed with new errors', () => {
    const d = diffEpisodes(passEp, failEp, 'ep_pass');
    expect(d.regressed).toBe(true);
    expect(d.fixed).toBe(false);
    expect(d.errorCountDelta).toBe(2);
    expect(d.newErrors).toContain('boom');
  });
});

describe('proposeNextAction', () => {
  it('proposes running an episode when none exist', () => {
    const a = proposeNextAction(undefined);
    expect(a.action).toBe('run_episode');
    expect(a.tool).toBe('run_playtest_episode');
    expect(a.done).toBe(false);
  });

  it('targets the failing assertion first', () => {
    const a = proposeNextAction(failEp);
    expect(a.action).toBe('fix_assertion');
    expect(a.focus).toEqual(['door_opens']);
    expect(a.tool).toBeNull();
  });

  it('points at implicated scripts when errors but no failed assertion', () => {
    const errOnly = { episodeId: 'ep_e', verdict: 'fail', logs: { errorCount: 1, errors: [{ message: 'nil index ServerScriptService.Main' }] } };
    const a = proposeNextAction(errOnly);
    expect(a.action).toBe('fix_script');
    expect(a.focus).toContain('ServerScriptService.Main');
  });

  it('handles startup failure', () => {
    const a = proposeNextAction({ episodeId: 'ep_x', verdict: 'error' });
    expect(a.action).toBe('fix_startup');
  });

  it('proposes proving the fix when a clean run follows a failing one', () => {
    const a = proposeNextAction(passEp, failEp);
    expect(a.action).toBe('prove_fix');
    expect(a.tool).toBe('summarize_episode');
    expect(a.args).toEqual({ episodeId: 'ep_pass', comparedToEpisodeId: 'ep_fail' });
  });

  it('declares done for a clean run with no prior failure', () => {
    const a = proposeNextAction(passEp);
    expect(a.action).toBe('done');
    expect(a.done).toBe(true);
  });
});
