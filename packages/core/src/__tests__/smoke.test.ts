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
});
