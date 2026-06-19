// Interpret the plugin's insert-asset response so the marketplace flow can react:
// success, or a typed failure (AUTH = copy-locked toolbox model, NOT_FOUND =
// bad parent path, etc.). InsertService:LoadAsset only loads assets the user owns
// or that are public + copy-unlocked, so toolbox models commonly come back AUTH —
// search-and-insert uses this to skip to the next candidate instead of throwing.

import { classifyError, ErrorCode } from './errors.js';

export interface InsertOutcome {
  ok: boolean;
  code?: ErrorCode;
  message?: string;
}

export function interpretInsertResponse(response: unknown): InsertOutcome {
  if (!response || typeof response !== 'object') {
    return { ok: false, code: 'UNKNOWN', message: 'No response from plugin' };
  }
  const r = response as Record<string, unknown>;

  if (typeof r.error === 'string' && r.error.length > 0) {
    return { ok: false, code: classifyError(r.error), message: r.error };
  }

  const insertedCount = Number(r.insertedCount);
  if (Number.isFinite(insertedCount) && insertedCount > 0) {
    return { ok: true };
  }
  // Some success payloads omit insertedCount but carry instances.
  if (Array.isArray(r.instances) && r.instances.length > 0) {
    return { ok: true };
  }

  return { ok: false, code: 'UNKNOWN', message: 'Asset produced no instances' };
}
