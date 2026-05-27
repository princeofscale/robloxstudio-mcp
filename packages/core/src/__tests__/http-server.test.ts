import request from 'supertest';
import { createHttpServer } from '../http-server.js';
import { RobloxStudioTools } from '../tools/index.js';
import { BridgeService } from '../bridge-service.js';
import { Application } from 'express';

const READY_BODY = {
  pluginSessionId: 'session-1',
  instanceId: 'place:test',
  role: 'edit',
  placeId: 0,
  placeName: 'TestPlace',
  dataModelName: 'TestPlace',
  isRunning: false,
};

describe('HTTP Server', () => {
  let app: Application & any;
  let bridge: BridgeService;
  let tools: RobloxStudioTools;

  beforeEach(() => {
    bridge = new BridgeService();
    tools = new RobloxStudioTools(bridge);
    app = createHttpServer(tools, bridge);
  });

  afterEach(() => {
    bridge.clearAllPendingRequests();
  });

  describe('Health Check', () => {
    test('returns health status', async () => {
      const response = await request(app).get('/health').expect(200);
      expect(response.body).toMatchObject({
        status: 'ok',
        service: 'robloxstudio-mcp',
        pluginConnected: false,
        mcpServerActive: false,
      });
    });
  });

  describe('Plugin Connection Management', () => {
    test('plugin ready notification', async () => {
      const response = await request(app).post('/ready').send(READY_BODY).expect(200);
      expect(response.body).toMatchObject({ success: true, assignedRole: 'edit', instanceId: 'place:test' });
      expect(app.isPluginConnected()).toBe(true);
    });

    test('rejects /ready without required fields', async () => {
      await request(app).post('/ready').send({}).expect(400);
    });

    test('rejects duplicate (instanceId, role) on /ready', async () => {
      await request(app).post('/ready').send(READY_BODY).expect(200);
      const dup = await request(app)
        .post('/ready')
        .send({ ...READY_BODY, pluginSessionId: 'session-2' })
        .expect(409);
      expect(dup.body.error).toBe('duplicate_instance_role');
    });

    test('plugin disconnect by pluginSessionId', async () => {
      await request(app).post('/ready').send(READY_BODY).expect(200);
      expect(app.isPluginConnected()).toBe(true);
      const response = await request(app).post('/disconnect').send({ pluginSessionId: 'session-1' }).expect(200);
      expect(response.body).toEqual({ success: true });
      expect(app.isPluginConnected()).toBe(false);
    });

    test('disconnect rejects pending requests targeting that tuple', async () => {
      await request(app).post('/ready').send(READY_BODY).expect(200);
      const p1 = bridge.sendRequest('/api/test1', {}, 'place:test', 'edit');
      const p2 = bridge.sendRequest('/api/test2', {}, 'place:test', 'edit');
      p1.catch(() => {});
      p2.catch(() => {});
      expect(bridge.getPendingRequest('place:test', 'edit')).toBeTruthy();
      await request(app).post('/disconnect').send({ pluginSessionId: 'session-1' }).expect(200);
      expect(bridge.getPendingRequest('place:test', 'edit')).toBeNull();
    });

    test('stale instance detection via unregister', () => {
      bridge.registerInstance({ pluginSessionId: 'stale-1', instanceId: 'place:s', role: 'edit' });
      expect(app.isPluginConnected()).toBe(true);
      bridge.unregisterInstance('stale-1');
      expect(app.isPluginConnected()).toBe(false);
    });
  });

  describe('Polling Endpoint', () => {
    test('503 when MCP server is not active', async () => {
      await request(app).post('/ready').send(READY_BODY).expect(200);
      const response = await request(app).get('/poll?pluginSessionId=session-1').expect(503);
      expect(response.body).toMatchObject({
        error: 'MCP server not connected',
        pluginConnected: true,
        mcpConnected: false,
        request: null,
        knownInstance: true,
      });
    });

    test('returns pending request when MCP is active and tuple matches', async () => {
      await request(app).post('/ready').send(READY_BODY).expect(200);
      app.setMCPServerActive(true);
      const pending = bridge.sendRequest('/api/test', { data: 'test' }, 'place:test', 'edit');
      pending.catch(() => {});
      const response = await request(app).get('/poll?pluginSessionId=session-1').expect(200);
      expect(response.body).toMatchObject({
        request: { endpoint: '/api/test', data: { data: 'test' } },
        mcpConnected: true,
        pluginConnected: true,
        knownInstance: true,
      });
      expect(response.body.requestId).toBeTruthy();
    });

    test('returns null when no pending request matches the polling plugin', async () => {
      await request(app).post('/ready').send(READY_BODY).expect(200);
      app.setMCPServerActive(true);
      const response = await request(app).get('/poll?pluginSessionId=session-1').expect(200);
      expect(response.body).toMatchObject({ request: null, mcpConnected: true, pluginConnected: true });
    });

    test('knownInstance=false when pluginSessionId is unknown (server restarted)', async () => {
      app.setMCPServerActive(true);
      const response = await request(app).get('/poll?pluginSessionId=unknown-session').expect(200);
      expect(response.body.knownInstance).toBe(false);
      expect(response.body.request).toBeNull();
    });
  });

  describe('Response Handling', () => {
    test('handles successful response', async () => {
      const requestPromise = bridge.sendRequest('/api/test', {}, 'place:test', 'edit');
      const pending = bridge.getPendingRequest('place:test', 'edit');
      const response = await request(app)
        .post('/response')
        .send({ requestId: pending!.requestId, response: { result: 'success' } })
        .expect(200);
      expect(response.body).toEqual({ success: true });
      const result = await requestPromise;
      expect(result).toEqual({ result: 'success' });
    });

    test('handles error response', async () => {
      const requestPromise = bridge.sendRequest('/api/test', {}, 'place:test', 'edit');
      requestPromise.catch(() => {});
      const pending = bridge.getPendingRequest('place:test', 'edit');
      await request(app)
        .post('/response')
        .send({ requestId: pending!.requestId, error: 'Test error message' })
        .expect(200);
      await expect(requestPromise).rejects.toEqual('Test error message');
    });
  });

  describe('MCP Server State', () => {
    test('tracks activity', async () => {
      app.setMCPServerActive(true);
      expect(app.isMCPServerActive()).toBe(true);
      app.trackMCPActivity();
      expect(app.isMCPServerActive()).toBe(true);
    });

    test('times out after inactivity', () => {
      app.setMCPServerActive(true);
      expect(app.isMCPServerActive()).toBe(true);
      const original = Date.now;
      Date.now = jest.fn(() => original() + 31000);
      expect(app.isMCPServerActive()).toBe(false);
      Date.now = original;
    });
  });

  describe('Status Endpoint', () => {
    test('returns current status', async () => {
      await request(app).post('/ready').send(READY_BODY).expect(200);
      app.setMCPServerActive(true);
      const response = await request(app).get('/status').expect(200);
      expect(response.body).toMatchObject({ pluginConnected: true, mcpServerActive: true });
      expect(response.body.instances).toHaveLength(1);
      expect(response.body.instances[0]).toMatchObject({
        instanceId: 'place:test',
        role: 'edit',
        placeName: 'TestPlace',
      });
    });
  });
});
