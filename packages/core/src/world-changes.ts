// Pure diff + bounded store for get_changes_since. Each node carries a path plus
// three signature channels (structure / semantics / meta). Diffing two fingerprints
// yields added/removed/changed nodes — and for changed nodes, WHICH channels moved —
// so an agent refreshes only what actually changed instead of re-pulling the world.

export interface NodeFingerprint {
	/** Full path (derived/reporting only — the key is a stable node id). */
	p: string;
	/** structure: class | parentId | name | childCount */
	st: string;
	/** semantics: domain-specific property signature */
	se: string;
	/** meta: sorted tags + attributes */
	me: string;
}

export type Fingerprint = Record<string, NodeFingerprint>;

export type ChangeChannel = 'structure' | 'semantics' | 'meta';

export interface ChangedNode {
	id: string;
	path: string;
	channels: ChangeChannel[];
}

export interface FingerprintDiff {
	added: Array<{ id: string; path: string }>;
	removed: Array<{ id: string; path: string }>;
	changed: ChangedNode[];
	addedCount: number;
	removedCount: number;
	changedCount: number;
}

/** Diff a previous fingerprint against the current one, per channel. */
export function diffFingerprints(prev: Fingerprint, curr: Fingerprint): FingerprintDiff {
	const added: Array<{ id: string; path: string }> = [];
	const removed: Array<{ id: string; path: string }> = [];
	const changed: ChangedNode[] = [];

	for (const id of Object.keys(curr)) {
		const c = curr[id];
		const p = prev[id];
		if (!p) {
			added.push({ id, path: c.p });
			continue;
		}
		const channels: ChangeChannel[] = [];
		if (p.st !== c.st) channels.push('structure');
		if (p.se !== c.se) channels.push('semantics');
		if (p.me !== c.me) channels.push('meta');
		if (channels.length > 0) changed.push({ id, path: c.p, channels });
	}
	for (const id of Object.keys(prev)) {
		if (!(id in curr)) removed.push({ id, path: prev[id].p });
	}

	added.sort((a, b) => a.path.localeCompare(b.path));
	removed.sort((a, b) => a.path.localeCompare(b.path));
	changed.sort((a, b) => a.path.localeCompare(b.path));
	return {
		added,
		removed,
		changed,
		addedCount: added.length,
		removedCount: removed.length,
		changedCount: changed.length,
	};
}

interface StoredSnapshot {
	id: string;
	path: string;
	fingerprint: Fingerprint;
	createdAt: number;
}

/** Bounded in-memory snapshot store keyed by snapshotId. */
export class SnapshotStore {
	private readonly snapshots = new Map<string, StoredSnapshot>();
	private readonly maxSnapshots: number;
	private seq = 0;

	constructor(maxSnapshots = 20) {
		this.maxSnapshots = maxSnapshots;
	}

	private newId(): string {
		this.seq += 1;
		return `snap_${Date.now().toString(36)}_${this.seq}`;
	}

	put(path: string, fingerprint: Fingerprint): string {
		const id = this.newId();
		this.snapshots.set(id, { id, path, fingerprint, createdAt: Date.now() });
		this.prune();
		return id;
	}

	get(id: string): StoredSnapshot | undefined {
		return this.snapshots.get(id);
	}

	/** Replace a stored snapshot's fingerprint in place (rolling baseline). */
	update(id: string, fingerprint: Fingerprint): void {
		const snap = this.snapshots.get(id);
		if (snap) snap.fingerprint = fingerprint;
	}

	private prune(): void {
		if (this.snapshots.size <= this.maxSnapshots) return;
		const overflow = this.snapshots.size - this.maxSnapshots;
		let removed = 0;
		for (const key of this.snapshots.keys()) {
			if (removed >= overflow) break;
			this.snapshots.delete(key);
			removed += 1;
		}
	}
}
