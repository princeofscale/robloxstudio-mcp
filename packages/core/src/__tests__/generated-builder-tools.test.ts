import { GeneratedBuilderTools } from '../tools/generated-builder-tools.js';

describe('GeneratedBuilderTools', () => {
  it('runs generated UI Luau and records the operation', async () => {
    const runGeneratedLuau = jest.fn(async () => ({ content: [{ type: 'text' as const, text: '{}' }] }));
    const recordOperation = jest.fn();
    const tools = new GeneratedBuilderTools({
      runGeneratedLuau,
      safetyGate: jest.fn(() => null),
      recordOperation,
    });

    await tools.uiCreateScreenGui({ name: 'MainGui' }, 'place-1');

    expect(runGeneratedLuau).toHaveBeenCalledWith(expect.stringContaining('ScreenGui'), 'place-1');
    expect(recordOperation).toHaveBeenCalledWith('ui_create', 'ScreenGui MainGui');
  });

  it('returns terrain safety gate results without executing Luau', async () => {
    const gated = { content: [{ type: 'text' as const, text: 'blocked' }] };
    const runGeneratedLuau = jest.fn();
    const tools = new GeneratedBuilderTools({
      runGeneratedLuau,
      safetyGate: jest.fn(() => gated),
      recordOperation: jest.fn(),
    });

    await expect(tools.terrainGenerateBaseplate({ size: [100, 1, 100] })).resolves.toBe(gated);
    expect(runGeneratedLuau).not.toHaveBeenCalled();
  });
});
