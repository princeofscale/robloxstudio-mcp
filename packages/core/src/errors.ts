// Typed error classification for tool responses. Instead of returning opaque
// strings, tools can attach a stable `code` so an agent can branch on the failure
// kind (retry a timeout, pick another asset on AUTH, re-resolve on NOT_FOUND)
// without parsing English. Patterns are matched against the raw error message.

export type ErrorCode =
  | 'TIMEOUT'
  | 'AUTH'
  | 'NOT_FOUND'
  | 'PLUGIN_DISCONNECTED'
  | 'RATE_LIMITED'
  | 'UNKNOWN';

const PATTERNS: Array<[RegExp, ErrorCode]> = [
  // Order matters: more specific first.
  [/\b429\b|rate.?limit/i, 'RATE_LIMITED'],
  [/not\s+authorized|unauthorized|access\s+asset|forbidden|\b403\b/i, 'AUTH'],
  [/time?d?\s*out|timeout/i, 'TIMEOUT'],
  [/no\s+(studio\s+)?plugin|plugin\s+(not\s+)?(connected|disconnected)|not\s+connected/i, 'PLUGIN_DISCONNECTED'],
  [/not\s+found|does\s+not\s+exist|no\s+instance/i, 'NOT_FOUND'],
];

export function classifyError(message: string): ErrorCode {
  const text = String(message ?? '');
  for (const [re, code] of PATTERNS) {
    if (re.test(text)) return code;
  }
  return 'UNKNOWN';
}

export function typedError(message: string, code?: ErrorCode): { error: string; code: ErrorCode } {
  return { error: String(message ?? ''), code: code ?? classifyError(message) };
}

/** Classify a plugin response that may carry an `error` string. undefined = no error. */
export function responseErrorCode(response: unknown): ErrorCode | undefined {
  if (!response || typeof response !== 'object') return undefined;
  const err = (response as { error?: unknown }).error;
  if (typeof err !== 'string' || err.length === 0) return undefined;
  return classifyError(err);
}
