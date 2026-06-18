import {
  buildObbyTemplateLuau,
  buildSimulatorTemplateLuau,
  buildTycoonTemplateLuau,
  buildRoundTemplateLuau,
} from '../builders/template-builders.js';

// Templates compile to one self-contained Luau blueprint executed in edit
// context. The tests assert the key structural pieces each game type must
// produce, plus that the generated code is balanced (returns a summary).

describe('buildObbyTemplateLuau', () => {
  const code = buildObbyTemplateLuau({ checkpoints: 4 });
  it('creates a spawn, checkpoints, kill bricks, a finish, and leaderstats', () => {
    expect(code).toContain('SpawnLocation');
    expect(code).toContain('Checkpoint');
    expect(code).toContain('KillBrick');
    expect(code).toContain('Finish');
    expect(code).toContain('leaderstats');
  });
  it('wires checkpoint touches and a timer UI', () => {
    expect(code).toMatch(/Touched/);
    expect(code).toContain('ScreenGui');
    expect(code).toContain('return');
  });
  it('respects the requested checkpoint count', () => {
    expect(code).toContain('NUM_CHECKPOINTS = 4');
  });
});

describe('buildSimulatorTemplateLuau', () => {
  const code = buildSimulatorTemplateLuau({ currencyName: 'Coins' });
  it('creates a currency leaderstat, a click button, a shop and a data module', () => {
    expect(code).toContain('leaderstats');
    expect(code).toContain('Coins');
    expect(code).toContain('TextButton');
    expect(code).toContain('Shop');
    expect(code).toContain('ModuleScript');
  });
});

describe('buildTycoonTemplateLuau', () => {
  const code = buildTycoonTemplateLuau({});
  it('creates a plot, buttons, a cash system and a purchase flow', () => {
    expect(code).toContain('Plot');
    expect(code).toContain('Cash');
    expect(code).toContain('Button');
    expect(code).toMatch(/Touched|ProximityPrompt/);
  });
});

describe('buildRoundTemplateLuau', () => {
  const code = buildRoundTemplateLuau({ roundSeconds: 60 });
  it('creates a lobby, teleport points and a round loop', () => {
    expect(code).toContain('Lobby');
    expect(code).toContain('Teleport');
    expect(code).toContain('ROUND_SECONDS = 60');
    expect(code).toMatch(/while true do|RunService/);
  });
});
