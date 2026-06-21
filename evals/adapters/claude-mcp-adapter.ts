// Concrete McpHarnessAdapter: drives an Anthropic-Messages model against the live
// MCP server over stdio, recording a TraceEvent[] + RunMetrics per task. Provider-
// agnostic interface lives in ../harness.ts; this is the Messages-protocol impl.
//
// Works with the real Anthropic API (ANTHROPIC_API_KEY) OR any Anthropic-Messages-
// compatible gateway via `baseURL` + `model` — e.g. OpenModel's free
// `deepseek-v4-flash` (see ../run.ts for the env wiring). Needs a connected Roblox
// Studio (the MCP server bridges to it). Run via ../run.ts.

import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { EvalCase, HarnessMode, McpHarnessAdapter, RunResult } from '../harness.js';
import type { TraceEvent, RunMetrics } from '../metrics.js';

const DEFAULT_MODEL = 'claude-opus-4-8';
const MAX_ITERATIONS = 14;

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface ClaudeMcpAdapterOptions {
  /** Path to the built MCP server entrypoint. */
  serverEntry: string;
  /** Extra env for the server process (e.g. POLLINATIONS key). */
  serverEnv?: Record<string, string>;
  apiKey?: string;
  /** Override the API base URL — point at an Anthropic-Messages-compatible gateway. */
  baseURL?: string;
  /** Model id to drive (defaults to claude-opus-4-8). */
  model?: string;
  /** SDK auto-retries (incl. 429); free gateways need a generous count. Default 8. */
  maxRetries?: number;
  /** Fixed delay before each model call, to respect per-user rate limits. Default 0. */
  requestDelayMs?: number;
}

export class ClaudeMcpAdapter implements McpHarnessAdapter {
  private readonly anthropic: Anthropic;
  private readonly model: string;
  private readonly requestDelayMs: number;
  private client: Client | undefined;
  private transport: StdioClientTransport | undefined;

  constructor(private readonly opts: ClaudeMcpAdapterOptions) {
    this.anthropic = new Anthropic({
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      maxRetries: opts.maxRetries ?? 8,
    });
    this.model = opts.model ?? DEFAULT_MODEL;
    this.requestDelayMs = Math.max(0, opts.requestDelayMs ?? 0);
  }

  async startServer(mode: HarnessMode): Promise<void> {
    this.transport = new StdioClientTransport({
      command: 'node',
      args: [this.opts.serverEntry],
      env: {
        ...process.env as Record<string, string>,
        ...(this.opts.serverEnv ?? {}),
        // Lazy mode advertises only the core + meta tools upfront.
        ROBLOX_MCP_LAZY_TOOLS: mode === 'lazy' ? '1' : '0',
      },
    });
    this.client = new Client({ name: 'mcp-eval-harness', version: '1.0.0' }, { capabilities: {} });
    await this.client.connect(this.transport);
  }

  async stopServer(): Promise<void> {
    await this.client?.close().catch(() => {});
    await this.transport?.close().catch(() => {});
    this.client = undefined;
    this.transport = undefined;
  }

  private async listTools(): Promise<McpToolDef[]> {
    const res = await this.client!.listTools();
    return res.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> }));
  }

  async runTask(task: EvalCase): Promise<RunResult> {
    const trace: TraceEvent[] = [];
    const start = Date.now();
    let cumulativeInputTokens = 0;
    let cumulativeOutputTokens = 0;
    let initInputTokens = 0;
    let toolSchemaTokensSeen = 0;
    let toolCalls = 0;
    let invalidToolCalls = 0;
    const distinct = new Set<string>();

    let tools = await this.listTools();
    toolSchemaTokensSeen += approxTokens(tools);
    const toAnthropicTools = () => tools.map((t) => ({ name: t.name, description: t.description ?? '', input_schema: t.inputSchema as Anthropic.Tool.InputSchema }));

    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: task.prompt }];
    let finalText = '';
    let success = false;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      if (this.requestDelayMs > 0) await sleep(this.requestDelayMs);
      const response = await this.anthropic.messages.create({
        model: this.model,
        max_tokens: 4096,
        tools: toAnthropicTools(),
        messages,
      });
      const usageIn = response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0);
      cumulativeInputTokens += usageIn;
      cumulativeOutputTokens += response.usage.output_tokens;
      if (i === 0) initInputTokens = usageIn;
      trace.push({ t: Date.now() - start, type: 'model', tokensIn: usageIn, tokensOut: response.usage.output_tokens });

      const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      for (const b of response.content) {
        if (b.type === 'text') finalText += b.text;
      }
      // Replay only text + tool_use back into history. Some Messages-compatible
      // gateways (e.g. deepseek-v4-flash) emit unsolicited `thinking` blocks whose
      // signatures don't survive a round-trip; we never enabled extended thinking,
      // so dropping them is safe and avoids signature-validation rejections.
      const replayContent = response.content.filter(
        (b) => b.type === 'text' || b.type === 'tool_use',
      );
      messages.push({ role: 'assistant', content: replayContent });

      if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
        success = response.stop_reason === 'end_turn';
        break;
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      let loadedToolset = false;
      for (const tu of toolUses) {
        toolCalls += 1;
        distinct.add(tu.name);
        let isError = false;
        let text = '';
        try {
          const result = await this.client!.callTool({ name: tu.name, arguments: (tu.input ?? {}) as Record<string, unknown> });
          isError = result.isError === true;
          text = extractText(result.content);
          if (tu.name === 'load_toolset') loadedToolset = true;
        } catch (err) {
          isError = true;
          text = err instanceof Error ? err.message : String(err);
        }
        if (isError) invalidToolCalls += 1;
        trace.push({ t: Date.now() - start, type: 'tool_call', name: tu.name, args: tu.input, isError });
        trace.push({ t: Date.now() - start, type: 'tool_result', name: tu.name, resultSummary: text.slice(0, 200) });
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: text, is_error: isError });
      }
      messages.push({ role: 'user', content: toolResults });

      // Lazy mode: after load_toolset the advertised tool set grew — refresh it.
      if (loadedToolset) {
        tools = await this.listTools();
        toolSchemaTokensSeen += approxTokens(tools);
      }
    }

    const metrics: RunMetrics = {
      initInputTokens,
      cumulativeInputTokens,
      cumulativeOutputTokens,
      toolSchemaTokensSeen,
      toolCalls,
      distinctToolsCalled: distinct.size,
      unnecessaryToolCalls: 0, // computed by scoreTrajectory against the gold spec
      invalidToolCalls,
      retriesAfterRecoverableError: 0,
      wallClockMs: Date.now() - start,
      success: success && factsPresent(finalText, task.must_contain_facts),
    };
    return { finalAnswer: finalText, trace, metrics };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function approxTokens(tools: McpToolDef[]): number {
  // Rough proxy for how much schema text the model sees (≈4 chars/token).
  return Math.ceil(JSON.stringify(tools).length / 4);
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((c): c is { type: 'text'; text: string } => !!c && typeof c === 'object' && (c as { type?: string }).type === 'text')
    .map((c) => c.text)
    .join('\n');
}

function factsPresent(answer: string, facts?: string[]): boolean {
  if (!facts || facts.length === 0) return true;
  const lower = answer.toLowerCase();
  // Lenient keyword presence — a real run pairs this with an LLM-as-judge.
  return facts.some((f) => lower.includes(f.toLowerCase().split(' ')[0]));
}
