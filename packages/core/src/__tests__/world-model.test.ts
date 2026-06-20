import { buildNodeBatchLuau, buildWorldSnapshotLuau } from '../builders/world-model.js';

describe('buildNodeBatchLuau', () => {
  it('embeds the requested paths and fields as escaped Lua strings', () => {
    const code = buildNodeBatchLuau(['game.Workspace.A', 'game.Workspace.B'], ['Position', 'Anchored']);
    expect(code).toContain('"game.Workspace.A"');
    expect(code).toContain('"game.Workspace.B"');
    expect(code).toContain('"Position"');
    expect(code).toContain('"Anchored"');
    expect(code).toContain('resolvePath(p)');
    expect(code).toContain('count = #out');
  });

  it('reads fields defensively with pcall and serializes values', () => {
    const code = buildNodeBatchLuau(['game.Workspace.A'], ['CFrame']);
    expect(code).toContain('pcall(function() return inst[f] end)');
    expect(code).toContain('local function ser(v)');
    expect(code).toContain('"not found"');
  });

  it('omits childCount unless requested', () => {
    expect(buildNodeBatchLuau(['game.Workspace'], [], false)).toContain('if false then row.childCount');
    expect(buildNodeBatchLuau(['game.Workspace'], [], true)).toContain('if true then row.childCount');
  });

  it('escapes hostile paths instead of injecting raw Lua', () => {
    const code = buildNodeBatchLuau(['game"]; os.exit() --'], []);
    expect(code).not.toContain('game"]; os.exit() --,');
    expect(code).toContain('\\"');
  });
});

describe('buildWorldSnapshotLuau', () => {
  it('defaults to game / overview and gathers signal layers', () => {
    const code = buildWorldSnapshotLuau();
    expect(code).toContain('resolvePath("game")');
    expect(code).toContain('level = "overview"');
    expect(code).toContain('totalDescendants');
    expect(code).toContain('soundsPlaying');
    expect(code).toContain('moduleScripts');
    expect(code).toContain('tagged = taggedCount');
    expect(code).toContain('environment = env');
    expect(code).toContain('roots = roots');
    expect(code).toContain('topClasses');
  });

  it('summarizes the environment from Lighting and Workspace', () => {
    const code = buildWorldSnapshotLuau();
    expect(code).toContain('game:GetService("Lighting")');
    expect(code).toContain('lighting.ClockTime');
    expect(code).toContain('hasAtmosphere');
    expect(code).toContain('hasTerrain');
  });

  it('skips childless roots and caps the list (token-lean at game level)', () => {
    // At path=game the root has ~110 children, most of them empty services —
    // dumping them all defeats the purpose. Caught live during verification.
    const code = buildWorldSnapshotLuau();
    expect(code).toContain('local ROOT_LIMIT = 30');
    expect(code).toContain('if childCount > 0 then');
    expect(code).toContain('if #roots >= ROOT_LIMIT then break end');
  });

  it('reads capability-gated Lighting.Technology through pcall (PluginSecurity safe)', () => {
    // Reading Lighting.Technology directly throws under PluginSecurity ("lacking
    // capability RobloxScript") — it must be wrapped, caught live in dogfooding.
    const code = buildWorldSnapshotLuau();
    expect(code).toContain('safeGet(function() return tostring(lighting.Technology) end)');
    expect(code).toContain('local ok, v = pcall(fn)');
  });

  it('clamps and floors topNPerClass', () => {
    expect(buildWorldSnapshotLuau('game', 'overview', 5.8)).toContain('math.min(5, #arr)');
    expect(buildWorldSnapshotLuau('game', 'overview', 0)).toContain('math.min(1, #arr)');
  });

  it('escapes the root path', () => {
    const code = buildWorldSnapshotLuau('game.Workspace["Odd"]');
    expect(code).toContain('\\"Odd\\"');
  });
});
