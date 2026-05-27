import request from 'supertest';
import { createHttpServer } from '../http-server.js';
import { RobloxStudioTools } from '../tools/index.js';
import { BridgeService } from '../bridge-service.js';
import { Application } from 'express';

const READY = (overrides: Partial<{ pluginSessionId: string; instanceId: string; role: string }> = {}) => ({
  pluginSessionId: 'session-1',
  instanceId: 'place:test',
  role: 'edit',
  placeId: 0,
  placeName: 'TestPlace',
  dataModelName: 'TestPlace',
  isRunning: false,
  ...overrides,
});

describe('Integration', () => {
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
    test('complete connection lifecycle', async () => {
      let status = await request(app).get('/status').expect(200);
      expect(status.body.pluginConnected).toBe(false);
      expect(status.body.mcpServerActive).toBe(false);

      await request(app).post('/ready').send(READY()).expect(200);

      status = await request(app).get('/status').expect(200);
      expect(status.body.pluginConnected).toBe(true);

      const pollIdle = await request(app).get('/poll?pluginSessionId=session-1').expect(503);
      expect(pollIdle.body).toMatchObject({
        error: 'MCP server not connected',
        pluginConnected: true,
        mcpConnected: false,
      });

      app.setMCPServerActive(true);

      const pollActive = await request(app).get('/poll?pluginSessionId=session-1').expect(200);
      expect(pollActive.body).toMatchObject({
        request: null,
        mcpConnected: true,
        pluginConnected: true,
      });

      await request(app).post('/disconnect').send({ pluginSessionId: 'session-1' }).expect(200);
      status = await request(app).get('/status').expect(200);
      expect(status.body.pluginConnected).toBe(false);
    });
  });

  describe('Request/Response Flow', () => {
    test('complete request/response cycle', async () => {
      await request(app).post('/ready').send(READY()).expect(200);
      app.setMCPServerActive(true);

      const promise = bridge.sendRequest('/api/test-endpoint', { testData: 'hello', value: 123 }, 'place:test', 'edit');

      const poll = await request(app).get('/poll?pluginSessionId=session-1').expect(200);
      expect(poll.body.request).toMatchObject({
        endpoint: '/api/test-endpoint',
        data: { testData: 'hello', value: 123 },
      });
      const requestId = poll.body.requestId;

      await request(app)
        .post('/response')
        .send({ requestId, response: { success: true, result: 'processed', echo: 'hello' } })
        .expect(200);

      const result = await promise;
      expect(result).toEqual({ success: true, result: 'processed', echo: 'hello' });
    });

    test('error responses propagate', async () => {
      await request(app).post('/ready').send(READY()).expect(200);
      app.setMCPServerActive(true);

      const promise = bridge.sendRequest('/api/failing', {}, 'place:test', 'edit');
      promise.catch(() => {});

      const poll = await request(app).get('/poll?pluginSessionId=session-1').expect(200);
      await request(app)
        .post('/response')
        .send({ requestId: poll.body.requestId, error: 'Operation failed: Invalid input' })
        .expect(200);

      await expect(promise).rejects.toEqual('Operation failed: Invalid input');
    });
  });

  describe('Disconnect Recovery', () => {
    test('disconnect rejects pending requests, reconnect resumes', async () => {
      await request(app).post('/ready').send(READY()).expect(200);
      app.setMCPServerActive(true);

      const req1 = bridge.sendRequest('/api/test1', {}, 'place:test', 'edit');
      const req2 = bridge.sendRequest('/api/test2', {}, 'place:test', 'edit');
      req1.catch(() => {});
      req2.catch(() => {});

      const poll = await request(app).get('/poll?pluginSessionId=session-1').expect(200);
      expect(poll.body.request).toBeTruthy();

      await request(app).post('/disconnect').send({ pluginSessionId: 'session-1' }).expect(200);
      await expect(req1).rejects.toThrow(/disconnected/);
      await expect(req2).rejects.toThrow(/disconnected/);

      await request(app).post('/ready').send(READY({ pluginSessionId: 'session-2' })).expect(200);

      const newReq = bridge.sendRequest('/api/test3', {}, 'place:test', 'edit');
      const newPoll = await request(app).get('/poll?pluginSessionId=session-2').expect(200);
      expect(newPoll.body.request?.endpoint).toBe('/api/test3');

      await request(app).post('/response').send({ requestId: newPoll.body.requestId, response: { success: true } }).expect(200);
      const result = await newReq;
      expect(result).toEqual({ success: true });
    });
  });

  describe('Timeout Handling', () => {
    test('request times out after 30s', async () => {
      jest.useFakeTimers();

      await request(app).post('/ready').send(READY()).expect(200);
      app.setMCPServerActive(true);

      const promise = bridge.sendRequest('/api/slow', {}, 'place:test', 'edit');
      await request(app).get('/poll?pluginSessionId=session-1').expect(200);

      jest.advanceTimersByTime(31000);

      await expect(promise).rejects.toThrow('Request timeout');
      jest.useRealTimers();
    });
  });

  describe('Multi-instance routing', () => {
    test('two distinct instances each receive their own requests', async () => {
      await request(app).post('/ready').send(READY({ pluginSessionId: 's-a', instanceId: 'place:A' })).expect(200);
      await request(app).post('/ready').send(READY({ pluginSessionId: 's-b', instanceId: 'place:B' })).expect(200);
      app.setMCPServerActive(true);

      const reqA = bridge.sendRequest('/api/test', { who: 'A' }, 'place:A', 'edit');
      const reqB = bridge.sendRequest('/api/test', { who: 'B' }, 'place:B', 'edit');
      reqA.catch(() => {});
      reqB.catch(() => {});

      // Plugin A polls — must only see A's request.
      const pollA = await request(app).get('/poll?pluginSessionId=s-a').expect(200);
      expect(pollA.body.request.data.who).toBe('A');

      // Plugin B polls — must only see B's request.
      const pollB = await request(app).get('/poll?pluginSessionId=s-b').expect(200);
      expect(pollB.body.request.data.who).toBe('B');

      await request(app).post('/response').send({ requestId: pollA.body.requestId, response: { ok: 'A' } }).expect(200);
      await request(app).post('/response').send({ requestId: pollB.body.requestId, response: { ok: 'B' } }).expect(200);

      expect(await reqA).toEqual({ ok: 'A' });
      expect(await reqB).toEqual({ ok: 'B' });
    });
  });
});
