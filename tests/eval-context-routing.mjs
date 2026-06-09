#!/usr/bin/env node
// Verifies that the execution tools run in their documented contexts:
//   - execute_luau target=server/client-N runs in the plugin VM on that peer.
//   - eval_server_runtime runs through the server Script VM bridge.
//   - eval_client_runtime runs through the client LocalScript VM bridge.

import { McpClient, runTest, assert, startPlaytestAndWait, safeStopPlaytest } from './lib/mcp-client.mjs';

function parseJsonField(obj, field, label) {
  const raw = obj[field];
  if (typeof raw !== 'string') {
    throw new Error(`${label}: expected ${field} to be a JSON string, got ${typeof raw}: ${JSON.stringify(raw)}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label}: failed to parse ${field}: ${err.message}\nraw=${raw}`);
  }
}

const CONTEXT_PROBE = `
local RunService = game:GetService("RunService")
local Players = game:GetService("Players")
local module = Instance.new("ModuleScript")
local sourceWritable = pcall(function()
  module.Source = "return true"
end)
module:Destroy()
return {
  isServer = RunService:IsServer(),
  isClient = RunService:IsClient(),
  hasLocalPlayer = Players.LocalPlayer ~= nil,
  sourceWritable = sourceWritable,
}
`;

await runTest('execution tools run in their intended contexts', async ({ track }) => {
  const client = track(new McpClient('A'));
  await client.start();
  await client.initialize();

  await startPlaytestAndWait(client);

  try {
    const execServer = await client.callTool('execute_luau', {
      target: 'server',
      code: CONTEXT_PROBE,
    });
    assert(execServer.success === true, 'execute_luau target=server context probe succeeds');
    const execServerCtx = parseJsonField(execServer, 'returnValue', 'execute_luau target=server');
    assert(execServerCtx.isServer === true, 'execute_luau target=server runs on server peer');
    assert(execServerCtx.isClient === false, 'execute_luau target=server is not a client context');
    assert(execServerCtx.hasLocalPlayer === false, 'execute_luau target=server has no LocalPlayer');
    assert(execServerCtx.sourceWritable === true, 'execute_luau target=server has plugin Source permissions');

    const execClient = await client.callTool('execute_luau', {
      target: 'client-1',
      code: CONTEXT_PROBE,
    });
    assert(execClient.success === true, 'execute_luau target=client-1 context probe succeeds');
    const execClientCtx = parseJsonField(execClient, 'returnValue', 'execute_luau target=client-1');
    assert(execClientCtx.isClient === true, 'execute_luau target=client-1 runs on client peer');
    assert(execClientCtx.isServer === false, 'execute_luau target=client-1 is not a server context');
    assert(execClientCtx.hasLocalPlayer === true, 'execute_luau target=client-1 sees LocalPlayer');
    assert(execClientCtx.sourceWritable === true, 'execute_luau target=client-1 has plugin Source permissions');

    const evalServer = await client.callTool('eval_server_runtime', {
      code: CONTEXT_PROBE,
    });
    assert(evalServer.ok === true, 'eval_server_runtime context probe succeeds');
    assert(evalServer.bridge === 'ok', 'eval_server_runtime reaches eval bridge');
    const evalServerCtx = parseJsonField(evalServer, 'result', 'eval_server_runtime');
    assert(evalServerCtx.isServer === true, 'eval_server_runtime runs on server peer');
    assert(evalServerCtx.isClient === false, 'eval_server_runtime is not a client context');
    assert(evalServerCtx.hasLocalPlayer === false, 'eval_server_runtime has no LocalPlayer');
    assert(evalServerCtx.sourceWritable === false, 'eval_server_runtime runs without plugin Source permissions');

    const evalClient = await client.callTool('eval_client_runtime', {
      target: 'client-1',
      code: CONTEXT_PROBE,
    });
    assert(evalClient.ok === true, 'eval_client_runtime context probe succeeds');
    assert(evalClient.bridge === 'ok', 'eval_client_runtime reaches eval bridge');
    const evalClientCtx = parseJsonField(evalClient, 'result', 'eval_client_runtime');
    assert(evalClientCtx.isClient === true, 'eval_client_runtime runs on client peer');
    assert(evalClientCtx.isServer === false, 'eval_client_runtime is not a server context');
    assert(evalClientCtx.hasLocalPlayer === true, 'eval_client_runtime sees LocalPlayer');
    assert(evalClientCtx.sourceWritable === false, 'eval_client_runtime runs without plugin Source permissions');
  } finally {
    await safeStopPlaytest(client);
  }
}).then((ok) => process.exit(ok ? 0 : 1));
