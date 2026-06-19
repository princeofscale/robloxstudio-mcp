import { interpretInsertResponse } from '../assets.js';

describe('interpretInsertResponse', () => {
  it('treats a response with inserted instances as success', () => {
    expect(interpretInsertResponse({ parentPath: 'game.Workspace', insertedCount: 1, instances: [{}] }))
      .toEqual({ ok: true });
  });

  it('flags an auth-locked toolbox model with code AUTH', () => {
    const r = interpretInsertResponse({ error: 'Failed to insert asset 5: User is not authorized to access Asset 5' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('AUTH');
    expect(r.message).toContain('not authorized');
  });

  it('flags a missing parent with code NOT_FOUND', () => {
    const r = interpretInsertResponse({ error: 'Parent instance not found: game.Workspace.Map' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NOT_FOUND');
  });

  it('treats insertedCount 0 as a (non-throwing) failure', () => {
    const r = interpretInsertResponse({ parentPath: 'game.Workspace', insertedCount: 0, instances: [] });
    expect(r.ok).toBe(false);
  });

  it('handles junk defensively', () => {
    expect(interpretInsertResponse(null).ok).toBe(false);
    expect(interpretInsertResponse(undefined).ok).toBe(false);
  });
});
