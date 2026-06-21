// World-model + asset-preflight tools, split out of the RobloxStudioTools
// monolith. Token-lean read pipeline (snapshot → batch → changefeed → search) plus
// the authoritative asset insert preflight. All run via execute-luau through the
// shared runtime; the changefeed owns its snapshot store. The facade delegates here.

import { buildWorldSnapshotLuau, buildNodeBatchLuau, type SnapshotLevel } from '../builders/world-model.js';
import { buildSceneSearchLuau } from '../builders/scene-search.js';
import { buildWorldFingerprintLuau } from '../builders/world-fingerprint.js';
import { buildAssetPreflightLuau } from '../builders/asset-preflight.js';
import { diffFingerprints, SnapshotStore, type Fingerprint } from '../world-changes.js';
import { classifyError } from '../errors.js';
import { normalizeExecuteLuauToolResult, wrapToolJsonText, type ToolContent } from './runtime-support.js';

type WorldModelRuntime = {
  callSingle(endpoint: string, data: unknown, target: string | undefined, instance_id: string | undefined): Promise<unknown>;
};

export class WorldModelTools {
  private snapshots = new SnapshotStore();

  constructor(private readonly runtime: WorldModelRuntime) {}

  async getWorldSnapshot(path?: string, level?: SnapshotLevel, topNPerClass?: number, instance_id?: string) {
    const code = buildWorldSnapshotLuau(path ?? 'game', level ?? 'overview', topNPerClass ?? 12);
    const response = await this.runtime.callSingle('/api/execute-luau', { code }, 'edit', instance_id);
    return wrapToolJsonText(normalizeExecuteLuauToolResult(response, {
      error: 'get_world_snapshot returned non-object execute-luau output',
    }));
  }

  async sceneSearch(query: string, path?: string, limit?: number, instance_id?: string) {
    if (!query || !query.trim()) {
      throw new Error('query is required for scene_search');
    }
    const response = await this.runtime.callSingle(
      '/api/execute-luau',
      { code: buildSceneSearchLuau(query, path ?? 'game', limit ?? 10) },
      'edit',
      instance_id,
    );
    return wrapToolJsonText(normalizeExecuteLuauToolResult(response, {
      query,
      total: 0,
      returned: 0,
      results: [],
      error: 'scene_search returned non-object execute-luau output',
    }));
  }

  async getNodeBatch(paths: string[], fields?: string[], includeChildrenCount?: boolean, instance_id?: string) {
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new Error('paths (a non-empty array) is required for get_node_batch');
    }
    const response = await this.runtime.callSingle(
      '/api/execute-luau',
      { code: buildNodeBatchLuau(paths, fields ?? [], includeChildrenCount ?? false) },
      'edit',
      instance_id,
    );
    return wrapToolJsonText(normalizeExecuteLuauToolResult(response, {
      nodes: [],
      count: 0,
      error: 'get_node_batch returned non-object execute-luau output',
    }));
  }

  private async _captureFingerprint(path: string, instance_id?: string): Promise<{ fp: Fingerprint; count: number; truncated: boolean; error?: string }> {
    const response = await this.runtime.callSingle('/api/execute-luau', { code: buildWorldFingerprintLuau(path) }, 'edit', instance_id);
    try {
      const rv = (response as { returnValue?: unknown })?.returnValue;
      if (typeof rv === 'string') {
        const parsed = JSON.parse(rv) as { fingerprint?: Fingerprint; count?: number; truncated?: boolean; error?: string };
        if (parsed.error) return { fp: {}, count: 0, truncated: false, error: parsed.error };
        return { fp: parsed.fingerprint ?? {}, count: parsed.count ?? 0, truncated: parsed.truncated ?? false };
      }
    } catch { /* fall through */ }
    return { fp: {}, count: 0, truncated: false, error: 'Could not parse world fingerprint' };
  }

  async getChangesSince(snapshotId?: string, path?: string, instance_id?: string) {
    const p = path ?? 'game';
    const cur = await this._captureFingerprint(p, instance_id);
    const wrap = (obj: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] as ToolContent[] });
    if (cur.error) return wrap({ error: cur.error, path: p });
    if (!snapshotId) {
      const id = this.snapshots.put(p, cur.fp);
      return wrap({ snapshotId: id, baseline: true, count: cur.count, truncated: cur.truncated, path: p });
    }
    const prev = this.snapshots.get(snapshotId);
    if (!prev) return wrap({ error: 'Unknown or expired snapshotId — call get_changes_since with no snapshotId to start a new baseline.', snapshotId });
    const diff = diffFingerprints(prev.fingerprint, cur.fp);
    this.snapshots.update(snapshotId, cur.fp); // rolling baseline
    return wrap({ snapshotId, path: p, ...diff, count: cur.count, truncated: cur.truncated });
  }

  async assetPreflightInsert(assetId: number, instance_id?: string) {
    if (!assetId || !Number.isFinite(Number(assetId))) {
      throw new Error('assetId (a number) is required for asset_preflight_insert');
    }
    const response = await this.runtime.callSingle('/api/execute-luau', { code: buildAssetPreflightLuau(Number(assetId)) }, 'edit', instance_id);
    let verdict: Record<string, unknown> | undefined;
    try {
      const rv = (response as { returnValue?: unknown })?.returnValue;
      if (typeof rv === 'string') verdict = JSON.parse(rv);
    } catch { /* fall through to raw response */ }
    if (verdict && verdict.insertabilityVerdict === 'no' && typeof verdict.error === 'string') {
      verdict.code = classifyError(verdict.error);
      if (verdict.code === 'AUTH') {
        verdict.hint = 'Copy-locked or not owned — pick another candidate (prefer a free, copy-unlocked asset).';
      }
    }
    return { content: [{ type: 'text', text: JSON.stringify(verdict ?? response) }] as ToolContent[] };
  }
}
