import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';

const READY = {
  pluginSessionId: 'session-1',
  instanceId: 'place:test',
  role: 'edit' as const,
  placeId: 0,
  placeName: 'TestPlace',
  dataModelName: 'TestPlace',
  isRunning: false,
};

describe('contracted execute-luau tool normalization', () => {
  it('returns the world snapshot domain object instead of the bridge envelope', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);

    const resultPromise = tools.getWorldSnapshot(undefined, undefined, undefined, 'place:test');

    const pending = bridge.getPendingRequest('place:test', 'edit');
    expect(pending?.request).toMatchObject({ endpoint: '/api/execute-luau' });
    bridge.resolveRequest(pending!.requestId, {
      success: true,
      returnValue: JSON.stringify({ root: 'game', level: 'overview', counts: { descendants: 3 } }),
      output: 'ignored envelope output',
    });

    await expect(resultPromise).resolves.toEqual({
      content: [{
        type: 'text',
        text: JSON.stringify({ root: 'game', level: 'overview', counts: { descendants: 3 } }),
      }],
    });
  });

  it('returns the playtest telemetry domain object instead of the bridge envelope', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);

    const resultPromise = tools.playtestSampleState(['runtime'], 'edit', 'place:test');

    const pending = bridge.getPendingRequest('place:test', 'edit');
    expect(pending?.request).toMatchObject({ endpoint: '/api/execute-luau' });
    bridge.resolveRequest(pending!.requestId, {
      success: true,
      returnValue: JSON.stringify({ runtime: { isRunning: false, isStudio: true } }),
      output: 'ignored envelope output',
    });

    await expect(resultPromise).resolves.toEqual({
      content: [{
        type: 'text',
        text: JSON.stringify({ runtime: { isRunning: false, isStudio: true } }),
      }],
    });
  });
});
