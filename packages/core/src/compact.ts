// Token-efficiency helper for tool responses. Studio read tools return a lot of
// geometry (positions, sizes, CFrames) where the plugin emits full float noise
// like 175.00000000001 or 0.9019607843 — each such number is several wasted
// tokens in the agent's context. compact() rounds floats to a sane precision
// (integers, e.g. asset ids, are left exact) and drops null/undefined fields,
// which shrinks responses substantially with no information the agent needs.

export function roundFloat(n: number, decimals: number): number {
  if (!Number.isFinite(n) || Number.isInteger(n)) return n;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

export function compact<T>(value: T, decimals = 3): T {
  if (typeof value === 'number') {
    return roundFloat(value, decimals) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => compact(v, decimals)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      out[k] = compact(v, decimals);
    }
    return out as unknown as T;
  }
  return value;
}

/** Build a token-lean text tool-result: compact the payload, then stringify. */
export function compactText(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(compact(payload)) }] };
}
