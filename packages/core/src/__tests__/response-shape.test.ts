import { paginateList, pickFields, shapeListResponse } from '../response-shape.js';

describe('paginateList', () => {
  const items = [1, 2, 3, 4, 5];
  it('returns all items and hasMore=false with no options', () => {
    expect(paginateList(items, {})).toEqual({ items, total: 5, offset: 0, returned: 5, hasMore: false });
  });
  it('limits the page and flags hasMore', () => {
    expect(paginateList(items, { limit: 2 })).toEqual({ items: [1, 2], total: 5, offset: 0, returned: 2, hasMore: true });
  });
  it('applies offset and computes hasMore at the boundary', () => {
    expect(paginateList(items, { limit: 2, offset: 4 })).toEqual({ items: [5], total: 5, offset: 4, returned: 1, hasMore: false });
  });
});

describe('pickFields', () => {
  const part = { name: 'Part', className: 'Part', path: 'game.Workspace.Part', size: [1, 2, 3] };
  it('keeps only requested fields', () => {
    expect(pickFields(part, ['name', 'className'])).toEqual({ name: 'Part', className: 'Part' });
  });
  it('returns the item unchanged when fields is empty or undefined', () => {
    expect(pickFields(part, undefined)).toBe(part);
    expect(pickFields(part, [])).toBe(part);
  });
  it('ignores fields the item does not have', () => {
    expect(pickFields(part, ['name', 'nope'])).toEqual({ name: 'Part' });
  });
});

describe('shapeListResponse', () => {
  const response = { instancePath: 'game.Workspace', descendants: [
    { name: 'A', className: 'Part', path: 'p1', depth: 1 },
    { name: 'B', className: 'Model', path: 'p2', depth: 1 },
    { name: 'C', className: 'Part', path: 'p3', depth: 2 },
  ], count: 3 };

  it('paginates the named list and adds a pagination block', () => {
    const out = shapeListResponse(response, 'descendants', { limit: 2 });
    expect(out.descendants).toHaveLength(2);
    expect(out.pagination).toEqual({ total: 3, offset: 0, returned: 2, hasMore: true });
  });

  it('projects requested fields onto each item', () => {
    const out = shapeListResponse(response, 'descendants', { fields: ['name'] });
    expect(out.descendants[0]).toEqual({ name: 'A' });
  });

  it('passes error responses through untouched', () => {
    const err = { error: 'Path not found' };
    expect(shapeListResponse(err, 'descendants', { limit: 2 })).toBe(err);
  });

  it('is a no-op when no shaping options are given', () => {
    expect(shapeListResponse(response, 'descendants', {})).toBe(response);
  });
});
