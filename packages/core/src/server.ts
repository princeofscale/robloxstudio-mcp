import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import http from 'http';
import { createHttpServer, listenWithRetry, TOOL_HANDLERS } from './http-server.js';
import { RobloxStudioTools } from './tools/index.js';
import { BridgeService, RoutingFailure } from './bridge-service.js';
import { ProxyBridgeService } from './proxy-bridge-service.js';
import type { ToolDefinition } from './tools/definitions.js';
import { buildCatalog, expandToolsets, CORE_TOOLS } from './tools/tool-catalog.js';
import { toolDefinitionToMcpTool } from './tools/tool-shape.js';
import { toolErrorResult } from './errors.js';
import { attachStructuredContent } from './tools/structured-output.js';
import { SERVER_INSTRUCTIONS } from './server-instructions.js';
import { RESOURCE_LIST, RESOURCE_TEMPLATES, readResource } from './resources.js';

export interface ServerConfig {
  name: string;
  version: string;
  tools: ToolDefinition[];
}

export class RobloxStudioMCPServer {
  private server: Server;
  private tools: RobloxStudioTools;
  private bridge: BridgeService;
  private allowedToolNames: Set<string>;
  private config: ServerConfig;
  // Lazy tool loading (opt-in via ROBLOX_MCP_LAZY_TOOLS): when on, ListTools
  // advertises only the always-on core + meta tools plus any domains the agent
  // has pulled in via load_toolset, instead of all ~130 schemas upfront.
  private lazyTools: boolean;
  private activeToolNames: Set<string>;

  constructor(config: ServerConfig) {
    this.config = config;
    this.allowedToolNames = new Set(config.tools.map(t => t.name));

    const flag = (process.env.ROBLOX_MCP_LAZY_TOOLS ?? '').toLowerCase();
    this.lazyTools = flag === '1' || flag === 'true' || flag === 'on';
    // Start with the always-on core + the meta tools (which live in CORE_TOOLS).
    this.activeToolNames = new Set(CORE_TOOLS);

    this.server = new Server(
      {
        name: config.name,
        version: config.version,
      },
      {
        capabilities: {
          tools: this.lazyTools ? { listChanged: true } : {},
          resources: {},
        },
        instructions: SERVER_INSTRUCTIONS,
      }
    );

    this.bridge = new BridgeService();
    this.tools = new RobloxStudioTools(this.bridge);
    this.setupToolHandlers();
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const visible = this.lazyTools
        ? this.config.tools.filter(t => this.activeToolNames.has(t.name))
        : this.config.tools;
      return {
        tools: visible.map(toolDefinitionToMcpTool),
      };
    });

    // Resources (data plane) — the world-model data as cacheable canonical URIs.
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: RESOURCE_LIST }));
    this.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: RESOURCE_TEMPLATES }));
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      try {
        return await readResource(this.tools, request.params.uri);
      } catch (error) {
        throw new McpError(ErrorCode.InvalidParams, error instanceof Error ? error.message : String(error));
      }
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      if (!this.allowedToolNames.has(name)) {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }

      const handler = TOOL_HANDLERS[name];
      if (!handler) {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }

      try {
        const result = await handler(this.tools, args ?? {});
        // In lazy mode, load_toolset also expands the advertised tool list and
        // notifies the client so the newly-loaded domain's tools show up.
        if (this.lazyTools && name === 'load_toolset') {
          this.applyToolset((args ?? {}) as { toolsets?: string[] });
        }
        return attachStructuredContent(result as Record<string, unknown>);
      } catch (error) {
        if (error instanceof RoutingFailure) {
          // Surface routing errors as structured tool-call results with
          // the full instance list embedded so the LLM can recover by
          // picking an instance_id from data.instances — no need for a
          // separate get_connected_instances round-trip.
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: error.routingError.code,
                message: error.routingError.message,
                data: error.routingError.data,
              }),
            }],
            isError: true,
          };
        }
        if (error instanceof McpError) throw error;
        // Uniform typed failure for every tool (envelope by topology): the agent
        // gets a stable code + retryable + suggestedRecovery instead of an opaque
        // internal error it can't branch on.
        return toolErrorResult(error, name);
      }
    });
  }

  // Expand the active tool set by the requested domains and notify the client.
  private applyToolset(args: { toolsets?: string[] }): void {
    const selectors = Array.isArray(args?.toolsets) ? args.toolsets : [];
    if (selectors.length === 0) return;
    const catalog = buildCatalog(this.config.tools);
    const wanted = expandToolsets(catalog, selectors);
    let added = false;
    for (const n of wanted) {
      if (this.allowedToolNames.has(n) && !this.activeToolNames.has(n)) {
        this.activeToolNames.add(n);
        added = true;
      }
    }
    if (added) {
      this.server.sendToolListChanged?.();
    }
  }

  async run() {
    const basePort = process.env.ROBLOX_STUDIO_PORT ? parseInt(process.env.ROBLOX_STUDIO_PORT) : 58741;
    const host = process.env.ROBLOX_STUDIO_HOST || '0.0.0.0';
    let bridgeMode: 'primary' | 'proxy' = 'primary';
    let httpHandle: http.Server | undefined;
    let primaryApp: ReturnType<typeof createHttpServer> | undefined;
    let boundPort = 0;
    let promotionInterval: ReturnType<typeof setInterval> | undefined;

    // Try to bind as primary on basePort only — secondary sessions must NOT
    // claim a different "primary" port, because the plugin only polls basePort.
    // A successful bind on basePort+1..+4 would create a fake primary whose
    // bridge queue nothing ever reads from, hanging tool calls until they time
    // out. The intended multi-session pattern is: first session = primary,
    // every subsequent session = proxy forwarding to basePort. This matches the
    // official Roblox Studio MCP (Roblox/studio-rust-mcp-server, main.rs:43).
    try {
      primaryApp = createHttpServer(this.tools, this.bridge, this.allowedToolNames, this.config);
      const result = await listenWithRetry(primaryApp, host, basePort, 1);
      httpHandle = result.server;
      boundPort = result.port;
      console.error(`HTTP server listening on ${host}:${boundPort} for Studio plugin (primary mode)`);
      console.error(`Streamable HTTP MCP endpoint: http://localhost:${boundPort}/mcp`);
    } catch {
      // basePort taken — another MCP subprocess owns the plugin connection.
      // Fall back to proxy mode and forward all bridge calls through it.
      bridgeMode = 'proxy';
      primaryApp = undefined;
      const proxyBridge = new ProxyBridgeService(`http://localhost:${basePort}`);
      this.bridge = proxyBridge;
      this.tools = new RobloxStudioTools(this.bridge);
      console.error(`Port ${basePort} in use - entering proxy mode (forwarding to localhost:${basePort})`);

      // Periodically try to promote to primary if the port frees up.
      // Single-attempt bind for the same reason as the initial bind above —
      // only basePort has a real plugin polling it, so promoting to basePort+1
      // would create another fake primary.
      //
      // Build the candidate primary infrastructure on local vars first; only
      // swap this.bridge / this.tools AFTER the bind succeeds. The previous
      // version swapped synchronously before the await, leaving a brief window
      // each interval where tool calls would land on a regular BridgeService
      // with no plugin polling it (queue with no consumer → 30s timeout).
      const promotionIntervalMs = parseInt(process.env.ROBLOX_STUDIO_PROXY_PROMOTION_INTERVAL_MS || '5000');
      promotionInterval = setInterval(async () => {
        const candidateBridge = new BridgeService();
        const candidateTools = new RobloxStudioTools(candidateBridge);
        const candidateApp = createHttpServer(candidateTools, candidateBridge, this.allowedToolNames, this.config);
        try {
          const result = await listenWithRetry(candidateApp, host, basePort, 1);
          // Bind succeeded — atomically swap to primary mode (synchronous from here).
          // Stop the proxy bridge's background refresh before dropping the reference
          // so its setInterval doesn't keep the object alive past the swap.
          const oldBridge = this.bridge;
          this.bridge = candidateBridge;
          this.tools = candidateTools;
          if (oldBridge instanceof ProxyBridgeService) {
            oldBridge.stop();
          }
          httpHandle = result.server;
          boundPort = result.port;
          primaryApp = candidateApp;
          bridgeMode = 'primary';
          (primaryApp as any).setMCPServerActive(true);
          console.error(`Promoted from proxy to primary on port ${boundPort}`);
          if (promotionInterval) clearInterval(promotionInterval);
        } catch {
          // basePort still taken — discard the candidate, leave proxy bridge live.
        }
      }, promotionIntervalMs);
    }

    // Legacy port 3002 for old plugins
    const LEGACY_PORT = 3002;
    let legacyHandle: http.Server | undefined;
    let legacyApp: ReturnType<typeof createHttpServer> | undefined;
    if (boundPort !== LEGACY_PORT && bridgeMode === 'primary') {
      legacyApp = createHttpServer(this.tools, this.bridge, this.allowedToolNames, this.config);
      try {
        const result = await listenWithRetry(legacyApp, host, LEGACY_PORT, 1);
        legacyHandle = result.server;
        console.error(`Legacy HTTP server also listening on ${host}:${LEGACY_PORT} for old plugins`);
        (legacyApp as any).setMCPServerActive(true);
      } catch {
        console.error(`Legacy port ${LEGACY_PORT} in use, skipping backward-compat listener`);
      }
    }

    // Start stdio MCP transport
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error(`${this.config.name} v${this.config.version} running on stdio`);

    if (primaryApp) {
      (primaryApp as any).setMCPServerActive(true);
    }

    console.error(bridgeMode === 'primary'
      ? 'MCP server marked as active (primary mode)'
      : 'MCP server active in proxy mode - forwarding requests to primary');

    console.error('Waiting for Studio plugin to connect...');

    const activityInterval = setInterval(() => {
      if (primaryApp) (primaryApp as any).trackMCPActivity();
      if (legacyApp) (legacyApp as any).trackMCPActivity();

      if (bridgeMode === 'primary' && primaryApp) {
        const pluginConnected = (primaryApp as any).isPluginConnected();
        const mcpActive = (primaryApp as any).isMCPServerActive();

        if (pluginConnected && mcpActive) {
          // All good
        } else if (pluginConnected && !mcpActive) {
          console.error('Studio plugin connected, but MCP server inactive');
        } else if (!pluginConnected && mcpActive) {
          console.error('MCP server active, waiting for Studio plugin...');
        } else {
          console.error('Waiting for connections...');
        }
      }
    }, 5000);

    const cleanupInterval = setInterval(() => {
      this.bridge.cleanupOldRequests();
      this.bridge.cleanupStaleInstances();
    }, 5000);

    const shutdown = async () => {
      console.error('Shutting down MCP server...');
      clearInterval(activityInterval);
      clearInterval(cleanupInterval);
      if (promotionInterval) clearInterval(promotionInterval);
      if (this.bridge instanceof ProxyBridgeService) {
        this.bridge.stop();
      }
      await this.server.close().catch(() => {});
      if (httpHandle) httpHandle.close();
      if (legacyHandle) legacyHandle.close();
      process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    process.on('SIGHUP', shutdown);

    process.stdin.on('end', shutdown);
    process.stdin.on('close', shutdown);
  }
}
