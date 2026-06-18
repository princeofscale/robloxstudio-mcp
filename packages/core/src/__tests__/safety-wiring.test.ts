import { RobloxStudioTools } from '../tools/index.js';
import { BridgeService } from '../bridge-service.js';

// These tests prove the safety layer short-circuits destructive operations
// BEFORE any bridge/network call. With no plugin connected, a real network
// attempt would reject with a RoutingFailure; a clean gated result instead
// proves the guard fired first.

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
  const node = result.content.find((c) => c.type === 'text');
  return node?.text ?? '';
}

describe('safety wiring on destructive tools', () => {
  let tools: RobloxStudioTools;

  beforeEach(() => {
    tools = new RobloxStudioTools(new BridgeService());
  });

  it('gates a protected-service delete without confirmation', async () => {
    const result = await tools.deleteObject('ServerScriptService', undefined, {});
    const text = firstText(result);
    expect(text).toMatch(/confirm/i);
    expect(text).toMatch(/protected/i);
  });

  it('previews a protected delete in dry-run mode without mutating', async () => {
    const result = await tools.deleteObject('Workspace', undefined, { dryRun: true });
    const text = firstText(result);
    expect(text).toMatch(/dry.?run|preview/i);
  });

  it('gates execute_luau containing a destructive pattern', async () => {
    const result = await tools.executeLuau('workspace:ClearAllChildren()', undefined, undefined, {});
    const text = firstText(result);
    expect(text).toMatch(/confirm/i);
  });

  it('exposes recorded operations through getOperationHistory', async () => {
    await tools.deleteObject('ServerScriptService', undefined, { dryRun: true });
    const result = await tools.getOperationHistory();
    const text = firstText(result);
    expect(text).toMatch(/ServerScriptService|delete|history/i);
  });

  it('reports clearly when restoring a backup that does not exist', async () => {
    const result = await tools.restoreScriptBackup('Workspace.NopeScript');
    const text = firstText(result);
    expect(text).toMatch(/no backup/i);
  });

  it('gates terrain_clear_region until confirmed', async () => {
    const result = await tools.terrainClearRegion({ min: [0, 0, 0], max: [50, 20, 50] });
    const text = firstText(result);
    expect(text).toMatch(/confirm/i);
  });

  it('blocks a terrain fill that exceeds the volume limit', async () => {
    const result = await tools.terrainGenerateBaseplate({ size: [100000, 100000, 100000], confirm: true });
    const text = firstText(result);
    expect(text).toMatch(/blocked|limit/i);
  });

  it('returns a clean error for an unknown lighting preset without hitting the bridge', async () => {
    const result = await tools.environmentSetLightingPreset('banana');
    const text = firstText(result);
    expect(text).toMatch(/unknown preset/i);
  });
});
