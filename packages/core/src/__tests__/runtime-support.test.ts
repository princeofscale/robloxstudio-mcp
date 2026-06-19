import {
  buildNetworkProfileLuau,
  errorMessage,
  normalizeNetworkProfile,
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
});
