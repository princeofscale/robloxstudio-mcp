import { diffFingerprints, SnapshotStore, type Fingerprint } from '../world-changes.js';
import { buildWorldFingerprintLuau } from '../builders/world-fingerprint.js';

const node = (p: string, st: string, se = '', me = '') => ({ p, st, se, me });

describe('diffFingerprints', () => {
  it('detects added, removed, and per-channel changes', () => {
    const prev: Fingerprint = {
      a: node('Workspace.A', 'Part|r|A|0', 'geom:1,1,1', ''),
      b: node('Workspace.B', 'Model|r|B|2', '', 't:Tree'),
      c: node('Workspace.C', 'Folder|r|C|1', '', ''),
    };
    const curr: Fingerprint = {
      a: node('Workspace.A', 'Part|r|A|0', 'geom:9,1,1', ''),      // semantics moved
      b: node('Workspace.B', 'Model|r|B|2', '', 't:Tree,Big'),     // meta moved
      d: node('Workspace.D', 'Part|r|D|0', '', ''),                // added
    };
    const diff = diffFingerprints(prev, curr);
    expect(diff.added.map((x) => x.id)).toEqual(['d']);
    expect(diff.removed.map((x) => x.id)).toEqual(['c']);
    const a = diff.changed.find((x) => x.id === 'a')!;
    const b = diff.changed.find((x) => x.id === 'b')!;
    expect(a.channels).toEqual(['semantics']);
    expect(b.channels).toEqual(['meta']);
  });

  it('reports a structure change (rename/move/childCount)', () => {
    const prev: Fingerprint = { a: node('Workspace.A', 'Part|r|A|0') };
    const curr: Fingerprint = { a: node('Workspace.Renamed', 'Part|r|Renamed|0') };
    const diff = diffFingerprints(prev, curr);
    expect(diff.changed[0].channels).toEqual(['structure']);
  });

  it('returns empty diffs for identical fingerprints', () => {
    const fp: Fingerprint = { a: node('A', 's', 'se', 'me') };
    const diff = diffFingerprints(fp, { a: node('A', 's', 'se', 'me') });
    expect(diff.addedCount + diff.removedCount + diff.changedCount).toBe(0);
  });
});

describe('SnapshotStore', () => {
  it('stores, retrieves, and rolls a baseline', () => {
    const store = new SnapshotStore();
    const id = store.put('game', { a: node('A', 's1') });
    expect(store.get(id)?.fingerprint.a.st).toBe('s1');
    store.update(id, { a: node('A', 's2') });
    expect(store.get(id)?.fingerprint.a.st).toBe('s2');
  });

  it('evicts the oldest beyond capacity', () => {
    const store = new SnapshotStore(2);
    const id1 = store.put('p', { a: node('a', '1') });
    store.put('p', { b: node('b', '1') });
    store.put('p', { c: node('c', '1') });
    expect(store.get(id1)).toBeUndefined();
  });
});

describe('buildWorldFingerprintLuau', () => {
  it('emits three channels keyed by a stable node id', () => {
    const code = buildWorldFingerprintLuau('game.Workspace');
    expect(code).toContain('resolvePath("game.Workspace")');
    expect(code).toContain('d:GetDebugId(0)');
    expect(code).toContain('structureSig(d)');
    expect(code).toContain('semanticsSig(d)');
    expect(code).toContain('metaSig(d)');
    expect(code).toContain('st = structureSig(d)');
  });

  it('computes domain-specific semantics for parts, sounds, scripts', () => {
    const code = buildWorldFingerprintLuau();
    expect(code).toContain('d:IsA("BasePart")');
    expect(code).toContain('d:IsA("Sound")');
    expect(code).toContain('d:IsA("LuaSourceContainer")');
    expect(code).toContain('d:GetTags()');
    expect(code).toContain('d:GetAttributes()');
  });

  it('caps the node count and flags truncation', () => {
    const code = buildWorldFingerprintLuau('game', 100);
    expect(code).toContain('count >= 100');
    expect(code).toContain('truncated = true');
  });
});
