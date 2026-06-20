// SafetyManager — a single, dependency-free guard the tool layer consults
// before any destructive or bulk operation. It is pure logic (no I/O), which
// keeps it trivially unit-testable and lets every MCP tool share one consistent
// policy: dry-run, confirmation gating, hard limits, script backups, and an
// in-memory operation history that powers undo/audit tooling.

/** Operations the safety layer knows how to reason about. */
export type OperationKind =
  | 'delete'
  | 'bulk_create'
  | 'bulk_delete'
  | 'bulk_duplicate'
  | 'bulk_mutate'
  | 'set_script_source'
  | 'replace_in_scripts'
  | 'execute_luau'
  | 'terrain_fill'
  | 'terrain_clear';

export interface SafetyConfig {
  /** Hard cap on instances touched by a single bulk operation. */
  maxObjectsPerOperation: number;
  /** Hard cap on a script Source length (characters). */
  maxScriptSize: number;
  /** Hard cap on replacements for replace_in_scripts. */
  maxReplacements: number;
  /** Hard cap on the studs³ volume a single terrain fill/generate may touch. */
  maxTerrainVolume: number;
  /** How many operation-history entries to retain in memory. */
  historyLimit: number;
  /** How many distinct script backups to retain in memory. */
  backupLimit: number;
  /**
   * Exact DataModel paths that must never be deleted casually. Deleting one of
   * these is gated behind explicit confirmation (never silently allowed).
   */
  protectedPaths: string[];
  /**
   * Luau substrings/patterns that mark code as destructive enough to warrant a
   * confirmation prompt and a loud warning before it runs.
   */
  dangerousLuauPatterns: RegExp[];
}

export const DEFAULT_SAFETY_CONFIG: SafetyConfig = {
  maxObjectsPerOperation: 1000,
  maxScriptSize: 200_000,
  maxReplacements: 1000,
  maxTerrainVolume: 50_000_000,
  historyLimit: 200,
  backupLimit: 100,
  protectedPaths: [
    'Workspace',
    'ServerScriptService',
    'ServerStorage',
    'ReplicatedStorage',
    'ReplicatedFirst',
    'StarterGui',
    'StarterPack',
    'StarterPlayer',
    'Lighting',
    'SoundService',
    'Players',
    'Teams',
    'Chat',
  ],
  dangerousLuauPatterns: [
    /ClearAllChildren\s*\(/,
    /:Destroy\s*\(/,
    /:Remove\s*\(/,
    /game:GetService\(["']DataStoreService["']\)/,
    /\bos\.execute\b/,
    /\bos\.remove\b/,
    /\bos\.exit\b/,
    /:SetAsync\s*\(/,
    /:RemoveAsync\s*\(/,
    /:ClearTerrain\s*\(/,
    /\bFillRegion\b/,
    /\bClear\s*\(/,
  ],
};

export interface AssessmentInput {
  kind: OperationKind;
  /** DataModel path for single-target destructive ops (delete). */
  path?: string;
  /** Number of instances/replacements affected for bulk ops. */
  count?: number;
  /** Source length in characters for script writes. */
  scriptSize?: number;
  /** Luau source for execute_luau / dangerous-pattern scanning. */
  code?: string;
  /** Caller has explicitly confirmed a gated operation. */
  confirmed?: boolean;
  /** Preview only — never mutates, always reported as allowed. */
  dryRun?: boolean;
}

export interface Assessment {
  /** Final verdict: may the operation proceed and mutate? */
  allowed: boolean;
  /** Operation is gated; needs `confirmed: true` to be allowed. */
  requiresConfirmation: boolean;
  /** Hard block — confirmation cannot override (e.g. over a hard limit). */
  blocked: boolean;
  /** True when this was a non-mutating preview. */
  dryRun: boolean;
  /** Machine-and-human readable reasons the op is gated/blocked. */
  reasons: string[];
  /** Non-fatal advisories worth showing the user. */
  warnings: string[];
}

export interface OperationRecord {
  kind: string;
  summary: string;
}

export interface HistoryEntry extends OperationRecord {
  timestamp: number;
}

export interface ScriptBackup {
  path: string;
  /** Most recent source captured before a write. */
  source: string;
  /** The source captured before `source` (one step further back), if any. */
  previous?: string;
  timestamp: number;
}

export class SafetyManager {
  private readonly config: SafetyConfig;
  private readonly history: HistoryEntry[] = [];
  private readonly backups = new Map<string, ScriptBackup>();

  constructor(config: Partial<SafetyConfig> = {}) {
    this.config = { ...DEFAULT_SAFETY_CONFIG, ...config };
  }

  getConfig(): SafetyConfig {
    return { ...this.config };
  }

  /**
   * Decide whether an operation may proceed. Pure and side-effect free so the
   * tool layer can call it freely (including for dry-run previews).
   */
  assess(input: AssessmentInput): Assessment {
    const reasons: string[] = [];
    const warnings: string[] = [];
    let requiresConfirmation = false;
    let blocked = false;

    // Protected-path deletes are always gated behind confirmation.
    if ((input.kind === 'delete' || input.kind === 'bulk_delete') && input.path) {
      if (this.isProtectedPath(input.path)) {
        requiresConfirmation = true;
        reasons.push(`"${input.path}" is a protected service/root and deleting it can wipe large parts of the place.`);
      }
    }

    // Bulk size: a hard limit (blocks) plus confirmation gating as it grows.
    // Only object-count kinds use this; terrain kinds carry a studs³ volume in
    // `count` and are governed by maxTerrainVolume below instead.
    const isBulkObjectKind =
      input.kind === 'bulk_create' || input.kind === 'bulk_delete' || input.kind === 'bulk_duplicate' || input.kind === 'bulk_mutate';
    if (isBulkObjectKind && typeof input.count === 'number') {
      if (input.count > this.config.maxObjectsPerOperation) {
        blocked = true;
        reasons.push(`Operation affects ${input.count} objects, over the safety limit of ${this.config.maxObjectsPerOperation}.`);
      } else if (input.count > Math.floor(this.config.maxObjectsPerOperation / 2)) {
        requiresConfirmation = true;
        reasons.push(`Operation affects ${input.count} objects — large bulk change.`);
      }
    }

    // Script size hard limit.
    if (typeof input.scriptSize === 'number' && input.scriptSize > this.config.maxScriptSize) {
      blocked = true;
      reasons.push(`Script source is ${input.scriptSize} chars, over the safety limit of ${this.config.maxScriptSize}.`);
    }

    // Dangerous Luau scanning.
    if (input.code) {
      const hits = this.config.dangerousLuauPatterns.filter((re) => re.test(input.code as string));
      if (hits.length > 0) {
        requiresConfirmation = true;
        warnings.push(`Luau contains ${hits.length} potentially destructive call(s); review before running.`);
        reasons.push('Luau matches a dangerous-operation pattern.');
      }
    }

    // terrain_clear is intrinsically destructive — always gate it.
    if (input.kind === 'terrain_clear') {
      requiresConfirmation = true;
      reasons.push('Clearing terrain is irreversible for the affected region.');
    }

    // terrain fills/generates are capped by volume to avoid freezing Studio.
    if (input.kind === 'terrain_fill' && typeof input.count === 'number' && input.count > this.config.maxTerrainVolume) {
      blocked = true;
      reasons.push(`Terrain volume ${input.count} studs³ exceeds the safety limit of ${this.config.maxTerrainVolume}.`);
    }

    const dryRun = input.dryRun === true;
    if (dryRun) {
      return { allowed: true, requiresConfirmation, blocked, dryRun: true, reasons, warnings };
    }

    let allowed = !blocked;
    if (requiresConfirmation && !input.confirmed) {
      allowed = false;
    }

    return { allowed, requiresConfirmation, blocked, dryRun: false, reasons, warnings };
  }

  isProtectedPath(path: string): boolean {
    const trimmed = path.trim();
    return this.config.protectedPaths.some((p) => p === trimmed || trimmed === `game.${p}`);
  }

  recordOperation(record: OperationRecord): void {
    this.history.push({ ...record, timestamp: Date.now() });
    if (this.history.length > this.config.historyLimit) {
      this.history.splice(0, this.history.length - this.config.historyLimit);
    }
  }

  /** History most-recent-first. */
  getHistory(): HistoryEntry[] {
    return [...this.history].reverse();
  }

  backupScript(path: string, source: string): void {
    const existing = this.backups.get(path);
    this.backups.set(path, {
      path,
      source,
      previous: existing?.source,
      timestamp: Date.now(),
    });
    if (this.backups.size > this.config.backupLimit) {
      const oldestKey = this.backups.keys().next().value;
      if (oldestKey !== undefined) this.backups.delete(oldestKey);
    }
  }

  getBackup(path: string): ScriptBackup | undefined {
    return this.backups.get(path);
  }

  listBackups(): ScriptBackup[] {
    return [...this.backups.values()].sort((a, b) => b.timestamp - a.timestamp);
  }
}
