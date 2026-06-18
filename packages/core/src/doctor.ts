// `--doctor` diagnostics. Pure helpers (checkNodeVersion, formatDoctorReport)
// are unit-tested; collectDoctorChecks performs the I/O (filesystem + a /health
// probe) and composes them into a report the CLI prints.

import * as fs from 'fs';
import * as path from 'path';
import { getPluginsFolder } from './install-plugin-helpers.js';

export type DoctorStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
}

const SYMBOL: Record<DoctorStatus, string> = { ok: '✓', warn: '!', fail: '✗' };

export function checkNodeVersion(version: string): DoctorCheck {
  const major = parseInt(version.replace(/^v/, '').split('.')[0] ?? '0', 10);
  if (Number.isNaN(major) || major < 18) {
    return { name: 'Node version', status: 'fail', detail: `${version} — Node 18+ is required.` };
  }
  return { name: 'Node version', status: 'ok', detail: version };
}

export function formatDoctorReport(checks: DoctorCheck[]): string {
  const lines = checks.map((c) => `  ${SYMBOL[c.status]} ${c.name}: ${c.detail}`);
  const worst: DoctorStatus = checks.some((c) => c.status === 'fail')
    ? 'fail'
    : checks.some((c) => c.status === 'warn')
      ? 'warn'
      : 'ok';
  const summary = worst === 'ok'
    ? 'All checks passed.'
    : worst === 'warn'
      ? 'Some checks need attention (warnings).'
      : 'Problems found — see failures above.';
  return ['robloxstudio-mcp doctor', ...lines, '', summary].join('\n');
}

export interface DoctorOptions {
  version?: string;
  port?: number;
  fetchImpl?: typeof fetch;
}

export async function collectDoctorChecks(options: DoctorOptions = {}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  checks.push(checkNodeVersion(process.version));

  checks.push({
    name: 'Server package',
    status: 'ok',
    detail: options.version ? `v${options.version}` : 'version unknown',
  });

  // Plugin installed? Look for either variant in the resolved plugins folder.
  try {
    const folder = getPluginsFolder();
    const variants = ['MCPPlugin.rbxmx', 'MCPInspectorPlugin.rbxmx'];
    const found = variants.filter((v) => fs.existsSync(path.join(folder, v)));
    checks.push(found.length > 0
      ? { name: 'Studio plugin installed', status: 'ok', detail: `${found.join(', ')} in ${folder}` }
      : { name: 'Studio plugin installed', status: 'warn', detail: `none found in ${folder}. Run with --install-plugin.` });
  } catch (error) {
    checks.push({ name: 'Studio plugin installed', status: 'warn', detail: `could not resolve plugins folder: ${error instanceof Error ? error.message : String(error)}` });
  }

  // Local bridge running + Studio reachable via /health.
  const port = options.port ?? (process.env.ROBLOX_STUDIO_PORT ? parseInt(process.env.ROBLOX_STUDIO_PORT) : 58741);
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`http://localhost:${port}/health`);
    if (res.ok) {
      const health = await res.json() as { pluginConnected?: boolean; instanceCount?: number; version?: string };
      checks.push({ name: 'Local bridge running', status: 'ok', detail: `responding on port ${port}` });
      checks.push(health.pluginConnected
        ? { name: 'Studio reachable', status: 'ok', detail: `${health.instanceCount ?? 0} place(s) connected` }
        : { name: 'Studio reachable', status: 'warn', detail: 'bridge up but no Studio plugin connected. Open Studio and enable Allow HTTP Requests.' });
    } else {
      checks.push({ name: 'Local bridge running', status: 'fail', detail: `port ${port} responded ${res.status}` });
    }
  } catch {
    checks.push({ name: 'Local bridge running', status: 'warn', detail: `nothing responding on port ${port}. The bridge only runs while the MCP server is started by your client.` });
  }

  return checks;
}

export async function runDoctor(options: DoctorOptions = {}): Promise<number> {
  const checks = await collectDoctorChecks(options);
  // eslint-disable-next-line no-console
  console.log(formatDoctorReport(checks));
  return checks.some((c) => c.status === 'fail') ? 1 : 0;
}
