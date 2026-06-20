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
  | 'CONFIRMATION_REQUIRED'
  | 'AMBIGUOUS_TARGET'
  | 'INVALID_ARGUMENT'
  | 'UNSUPPORTED_CLASS'
  | 'INSERT_NOT_PERMITTED'
  | 'RESOURCE_TOO_LARGE'
  | 'BETA_FEATURE_REQUIRED'
  | 'UNKNOWN';

const PATTERNS: Array<[RegExp, ErrorCode]> = [
  // Order matters: more specific first.
  [/\b429\b|rate.?limit/i, 'RATE_LIMITED'],
  [/confirm(ation)?\s+required|requires?\s+confirm|pass\s+confirm/i, 'CONFIRMATION_REQUIRED'],
  [/multiple\s+(places|instances)|ambiguous\s+target|which\s+instance|specify\s+instance_id/i, 'AMBIGUOUS_TARGET'],
  [/not\s+authorized|unauthorized|access\s+asset|forbidden|\b403\b/i, 'AUTH'],
  [/too\s+large|exceeds?\s+(the\s+)?limit|size\s+limit|over\s+the\s+limit/i, 'RESOURCE_TOO_LARGE'],
  [/beta\s+(feature|api)|enable\s+.*beta|requires?\s+.*beta/i, 'BETA_FEATURE_REQUIRED'],
  [/not\s+creatable|cannot\s+create|unsupported\s+class|invalid\s+class/i, 'UNSUPPORTED_CLASS'],
  [/time?d?\s*out|timeout/i, 'TIMEOUT'],
  [/no\s+(studio\s+)?plugin|plugin\s+(not\s+)?(connected|disconnected)|not\s+connected/i, 'PLUGIN_DISCONNECTED'],
  [/not\s+found|does\s+not\s+exist|no\s+instance/i, 'NOT_FOUND'],
  [/required|missing\s+(argument|parameter|field)|must\s+be\s+(a|an)\b/i, 'INVALID_ARGUMENT'],
];

// Codes worth retrying as-is (transient/transport) vs. ones that need the agent
// to change something (auth, bad argument, confirmation).
const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'TIMEOUT',
  'RATE_LIMITED',
  'PLUGIN_DISCONNECTED',
]);

export function isRetryable(code: ErrorCode): boolean {
  return RETRYABLE.has(code);
}

// Suggested next move per code, so an agent can branch without parsing prose.
const RECOVERY: Partial<Record<ErrorCode, string>> = {
  TIMEOUT: 'retry; for heavy code prefer execute_luau_async',
  RATE_LIMITED: 'back off and retry shortly',
  PLUGIN_DISCONNECTED: 'check the Studio plugin is connected, then retry',
  AUTH: 'pick another asset or provide credentials',
  INSERT_NOT_PERMITTED: 'pick another candidate (prefer a free, copy-unlocked asset)',
  NOT_FOUND: 're-resolve the path (it may have changed)',
  AMBIGUOUS_TARGET: 'pass instance_id from get_connected_instances',
  CONFIRMATION_REQUIRED: 'retry with confirm: true once you have reviewed the operation',
  INVALID_ARGUMENT: 'fix the arguments and retry',
  RESOURCE_TOO_LARGE: 'reduce the size/count and retry',
  BETA_FEATURE_REQUIRED: 'enable the required Studio beta, then retry',
  UNSUPPORTED_CLASS: 'use a creatable class',
};

export interface ErrorEnvelope {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    stage?: string;
    suggestedRecovery?: string;
    details?: Record<string, unknown>;
  };
}

/**
 * Build a uniform, agent-friendly error envelope. The code is classified from the
 * message when not given; retryable and suggestedRecovery are derived from the code.
 */
export function errorEnvelope(
  message: string,
  opts: { code?: ErrorCode; stage?: string; details?: Record<string, unknown> } = {},
): ErrorEnvelope {
  const code = opts.code ?? classifyError(message);
  return {
    ok: false,
    error: {
      code,
      message: String(message ?? ''),
      retryable: isRetryable(code),
      ...(opts.stage ? { stage: opts.stage } : {}),
      ...(RECOVERY[code] ? { suggestedRecovery: RECOVERY[code] } : {}),
      ...(opts.details ? { details: opts.details } : {}),
    },
  };
}

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
