#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { McpClient, DIST, REPO_ROOT, assert, assertContains } from './lib/mcp-client.mjs';
import {
  closeAllStudio,
  launchStudio,
  listStudioProcesses,
  resolvePluginsDir,
} from '../scripts/studio-lifecycle.mjs';

const SERVER_ENV = {
  ROBLOX_STUDIO_PROXY_PROMOTION_INTERVAL_MS: '600000',
};

const PLACE_FIXTURE_XML = `<?xml version="1.0" encoding="utf-8"?>
<roblox version="4">
  <External>null</External>
  <External>nil</External>
  <Item class="Workspace" referent="RBX0">
    <Properties>
      <string name="Name">Workspace</string>
    </Properties>
  </Item>
  <Item class="ServerStorage" referent="RBX1">
    <Properties>
      <string name="Name">ServerStorage</string>
    </Properties>
  </Item>
  <Item class="Lighting" referent="RBX2">
    <Properties>
      <string name="Name">Lighting</string>
    </Properties>
  </Item>
</roblox>
`;

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
  });
}

async function waitPortClosed(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortOpen(port))) return;
    await delay(250);
  }
  throw new Error(`Port ${port} remained open after server shutdown`);
}

function backupPluginFiles(pluginsDir) {
  mkdirSync(pluginsDir, { recursive: true });
  const backups = new Map();
  for (const asset of ['MCPPlugin.rbxmx', 'MCPInspectorPlugin.rbxmx']) {
    const file = path.join(pluginsDir, asset);
    backups.set(asset, existsSync(file) ? readFileSync(file) : null);
  }
  return backups;
}

function restorePluginFiles(pluginsDir, backups) {
  for (const [asset, contents] of backups.entries()) {
    const file = path.join(pluginsDir, asset);
    if (contents === null) {
      rmSync(file, { force: true });
    } else {
      writeFileSync(file, contents);
    }
  }
}

function createPlaceFixture(pluginsDir) {
  const fixtureDir = path.join(path.dirname(pluginsDir), 'robloxstudio-mcp-tooling-smoke');
  mkdirSync(fixtureDir, { recursive: true });
  const placePath = path.join(fixtureDir, 'StudioToolingSmoke.rbxlx');
  writeFileSync(placePath, PLACE_FIXTURE_XML, 'utf8');
  return { fixtureDir, placePath };
}

async function waitForEditInstance(client, expectedVersion, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const connected = await client.callTool('get_connected_instances', {});
      const instances = connected.instances ?? [];
      const edit = instances.find((inst) => inst.role === 'edit');
      if (edit) {
        assert(edit.pluginVariant === 'main', 'regular tooling loaded the main plugin');
        assert(edit.pluginVersion === expectedVersion, `Studio plugin version is v${expectedVersion}`);
        assert(edit.serverVersion === expectedVersion, `MCP server version is v${expectedVersion}`);
        assert(edit.versionMismatch === false, 'regular tooling has no version mismatch');
        return edit;
      }
      last = connected;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await delay(1000);
  }
  throw new Error(`No edit instance connected within ${timeoutMs}ms. Last: ${JSON.stringify(last)}`);
}

function assertNoError(value, message) {
  assert(!value?.error, `${message}${value?.error ? ` (${value.error})` : ''}`);
}

async function runEditModeToolSmoke(client, instanceId) {
  console.log('\n=== edit-mode regular tooling smoke ===');

  const listed = await client.rpc('tools/list', {});
  const names = new Set((listed.tools ?? []).map((tool) => tool.name));
  for (const tool of [
    'get_place_info',
    'get_file_tree',
    'create_object',
    'set_property',
    'get_instance_properties',
    'set_script_source',
    'get_script_source',
    'set_attribute',
    'add_tag',
    'execute_luau',
    'delete_object',
  ]) {
    assert(names.has(tool), `tools/list exposes ${tool}`);
  }

  const place = await client.callTool('get_place_info', { instance_id: instanceId });
  assertNoError(place, 'get_place_info succeeds');
  assert(place.workspace?.className === 'Workspace', 'get_place_info returns workspace metadata');

  const tree = await client.callTool('get_file_tree', { path: 'game.Workspace', instance_id: instanceId });
  assertNoError(tree, 'get_file_tree succeeds');
  assert(tree.tree?.className === 'Workspace', 'get_file_tree returns Workspace tree');

  const services = await client.callTool('get_services', { serviceName: 'ServerScriptService', instance_id: instanceId });
  assertNoError(services, 'get_services succeeds');
  assert(services.service?.className === 'ServerScriptService', 'get_services returns requested service');

  const folder = await client.callTool('create_object', {
    className: 'Folder',
    parent: 'game.Workspace',
    name: '__RSMCP_ToolingSmoke',
    instance_id: instanceId,
  });
  assert(folder.success === true, 'create_object creates smoke folder');

  try {
    const part = await client.callTool('create_object', {
      className: 'Part',
      parent: folder.instancePath,
      name: 'SmokePart',
      properties: {
        Anchored: true,
        Size: { _type: 'Vector3', X: 4, Y: 1, Z: 2 },
        Position: { _type: 'Vector3', X: 0, Y: 5, Z: 0 },
      },
      instance_id: instanceId,
    });
    assert(part.success === true, 'create_object creates smoke part');

    const setProp = await client.callTool('set_property', {
      instancePath: part.instancePath,
      propertyName: 'Transparency',
      propertyValue: 0.25,
      instance_id: instanceId,
    });
    assert(setProp.success === true, 'set_property updates smoke part');

    const props = await client.callTool('get_instance_properties', {
      instancePath: part.instancePath,
      instance_id: instanceId,
    });
    assertNoError(props, 'get_instance_properties succeeds');
    assert(props.properties?.Name === 'SmokePart', 'get_instance_properties returns updated object');

    const attr = await client.callTool('set_attribute', {
      instancePath: part.instancePath,
      attributeName: 'SmokeAttr',
      attributeValue: 'ok',
      instance_id: instanceId,
    });
    assert(attr.success === true, 'set_attribute updates smoke part');

    const attrs = await client.callTool('get_attributes', {
      instancePath: part.instancePath,
      instance_id: instanceId,
    });
    assert(attrs.attributes?.SmokeAttr?.value === 'ok', 'get_attributes returns smoke attribute');

    const tag = await client.callTool('add_tag', {
      instancePath: part.instancePath,
      tagName: 'RSMCPToolingSmoke',
      instance_id: instanceId,
    });
    assert(tag.success === true, 'add_tag tags smoke part');

    const tagged = await client.callTool('get_tagged', {
      tagName: 'RSMCPToolingSmoke',
      instance_id: instanceId,
    });
    assert(JSON.stringify(tagged).includes('SmokePart'), 'get_tagged returns smoke part');

    const script = await client.callTool('create_object', {
      className: 'Script',
      parent: folder.instancePath,
      name: 'SmokeScript',
      properties: { Enabled: false },
      instance_id: instanceId,
    });
    assert(script.success === true, 'create_object creates smoke script');

    const setSource = await client.callTool('set_script_source', {
      instancePath: script.instancePath,
      source: 'local value = 41\nreturn value + 1\n',
      instance_id: instanceId,
    });
    assert(setSource.success === true, 'set_script_source updates smoke script');

    const source = await client.callTool('get_script_source', {
      instancePath: script.instancePath,
      startLine: 1,
      endLine: 2,
      instance_id: instanceId,
    });
    assertContains(source, 'return value + 1', 'get_script_source returns edited source');

    const exec = await client.callTool('execute_luau', {
      target: 'edit',
      instance_id: instanceId,
      code: 'return workspace:FindFirstChild("__RSMCP_ToolingSmoke") ~= nil',
    });
    assert(exec.success === true, 'execute_luau edit target succeeds');
    assert(String(exec.returnValue) === 'true', 'execute_luau can read edited Workspace state');

    const selection = await client.callTool('get_selection', { instance_id: instanceId });
    assertNoError(selection, 'get_selection succeeds');
  } finally {
    const deleted = await client.callTool('delete_object', {
      instancePath: folder.instancePath,
      instance_id: instanceId,
    });
    assert(deleted.success === true || deleted.error?.includes('not found'), 'delete_object cleans up smoke folder');
  }
}

function runLiveRegressionSuite() {
  console.log('\n=== existing live Studio regression suite ===');
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['tests/run-all.mjs'], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...SERVER_ENV },
      stdio: 'inherit',
    });
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tests/run-all.mjs exited with ${code ?? 1}`));
    });
  });
}

async function main() {
  if (process.env.RSMCP_E2E_CLOSE_ALL_STUDIO !== '1') {
    throw new Error('This smoke test closes Roblox Studio. Set RSMCP_E2E_CLOSE_ALL_STUDIO=1 to run it.');
  }
  if (await isPortOpen(58741)) {
    throw new Error('Port 58741 is already occupied. Stop existing MCP servers before running this smoke test.');
  }

  const { version } = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const pluginsDir = resolvePluginsDir();
  const backups = backupPluginFiles(pluginsDir);
  const { fixtureDir, placePath } = createPlaceFixture(pluginsDir);
  let client;

  try {
    await closeAllStudio();
    client = new McpClient('regular-tooling-primary', {
      command: 'node',
      args: [DIST, '--auto-install-plugin'],
      env: SERVER_ENV,
      startupTimeoutMs: 60000,
    });
    await client.start();
    await client.initialize();

    launchStudio([placePath]);
    const edit = await waitForEditInstance(client, version);
    await runEditModeToolSmoke(client, edit.instanceId);
    await runLiveRegressionSuite();
  } finally {
    if (client) {
      await client.stop();
      await waitPortClosed(58741).catch(() => {});
    }
    await closeAllStudio().catch(() => {});
    restorePluginFiles(pluginsDir, backups);
    rmSync(fixtureDir, { recursive: true, force: true });
    const remaining = listStudioProcesses();
    if (remaining.length > 0) {
      throw new Error(`Studio processes remain after cleanup: ${JSON.stringify(remaining)}`);
    }
  }
}

main().catch((err) => {
  console.error(`\n❌ regular Studio tooling smoke failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
