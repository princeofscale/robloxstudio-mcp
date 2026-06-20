import { buildSceneSearchLuau } from '../builders/scene-search.js';

describe('buildSceneSearchLuau', () => {
  it('tokenizes the query and scores multiple signals (name/tags/attrs/parent/class)', () => {
    const code = buildSceneSearchLuau('shop ui', 'game');
    expect(code).toContain('resolvePath("game")');
    expect(code).toContain('string.gmatch(query, "[%w]+")');
    expect(code).toContain('countHits(name, term, 5)');
    expect(code).toContain('countHits(tagStr, term, 4)');
    expect(code).toContain('countHits(attrStr, term, 3)');
    expect(code).toContain('d:GetTags()');
    expect(code).toContain('d:GetAttributes()');
  });

  it('lowercases the query and clamps the limit', () => {
    expect(buildSceneSearchLuau('DoorSystem', 'game', 3)).toContain('"doorsystem"');
    expect(buildSceneSearchLuau('x', 'game', 3)).toContain('math.min(3, #scored)');
    expect(buildSceneSearchLuau('x', 'game', 999)).toContain('math.min(50, #scored)');
  });

  it('ranks by score and returns a bounded result set', () => {
    const code = buildSceneSearchLuau('tree');
    expect(code).toContain('table.sort(scored, function(a, b) return a.score > b.score end)');
    expect(code).toContain('results = top');
  });

  it('escapes a hostile query and path', () => {
    const code = buildSceneSearchLuau('a"]; os.exit() --', 'game.Workspace["X"]');
    expect(code).not.toContain('os.exit() --,');
    expect(code).toContain('\\"');
  });
});
