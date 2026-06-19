import { roundFloat, compact } from '../compact.js';

describe('roundFloat', () => {
  it('rounds long floats to the given precision', () => {
    expect(roundFloat(0.9019607843, 3)).toBe(0.902);
  });
  it('collapses float noise to a clean integer', () => {
    expect(roundFloat(175.00000001, 3)).toBe(175);
  });
  it('leaves exact integers (e.g. asset ids) untouched', () => {
    expect(roundFloat(123456789, 3)).toBe(123456789);
  });
  it('passes non-finite values through unchanged', () => {
    expect(roundFloat(Infinity, 3)).toBe(Infinity);
    expect(Number.isNaN(roundFloat(NaN, 3))).toBe(true);
  });
});

describe('compact', () => {
  it('rounds floats deep inside arrays and objects', () => {
    const out = compact({ pos: [175.00000001, 0.9019607843, -1.5], id: 42 });
    expect(out).toEqual({ pos: [175, 0.902, -1.5], id: 42 });
  });

  it('drops null and undefined fields but keeps falsy-but-meaningful values', () => {
    const out = compact({ a: null, b: undefined, c: 0, d: '', e: false, f: [] });
    expect(out).toEqual({ c: 0, d: '', e: false, f: [] });
  });

  it('leaves strings and booleans alone', () => {
    expect(compact({ name: 'Part', anchored: true })).toEqual({ name: 'Part', anchored: true });
  });

  it('recurses through nested structures', () => {
    const out = compact({ children: [{ name: 'A', size: [1.123456, 2] }, { name: 'B', extra: null }] });
    expect(out).toEqual({ children: [{ name: 'A', size: [1.123, 2] }, { name: 'B' }] });
  });
});
