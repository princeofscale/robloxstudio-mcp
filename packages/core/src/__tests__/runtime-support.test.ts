import {
  buildNetworkProfileLuau,
  errorMessage,
  normalizeNetworkProfile,
  normalizeExecuteLuauToolResult,
} from '../tools/runtime-support.js';

describe('runtime support helpers', () => {
  it('normalizes custom network overrides and rejects unsupported keys', () => {
    expect(normalizeNetworkProfile('custom', { InboundNetworkMinDelayMs: 20 })).toEqual({
      InboundNetworkMinDelayMs: 20,
    });
    expect(() => normalizeNetworkProfile('custom', { UnknownKey: 1 })).toThrow('Unsupported network override');
  });

  it('builds network profile Luau with the selected profile label', () => {
    const code = buildNetworkProfileLuau('good', normalizeNetworkProfile('good'));
    expect(code).toContain('profile = "good"');
    expect(code).toContain('InboundNetworkMinDelayMs');
  });

  it('formats unknown errors safely', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
  });

  it('unwraps execute-luau JSON payloads and falls back to a safe object', () => {
    expect(normalizeExecuteLuauToolResult({
      success: true,
      returnValue: JSON.stringify({ ok: true, count: 2 }),
    })).toEqual({ ok: true, count: 2 });

    expect(normalizeExecuteLuauToolResult({
      success: true,
      returnValue: 42,
      output: 'raw',
    })).toEqual({
      error: 'execute-luau did not return a JSON object',
      output: 'raw',
    });
  });
});
