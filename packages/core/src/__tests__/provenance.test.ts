import { requiresAttribution } from '../tools/index.js';

describe('requiresAttribution', () => {
  it('is true for CC-BY family and explicit attribution licenses', () => {
    for (const lic of ['CC-BY-4.0', 'CC BY 4.0', 'ccby', 'CC-BY-SA', 'Attribution required']) {
      expect(requiresAttribution(lic)).toBe(true);
    }
  });
  it('is false for CC0 / public-domain / missing licenses', () => {
    for (const lic of ['CC0', 'CC0-1.0', 'public domain', 'MIT', '', undefined]) {
      expect(requiresAttribution(lic)).toBe(false);
    }
  });
});
