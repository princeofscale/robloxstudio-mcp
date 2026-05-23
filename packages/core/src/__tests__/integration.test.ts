import request from 'supertest';
import { createHttpServer } from '../http-server.js';
import { RobloxStudioTools } from '../tools/index.js';
import { BridgeService } from '../bridge-service.js';
import { Application } from 'express';

describe('Integration Tests', () => {
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

  describe('Full Connection Flow', () => {
    test('should handle complete connection lifecycle', async () => {
      let status = await request(app).get('/status').expect(200);
      expect(status.body.pluginConnected).toBe(false);
      expect(status.body.mcpServerActive).toBe(false);

      await request(app).post('/ready').send({ instanceId: 'test-1', role: 'edit' }).expect(200);

      status = await request(app).get('/status').expect(200);
      expect(status.body.pluginConnected).toBe(true);
      expect(status.body.mcpServerActive).toBe(false);

      let pollResponse = await request(app).get('/poll').expect(503);
      expect(pollResponse.body).toMatchObject({
        error: 'MCP server not connected',
        pluginConnected: true,
        mcpConnected: false
      });

      app.setMCPServerActive(true);

      status = await request(app).get('/status').expect(200);
      expect(status.body.pluginConnected).toBe(true);
      expect(status.body.mcpServerActive).toBe(true);

      pollResponse = await request(app).get('/poll').expect(200);
      expect(pollResponse.body).toMatchObject({
        request: null,
        mcpConnected: true,
        pluginConnected: true
      });

      await request(app).post('/disconnect').send({ instanceId: 'test-1' }).expect(200);

      status = await request(app).get('/status').expect(200);
      expect(status.body.pluginConnected).toBe(false);
      expect(status.body.mcpServerActive).toBe(true);
    });
  });

  describe('Request/Response Flow', () => {
    test('should handle complete request/response cycle', async () => {
      await request(app).post('/ready').send({ instanceId: 'test-1', role: 'edit' }).expect(200);
      app.setMCPServerActive(true);

      const mcpRequestPromise = bridge.sendRequest('/api/test-endpoint', {
        testData: 'hello',
        value: 123
      });

      const pollResponse = await request(app).get('/poll').expect(200);
      expect(pollResponse.body.request).toMatchObject({
        endpoint: '/api/test-endpoint',
        data: {
          testData: 'hello',
          value: 123
        }
      });
      const requestId = pollResponse.body.requestId;

      await request(app)
        .post('/response')
        .send({
          requestId: requestId,
          response: {
            success: true,
            result: 'processed',
            echo: 'hello'
          }
        })
        .expect(200);

      const mcpResponse = await mcpRequestPromise;
      expect(mcpResponse).toEqual({
        success: true,
        result: 'processed',
        echo: 'hello'
      });
    });

    test('should handle error responses', async () => {
      await request(app).post('/ready').send({ instanceId: 'test-1', role: 'edit' }).expect(200);
      app.setMCPServerActive(true);

      const mcpRequestPromise = bridge.sendRequest('/api/failing-endpoint', {});
      mcpRequestPromise.catch(() => {});

      const pollResponse = await request(app).get('/poll').expect(200);
      const requestId = pollResponse.body.requestId;

      await request(app)
        .post('/response')
        .send({
          requestId: requestId,
          error: 'Operation failed: Invalid input'
        })
        .expect(200);

      await expect(mcpRequestPromise).rejects.toEqual('Operation failed: Invalid input');
    });
  });

  describe('Disconnect Recovery', () => {
    test('should handle disconnect and reconnect gracefully', async () => {
      await request(app).post('/ready').send({ instanceId: 'test-1', role: 'edit' }).expect(200);
      app.setMCPServerActive(true);

      const request1 = bridge.sendRequest('/api/test1', {});
      const request2 = bridge.sendRequest('/api/test2', {});
      request1.catch(() => {});
      request2.catch(() => {});

      let poll = await request(app).get('/poll').expect(200);
      expect(poll.body.request).toBeTruthy();

      await request(app).post('/disconnect').send({ instanceId: 'test-1' }).expect(200);

      await expect(request1).rejects.toThrow('disconnected');
      await expect(request2).rejects.toThrow('disconnected');

      await request(app).post('/ready').send({ instanceId: 'test-2', role: 'edit' }).expect(200);

      const newRequestPromise = bridge.sendRequest('/api/test3', {});

      poll = await request(app).get('/poll').expect(200);
      expect(poll.body.request?.endpoint).toBe('/api/test3');

      await request(app)
        .post('/response')
        .send({
          requestId: poll.body.requestId,
          response: { success: true }
        })
        .expect(200);

      const result = await newRequestPromise;
      expect(result).toEqual({ success: true });
    });
  });

  describe('Connection State Display', () => {
    test('should show correct pending states during connection', async () => {
      let health = await request(app).get('/health').expect(200);
      expect(health.body.pluginConnected).toBe(false);
      expect(health.body.mcpServerActive).toBe(false);

      await request(app).post('/ready').send({ instanceId: 'test-1', role: 'edit' }).expect(200);

      health = await request(app).get('/health').expect(200);
      expect(health.body.pluginConnected).toBe(true);
      expect(health.body.mcpServerActive).toBe(false);

      app.setMCPServerActive(true);

      const poll = await request(app).get('/poll').expect(200);
      expect(poll.body.mcpConnected).toBe(true);
      expect(poll.body.pluginConnected).toBe(true);
    });
  });

  describe('Timeout Handling', () => {
    test('should handle request timeouts', async () => {
      jest.useFakeTimers();

      await request(app).post('/ready').send({ instanceId: 'test-1', role: 'edit' }).expect(200);
      app.setMCPServerActive(true);

      const timeoutPromise = bridge.sendRequest('/api/slow-endpoint', {});

      await request(app).get('/poll').expect(200);

      jest.advanceTimersByTime(31000);

      await expect(timeoutPromise).rejects.toThrow('Request timeout');

      jest.useRealTimers();
    });
  });
});
