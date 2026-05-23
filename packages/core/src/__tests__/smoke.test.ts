import { BridgeService } from '../bridge-service.js';
import { createHttpServer } from '../http-server.js';
import { RobloxStudioTools } from '../tools/index.js';
import request from 'supertest';

describe('Smoke Tests - Connection Fixes', () => {
  test('BridgeService should be instantiable', () => {
    const bridge = new BridgeService();
    expect(bridge).toBeDefined();
    expect(bridge.getPendingRequest()).toBeNull();
  });

  test('HTTP server should start and respond to health check', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    const app = createHttpServer(tools, bridge);

    const response = await request(app)
      .get('/health')
      .expect(200);

    expect(response.body.status).toBe('ok');
    expect(response.body.service).toBe('robloxstudio-mcp');
  });

  test('clearAllPendingRequests should clear all requests', async () => {
    const bridge = new BridgeService();

    const promise1 = bridge.sendRequest('/test1', {});
    const promise2 = bridge.sendRequest('/test2', {});

    expect(bridge.getPendingRequest()).toBeTruthy();

    bridge.clearAllPendingRequests();

    expect(bridge.getPendingRequest()).toBeNull();

    await expect(promise1).rejects.toThrow('Connection closed');
    await expect(promise2).rejects.toThrow('Connection closed');
  });

  test('Disconnect endpoint should clear pending requests', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    const app = createHttpServer(tools, bridge);

    await request(app).post('/ready').send({ instanceId: 'test', role: 'edit' }).expect(200);

    const pendingPromise = bridge.sendRequest('/test', { data: 'test' });
    pendingPromise.catch(() => {});

    await request(app)
      .post('/disconnect')
      .send({ instanceId: 'test' })
      .expect(200);

    await expect(pendingPromise).rejects.toThrow('disconnected');
  });

  test('Connection states should update correctly', async () => {
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    const app = createHttpServer(tools, bridge) as any;

    expect(app.isPluginConnected()).toBe(false);

    await request(app).post('/ready').send({ instanceId: 'test', role: 'edit' }).expect(200);
    expect(app.isPluginConnected()).toBe(true);

    await request(app).post('/disconnect').send({ instanceId: 'test' }).expect(200);
    expect(app.isPluginConnected()).toBe(false);
  });
});
