import { SafetyManager } from '../safety/safety-manager.js';

describe('SafetyManager.assess', () => {
  it('allows a plain delete of a normal instance without confirmation', () => {
    const safety = new SafetyManager();
    const a = safety.assess({ kind: 'delete', path: 'Workspace.Model.Part' });
    expect(a.blocked).toBe(false);
    expect(a.requiresConfirmation).toBe(false);
    expect(a.allowed).toBe(true);
  });

  it('requires confirmation when deleting a protected service', () => {
    const safety = new SafetyManager();
    const a = safety.assess({ kind: 'delete', path: 'ServerScriptService' });
    expect(a.requiresConfirmation).toBe(true);
    expect(a.allowed).toBe(false);
    expect(a.reasons.join(' ')).toMatch(/protected/i);
  });

  it('allows a protected-path delete once confirmed', () => {
    const safety = new SafetyManager();
    const a = safety.assess({ kind: 'delete', path: 'Workspace', confirmed: true });
    expect(a.allowed).toBe(true);
    expect(a.requiresConfirmation).toBe(true);
  });

  it('blocks bulk operations over the object limit even when confirmed', () => {
    const safety = new SafetyManager({ maxObjectsPerOperation: 100 });
    const a = safety.assess({ kind: 'bulk_create', count: 500, confirmed: true });
    expect(a.blocked).toBe(true);
    expect(a.allowed).toBe(false);
    expect(a.reasons.join(' ')).toMatch(/limit/i);
  });

  it('blocks script sources larger than the configured max size', () => {
    const safety = new SafetyManager({ maxScriptSize: 10 });
    const a = safety.assess({ kind: 'set_script_source', scriptSize: 50, confirmed: true });
    expect(a.blocked).toBe(true);
    expect(a.allowed).toBe(false);
  });

  it('requires confirmation for execute_luau containing a dangerous pattern', () => {
    const safety = new SafetyManager();
    const a = safety.assess({ kind: 'execute_luau', code: 'game:GetService("Workspace"):ClearAllChildren()' });
    expect(a.requiresConfirmation).toBe(true);
    expect(a.warnings.length).toBeGreaterThan(0);
  });

  it('does not require confirmation for benign luau', () => {
    const safety = new SafetyManager();
    const a = safety.assess({ kind: 'execute_luau', code: 'return 1 + 1' });
    expect(a.requiresConfirmation).toBe(false);
    expect(a.allowed).toBe(true);
  });

  it('blocks terrain fills over the volume limit even when confirmed', () => {
    const safety = new SafetyManager({ maxTerrainVolume: 1000 });
    const a = safety.assess({ kind: 'terrain_fill', count: 5000, confirmed: true });
    expect(a.blocked).toBe(true);
    expect(a.allowed).toBe(false);
    expect(a.reasons.join(' ')).toMatch(/terrain|volume/i);
  });

  it('passes through dryRun as an allowed, non-mutating assessment', () => {
    const safety = new SafetyManager();
    const a = safety.assess({ kind: 'delete', path: 'ServerScriptService', dryRun: true });
    expect(a.allowed).toBe(true);
    expect(a.dryRun).toBe(true);
  });
});

describe('SafetyManager history and backups', () => {
  it('records operations and returns them most-recent-first', () => {
    const safety = new SafetyManager();
    safety.recordOperation({ kind: 'delete', summary: 'deleted A' });
    safety.recordOperation({ kind: 'create', summary: 'created B' });
    const history = safety.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0].summary).toBe('created B');
    expect(history[0].timestamp).toBeGreaterThan(0);
  });

  it('caps history at the configured limit', () => {
    const safety = new SafetyManager({ historyLimit: 3 });
    for (let i = 0; i < 10; i++) safety.recordOperation({ kind: 'create', summary: `op-${i}` });
    expect(safety.getHistory()).toHaveLength(3);
    expect(safety.getHistory()[0].summary).toBe('op-9');
  });

  it('stores and retrieves the latest script backup for a path', () => {
    const safety = new SafetyManager();
    safety.backupScript('Workspace.Script', 'print("v1")');
    safety.backupScript('Workspace.Script', 'print("v2")');
    const backup = safety.getBackup('Workspace.Script');
    expect(backup?.source).toBe('print("v2")');
    expect(backup?.previous).toBe('print("v1")');
  });

  it('returns undefined for an unknown backup path', () => {
    const safety = new SafetyManager();
    expect(safety.getBackup('Nope')).toBeUndefined();
  });
});
