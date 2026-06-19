import { classifyError, typedError, responseErrorCode, ErrorCode } from '../errors.js';

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
