import { BridgeService, PluginInstance } from './bridge-service.js';
import { randomUUID } from 'node:crypto';

export class ProxyBridgeService extends BridgeService {
  private primaryBaseUrl: string;
  readonly proxyInstanceId: string;
  private proxyRequestTimeout = 30000;
  private cachedInstances: PluginInstance[] = [];
  private refreshTimer?: ReturnType<typeof setInterval>;
  private static REFRESH_INTERVAL_MS = 1000;

  constructor(primaryBaseUrl: string) {
    super();
    this.primaryBaseUrl = primaryBaseUrl;
    this.proxyInstanceId = randomUUID();
    // Mirror the primary's peer list locally so getInstances() / resolveTarget
    // see real data. Without this, anything that enumerates peers from a
    // proxy-mode subprocess (target=all fanout, get_connected_instances)
    // sees the proxy's own empty instances Map and returns nothing.
    this.refreshInstances();
    this.refreshTimer = setInterval(
      () => this.refreshInstances(),
      ProxyBridgeService.REFRESH_INTERVAL_MS,
    );
  }

  private async refreshInstances(): Promise<void> {
    try {
      const res = await fetch(`${this.primaryBaseUrl}/instances`);
      if (!res.ok) return;
      const body = (await res.json()) as { instances?: PluginInstance[] };
      if (Array.isArray(body.instances)) {
        this.cachedInstances = body.instances;
      }
    } catch {
      // Primary unreachable — keep the last-known list rather than
      // silently reporting empty.
    }
  }

  override getInstances(): PluginInstance[] {
    return this.cachedInstances;
  }

  /** Called when this proxy is being discarded (e.g. promotion to primary
      replaced it). Stops the background refresh so it doesn't leak. */
  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  override async sendRequest(
    endpoint: string,
    data: any,
    targetInstanceId: string,
    targetRole: string,
  ): Promise<any> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.proxyRequestTimeout);

    try {
      const response = await fetch(`${this.primaryBaseUrl}/proxy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint,
          data,
          targetInstanceId,
          targetRole,
          proxyInstanceId: this.proxyInstanceId,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Proxy request failed (${response.status}): ${body}`);
      }

      const result = await response.json() as { response?: any; error?: string };
      if (result.error) {
        throw new Error(result.error);
      }
      return result.response;
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        throw new Error('Proxy request timeout');
      }
      throw err;
    }
  }

  override cleanupOldRequests(): void {
    // No-op: primary bridge owns the pending request state
  }

  override clearAllPendingRequests(): void {
    // No-op: primary bridge owns the pending request state
  }
}
