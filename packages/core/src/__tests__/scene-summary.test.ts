import { buildSceneSummaryLuau } from '../builders/scene-summary.js';

describe('buildSceneSummaryLuau', () => {
  it('resolves the path and counts descendants by class', () => {
    const code = buildSceneSummaryLuau('game.Workspace');
    expect(code).toContain('resolvePath("game.Workspace")');
    expect(code).toContain('root:GetDescendants()');
    expect(code).toContain('byClass[d.ClassName]');
    expect(code).toContain('topClasses');
    expect(code).toContain('totalDescendants');
  });

  it('defaults to game.Workspace and topN 20', () => {
    const code = buildSceneSummaryLuau();
    expect(code).toContain('resolvePath("game.Workspace")');
    expect(code).toContain('math.min(20, #arr)');
  });

  it('clamps and floors topN', () => {
    expect(buildSceneSummaryLuau('game', 3.9)).toContain('math.min(3, #arr)');
    expect(buildSceneSummaryLuau('game', 0)).toContain('math.min(1, #arr)');
  });

  it('escapes the path safely', () => {
    const code = buildSceneSummaryLuau('game.Workspace["Odd Name"]');
    expect(code).not.toContain('resolvePath(game.Workspace["Odd Name"])');
    expect(code).toContain('\\"Odd Name\\"');
  });
});
