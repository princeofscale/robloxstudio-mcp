import * as fs from 'fs';
import * as path from 'path';
import { SyncManager, type ScriptClassName } from '../sync/sync-manager.js';
import { buildDumpScriptsLuau } from '../sync/sync-luau.js';
import type { SafetyOptions, ToolContent } from './runtime-support.js';

type SyncToolRuntime = {
  callSingle(endpoint: string, data: unknown, target: string | undefined, instance_id: string | undefined): Promise<unknown>;
  recordOperation(kind: string, summary: string): void;
};

export class SyncTools {
  constructor(
    private readonly sync: SyncManager,
    private readonly runtime: SyncToolRuntime,
  ) {}

  // === Local sync (Studio <-> files) ===
  // Scripts mirror to suffixed Lua files (.server/.client/.module.lua) under a
  // sync directory. A manifest (.robloxsync.json) records the source captured at
  // the last sync so push/status can do three-way conflict detection rather than
  // clobbering. SyncManager owns the (tested) path/conflict logic; this layer
  // owns filesystem and Studio I/O.

  private _syncManifestPath(dir: string): string {
    return path.join(dir, '.robloxsync.json');
  }

  private _readManifest(dir: string): Record<string, string> {
    try {
      const raw = fs.readFileSync(this._syncManifestPath(dir), 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed.paths === 'object' ? parsed.paths : {};
    } catch {
      return {};
    }
  }

  private _writeManifest(dir: string, paths: Record<string, string>): void {
    const payload = { version: 1, updatedAt: new Date().toISOString(), paths };
    fs.writeFileSync(this._syncManifestPath(dir), JSON.stringify(payload, null, 2));
  }

  private async _dumpStudioScripts(instance_id?: string): Promise<Array<{ path: string; className: ScriptClassName; source: string }>> {
    const response = await this.runtime.callSingle('/api/execute-luau', { code: buildDumpScriptsLuau() }, 'edit', instance_id);
    const rawResponse = response as { returnValue?: unknown };
    const raw = typeof rawResponse?.returnValue === 'string' ? rawResponse.returnValue : undefined;
    if (!raw) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Could not parse script dump from Studio: ${raw.slice(0, 200)}`);
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is { path: string; className: ScriptClassName; source: string } =>
      !!e && typeof e.path === 'string' && typeof e.className === 'string' && typeof e.source === 'string'
      && (e.className === 'Script' || e.className === 'LocalScript' || e.className === 'ModuleScript'));
  }

  private _walkLocalScripts(dir: string): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (current: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        const rel = path.relative(dir, full).split(path.sep).join('/');
        if (entry.isDirectory()) {
          walk(full);
        } else if (this.sync.classNameForFile(entry.name) && !this.sync.isIgnored(rel)) {
          out.set(rel, fs.readFileSync(full, 'utf8'));
        }
      }
    };
    walk(dir);
    return out;
  }

  private _resolveSyncDir(syncDir?: string): string {
    return path.resolve(syncDir ?? process.env.ROBLOX_SYNC_DIR ?? path.join(process.cwd(), 'roblox-src'));
  }

  async syncPull(syncDir?: string, instance_id?: string) {
    const dir = this._resolveSyncDir(syncDir);
    const scripts = await this._dumpStudioScripts(instance_id);
    fs.mkdirSync(dir, { recursive: true });
    const manifest: Record<string, string> = {};
    let written = 0;
    let skipped = 0;
    for (const script of scripts) {
      const rel = this.sync.instancePathToFilePath(script.path, script.className);
      if (this.sync.isIgnored(rel)) { skipped++; continue; }
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, script.source);
      manifest[rel] = script.source;
      written++;
    }
    this._writeManifest(dir, manifest);
    this.runtime.recordOperation('sync_pull', `pulled ${written} scripts to ${dir}`);
    return { content: [{ type: 'text', text: JSON.stringify({ pulled: written, skipped, dir }) }] as ToolContent[] };
  }

  async syncStatus(syncDir?: string, instance_id?: string) {
    const dir = this._resolveSyncDir(syncDir);
    const studio = new Map(
      (await this._dumpStudioScripts(instance_id)).map((s) => [this.sync.instancePathToFilePath(s.path, s.className), s.source] as const),
    );
    const local = this._walkLocalScripts(dir);
    const base = this._readManifest(dir);
    const rels = new Set<string>([...studio.keys(), ...local.keys(), ...Object.keys(base)]);
    const groups: Record<string, string[]> = { local: [], studio: [], both: [], none: [] };
    for (const rel of rels) {
      if (this.sync.isIgnored(rel)) continue;
      const kind = this.sync.detectConflict({ local: local.get(rel), base: base[rel], studio: studio.get(rel) });
      groups[kind].push(rel);
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          dir,
          localOnlyChanges: groups.local,
          studioOnlyChanges: groups.studio,
          conflicts: groups.both,
          inSync: groups.none.length,
        }, null, 2),
      }] as ToolContent[],
    };
  }

  async syncPush(syncDir?: string, instance_id?: string, options?: SafetyOptions) {
    const dir = this._resolveSyncDir(syncDir);
    const studio = new Map(
      (await this._dumpStudioScripts(instance_id)).map((s) => [this.sync.instancePathToFilePath(s.path, s.className), { source: s.source, path: s.path }] as const),
    );
    const local = this._walkLocalScripts(dir);
    const base = this._readManifest(dir);
    const pushed: string[] = [];
    const conflicts: string[] = [];
    const wouldPush: string[] = [];

    for (const [rel, content] of local) {
      if (this.sync.isIgnored(rel)) continue;
      const studioEntry = studio.get(rel);
      const kind = this.sync.detectConflict({ local: content, base: base[rel], studio: studioEntry?.source });
      if (kind === 'none' || kind === 'studio') continue; // nothing local to push, or studio is authoritative
      if (kind === 'both') { conflicts.push(rel); continue; }
      // kind === 'local' — safe to push
      const mapped = this.sync.filePathToInstancePath(rel);
      if (!mapped) continue;
      if (options?.dryRun) { wouldPush.push(rel); continue; }
      await this.runtime.callSingle('/api/set-script-source', { instancePath: mapped.instancePath, source: content }, undefined, instance_id);
      base[rel] = content;
      pushed.push(rel);
    }

    if (!options?.dryRun && pushed.length > 0) {
      this._writeManifest(dir, base);
      this.runtime.recordOperation('sync_push', `pushed ${pushed.length} scripts from ${dir}`);
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          dir,
          dryRun: options?.dryRun === true,
          pushed: options?.dryRun ? wouldPush : pushed,
          conflictsSkipped: conflicts,
          hint: conflicts.length > 0 ? 'Conflicts changed on both sides; resolve manually then re-run, or sync_pull to take Studio.' : undefined,
        }, null, 2),
      }] as ToolContent[],
    };
  }
}
