import { BridgeService } from '../bridge-service.js';

describe('BridgeService', () => {
  let bridgeService: BridgeService;

  beforeEach(() => {
    bridgeService = new BridgeService();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('Request Management', () => {
    test('should create and store a pending request', async () => {
      const endpoint = '/api/test';
      const data = { test: 'data' };

      const requestPromise = bridgeService.sendRequest(endpoint, data);

      const pendingRequest = bridgeService.getPendingRequest();
      expect(pendingRequest).toBeTruthy();
      expect(pendingRequest?.request.endpoint).toBe(endpoint);
      expect(pendingRequest?.request.data).toEqual(data);
    });

    test('should resolve request when response is received', async () => {
      const endpoint = '/api/test';
      const data = { test: 'data' };
      const response = { result: 'success' };

      const requestPromise = bridgeService.sendRequest(endpoint, data);
      const pendingRequest = bridgeService.getPendingRequest();

      bridgeService.resolveRequest(pendingRequest!.requestId, response);

      const result = await requestPromise;
      expect(result).toEqual(response);
    });

    test('should reject request on error', async () => {
      const endpoint = '/api/test';
      const data = { test: 'data' };
      const error = 'Test error';

      const requestPromise = bridgeService.sendRequest(endpoint, data);
      const pendingRequest = bridgeService.getPendingRequest();

      bridgeService.rejectRequest(pendingRequest!.requestId, error);

      await expect(requestPromise).rejects.toEqual(error);
    });

    test('should timeout request after 30 seconds', async () => {
      const endpoint = '/api/test';
      const data = { test: 'data' };

      const requestPromise = bridgeService.sendRequest(endpoint, data);

      jest.advanceTimersByTime(31000);

      await expect(requestPromise).rejects.toThrow('Request timeout');
    });
  });

  describe('Cleanup Operations', () => {
    test('should clean up old requests', async () => {

      const promises = [
        bridgeService.sendRequest('/api/test1', {}),
        bridgeService.sendRequest('/api/test2', {}),
        bridgeService.sendRequest('/api/test3', {})
      ];

      jest.advanceTimersByTime(31000);

      bridgeService.cleanupOldRequests();

      for (const promise of promises) {
        await expect(promise).rejects.toThrow('Request timeout');
      }

      expect(bridgeService.getPendingRequest()).toBeNull();
    });

    test('should clear all pending requests on disconnect', async () => {

      const promises = [
        bridgeService.sendRequest('/api/test1', {}),
        bridgeService.sendRequest('/api/test2', {}),
        bridgeService.sendRequest('/api/test3', {})
      ];

      bridgeService.clearAllPendingRequests();

      for (const promise of promises) {
        await expect(promise).rejects.toThrow('Connection closed');
      }

      expect(bridgeService.getPendingRequest()).toBeNull();
    });
  });

  describe('Request Priority', () => {
    test('should return oldest request first', async () => {

      bridgeService.sendRequest('/api/test1', { order: 1 });

      jest.advanceTimersByTime(10);

      bridgeService.sendRequest('/api/test2', { order: 2 });

      jest.advanceTimersByTime(10);

      bridgeService.sendRequest('/api/test3', { order: 3 });

      const firstRequest = bridgeService.getPendingRequest();
      expect(firstRequest?.request.data.order).toBe(1);

      bridgeService.resolveRequest(firstRequest!.requestId, {});

      const secondRequest = bridgeService.getPendingRequest();
      expect(secondRequest?.request.data.order).toBe(2);

      bridgeService.resolveRequest(secondRequest!.requestId, {});

      const thirdRequest = bridgeService.getPendingRequest();
      expect(thirdRequest?.request.data.order).toBe(3);

      bridgeService.resolveRequest(thirdRequest!.requestId, {});

      expect(bridgeService.getPendingRequest()).toBeNull();
    });
  });

  describe('Client Index Allocation', () => {
    test('first registered client gets client-1', () => {
      const role = bridgeService.registerInstance('a', 'client');
      expect(role).toBe('client-1');
    });

    test('sequential clients get sequential indices', () => {
      expect(bridgeService.registerInstance('a', 'client')).toBe('client-1');
      expect(bridgeService.registerInstance('b', 'client')).toBe('client-2');
      expect(bridgeService.registerInstance('c', 'client')).toBe('client-3');
    });

    test('disconnecting last client frees the slot for the next join', () => {
      bridgeService.registerInstance('a', 'client');
      bridgeService.unregisterInstance('a');
      // Previously this would have returned client-2 because the monotonic
      // counter never decremented. With lowest-unused, a fresh connection
      // after a clean disconnect goes back to client-1.
      expect(bridgeService.registerInstance('b', 'client')).toBe('client-1');
    });

    test('disconnecting a middle client fills the hole on next join', () => {
      bridgeService.registerInstance('a', 'client'); // client-1
      bridgeService.registerInstance('b', 'client'); // client-2
      bridgeService.registerInstance('c', 'client'); // client-3
      bridgeService.unregisterInstance('b');         // frees client-2
      // Next join should fill the hole rather than continuing to client-4.
      expect(bridgeService.registerInstance('d', 'client')).toBe('client-2');
      // And the next after that should grow to client-4.
      expect(bridgeService.registerInstance('e', 'client')).toBe('client-4');
    });

    test('non-client roles pass through unchanged', () => {
      expect(bridgeService.registerInstance('e', 'edit')).toBe('edit');
      expect(bridgeService.registerInstance('s', 'server')).toBe('server');
      expect(bridgeService.registerInstance('p', 'edit-proxy')).toBe('edit-proxy');
      // And these don't reserve any client slots.
      expect(bridgeService.registerInstance('a', 'client')).toBe('client-1');
    });
  });
});