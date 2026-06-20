import { classifyError, typedError, responseErrorCode, isRetryable, errorEnvelope, ErrorCode } from '../errors.js';

describe('extended classifyError codes', () => {
  const cases: Array<[string, ErrorCode]> = [
    ['Confirmation required: pass confirm: true', 'CONFIRMATION_REQUIRED'],
    ['Multiple places connected; specify instance_id', 'AMBIGUOUS_TARGET'],
    ['Terrain volume too large, exceeds the limit', 'RESOURCE_TOO_LARGE'],
    ['Requires Studio Debugger beta enabled', 'BETA_FEATURE_REQUIRED'],
    ['ClassName is not creatable', 'UNSUPPORTED_CLASS'],
    ['assetId is required', 'INVALID_ARGUMENT'],
  ];
  it.each(cases)('classifies %j as %s', (msg, code) => {
    expect(classifyError(msg)).toBe(code);
  });
});

describe('isRetryable', () => {
  it('marks transient transport codes retryable', () => {
    expect(isRetryable('TIMEOUT')).toBe(true);
    expect(isRetryable('RATE_LIMITED')).toBe(true);
    expect(isRetryable('PLUGIN_DISCONNECTED')).toBe(true);
  });
  it('marks action-needed codes non-retryable', () => {
    expect(isRetryable('AUTH')).toBe(false);
    expect(isRetryable('INVALID_ARGUMENT')).toBe(false);
    expect(isRetryable('CONFIRMATION_REQUIRED')).toBe(false);
  });
});

describe('errorEnvelope', () => {
  it('builds a uniform envelope with derived retryable + recovery', () => {
    const env = errorEnvelope('User is not authorized to access Asset', { stage: 'preflight', details: { assetId: 5 } });
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe('AUTH');
    expect(env.error.retryable).toBe(false);
    expect(env.error.stage).toBe('preflight');
    expect(env.error.suggestedRecovery).toBeDefined();
    expect(env.error.details).toEqual({ assetId: 5 });
  });

  it('honors an explicit code and marks timeout retryable', () => {
    const env = errorEnvelope('boom', { code: 'TIMEOUT' });
    expect(env.error.code).toBe('TIMEOUT');
    expect(env.error.retryable).toBe(true);
  });
});

describe('responseErrorCode', () => {
  it('returns undefined for a successful response (no error field)', () => {
    expect(responseErrorCode({ children: [] })).toBeUndefined();
  });
  it('classifies a plugin error string', () => {
    expect(responseErrorCode({ error: 'Instance not found: game.Workspace.Map' })).toBe('NOT_FOUND');
  });
  it('returns undefined for non-objects', () => {
    expect(responseErrorCode(null)).toBeUndefined();
    expect(responseErrorCode('ok')).toBeUndefined();
  });
});

describe('classifyError', () => {
  const cases: Array<[string, ErrorCode]> = [
    ['User is not authorized to access Asset 123', 'AUTH'],
    ['HTTP 403 Forbidden', 'AUTH'],
    ['Studio plugin connection timeout', 'TIMEOUT'],
    ['request timed out after 30s', 'TIMEOUT'],
    ['Parent instance not found: game.Workspace.Map', 'NOT_FOUND'],
    ['Instance does not exist', 'NOT_FOUND'],
    ['No Studio plugin connected', 'PLUGIN_DISCONNECTED'],
    ['rate limited, retry shortly', 'RATE_LIMITED'],
    ['HTTP 429 Too Many Requests', 'RATE_LIMITED'],
    ['something exploded', 'UNKNOWN'],
  ];
  it.each(cases)('classifies %j as %s', (message, code) => {
    expect(classifyError(message)).toBe(code);
  });
});

describe('typedError', () => {
  it('attaches an auto-classified code to the message', () => {
    expect(typedError('User is not authorized to access Asset 5')).toEqual({
      error: 'User is not authorized to access Asset 5',
      code: 'AUTH',
    });
  });

  it('honors an explicit code override', () => {
    expect(typedError('boom', 'TIMEOUT')).toEqual({ error: 'boom', code: 'TIMEOUT' });
  });
});
