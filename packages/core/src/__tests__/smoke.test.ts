import { BridgeService } from '../bridge-service.js';
import { createHttpServer } from '../http-server.js';
import { RobloxStudioTools } from '../tools/index.js';
import request from 'supertest';

const READY = {
  pluginSessionId: 'session-1',
  instanceId: 'place:test',
  role: 'edit',
  placeId: 0,
  placeName: 'TestPlace',
  dataModelName: 'TestPlace',
  isRunning: false,
};

describe('Smoke', () => {
  test('BridgeService instantiable', () => {
    const bridge = new BridgeService();
    expect(bridge).toBeDefined();
    expect(bridge.getPendingRequest('place:nope', 'edit')).toBeNull();
  });

  test('HTTP server starts and responds to health check', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    const app = createHttpServer(tools, bridge);

    const response = await request(app).get('/health').expect(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.service).toBe('robloxstudio-mcp');
  });

  test('clearAllPendingRequests rejects all pending', async () => {
    const bridge = new BridgeService();
    const p1 = bridge.sendRequest('/test1', {}, 'place:test', 'edit');
    const p2 = bridge.sendRequest('/test2', {}, 'place:test', 'edit');
    expect(bridge.getPendingRequest('place:test', 'edit')).toBeTruthy();
    bridge.clearAllPendingRequests();
    expect(bridge.getPendingRequest('place:test', 'edit')).toBeNull();
    await expect(p1).rejects.toThrow('Connection closed');
    await expect(p2).rejects.toThrow('Connection closed');
  });

  test('Disconnect rejects pending requests for that (instanceId, role)', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    const app = createHttpServer(tools, bridge);

    await request(app).post('/ready').send(READY).expect(200);
    const pending = bridge.sendRequest('/test', {}, 'place:test', 'edit');
    pending.catch(() => {});
    await request(app).post('/disconnect').send({ pluginSessionId: 'session-1' }).expect(200);
    await expect(pending).rejects.toThrow(/disconnected/);
  });

  test('Connection state lifecycle', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    const app = createHttpServer(tools, bridge) as any;
    expect(app.isPluginConnected()).toBe(false);
    await request(app).post('/ready').send(READY).expect(200);
    expect(app.isPluginConnected()).toBe(true);
    await request(app).post('/disconnect').send({ pluginSessionId: 'session-1' }).expect(200);
    expect(app.isPluginConnected()).toBe(false);
  });

  test('start_playtest rejects numPlayers', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    await expect(tools.startPlaytest('play', 1)).rejects.toThrow(/multiplayer_test_start/);
  });

  test('start_playtest play mode waits for fresh server and client peers', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);

    const resultPromise = tools.startPlaytest('play');
    const pending = bridge.getPendingRequest('place:test', 'edit');
    expect(pending).toBeTruthy();
    bridge.resolveRequest(pending!.requestId, { success: true, message: 'started' });

    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    }, () => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    bridge.registerInstance({
      pluginSessionId: 'server-1',
      instanceId: 'place:test',
      role: 'server',
      placeId: 0,
      placeName: 'TestPlace',
      dataModelName: 'TestPlace',
      isRunning: true,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    bridge.registerInstance({
      pluginSessionId: 'client-1',
      instanceId: 'place:test',
      role: 'client',
      placeId: 0,
      placeName: 'TestPlace',
      dataModelName: 'TestPlace',
      isRunning: true,
    });

    const result = await resultPromise;
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({
      success: true,
      runtimeReady: true,
      timedOut: false,
    });
    expect(body.roles).toContain('server');
    expect(body.roles).toContain('client-1');
  });

  test('start_playtest run mode waits only for a fresh server peer', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);

    const resultPromise = tools.startPlaytest('run');
    const pending = bridge.getPendingRequest('place:test', 'edit');
    expect(pending).toBeTruthy();
    bridge.resolveRequest(pending!.requestId, { success: true, message: 'started' });

    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    }, () => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    bridge.registerInstance({
      pluginSessionId: 'server-1',
      instanceId: 'place:test',
      role: 'server',
      placeId: 0,
      placeName: 'TestPlace',
      dataModelName: 'TestPlace',
      isRunning: true,
    });

    const result = await resultPromise;
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({
      success: true,
      runtimeReady: true,
      timedOut: false,
    });
    expect(body.roles).toContain('server');
    expect(body.roles).not.toContain('client-1');
  });

  test('get_scene_analysis fans out to connected peers', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    bridge.registerInstance(READY);
    bridge.registerInstance({
      pluginSessionId: 'server-1',
      instanceId: 'place:test',
      role: 'server',
      placeId: 0,
      placeName: 'TestPlace',
      dataModelName: 'TestPlace',
      isRunning: true,
    });

    const resultPromise = tools.getSceneAnalysis('script_memory', 'all', 5, false, 'place:test');
    const editPending = bridge.getPendingRequest('place:test', 'edit');
    const serverPending = bridge.getPendingRequest('place:test', 'server');
    expect(editPending?.request).toMatchObject({
      endpoint: '/api/get-scene-analysis',
      data: { mode: 'script_memory', topN: 5, raw: false },
    });
    expect(serverPending?.request).toMatchObject({
      endpoint: '/api/get-scene-analysis',
      data: { mode: 'script_memory', topN: 5, raw: false },
    });

    bridge.resolveRequest(editPending!.requestId, { mode: 'script_memory', peer: 'edit' });
    bridge.resolveRequest(serverPending!.requestId, { mode: 'script_memory', peer: 'server' });

    const result = await resultPromise;
    const body = JSON.parse(result.content[0].text);
    expect(body).toEqual({
      edit: { mode: 'script_memory', peer: 'edit' },
      server: { mode: 'script_memory', peer: 'server' },
    });
  });
});
