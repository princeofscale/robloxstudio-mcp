import { normalizePolyHaven, normalizeAmbientCg, searchAssetSources } from '../tools/asset-sources.js';

const polyHavenJson = {
  brick_wall_001: { name: 'Brick Wall 001', type: 1, categories: ['brick', 'wall'] },
  rock_boulder_02: { name: 'Rock Boulder 02', type: 2, categories: ['rock', 'nature'] },
  sunset_sky: { name: 'Sunset Sky', type: 0, categories: ['sky'] },
};

const ambientCgJson = {
  foundAssets: [
    { assetId: 'Bricks075A', displayName: 'Bricks 075 A', category: 'Material', previewImage: { '256-PNG': 'https://acg.example/Bricks075A_256.png' } },
    { assetId: 'NoPreview', displayName: 'No Preview', category: 'Material', previewImage: {} },
  ],
};

describe('normalizePolyHaven', () => {
  it('filters by query and maps type codes', () => {
    const r = normalizePolyHaven(polyHavenJson, 'brick', 10);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ provider: 'polyhaven', id: 'brick_wall_001', type: 'texture', license: 'CC0', attributionRequired: false });
    expect(r[0].pageUrl).toContain('brick_wall_001');
  });

  it('returns all with empty query, respecting the limit', () => {
    expect(normalizePolyHaven(polyHavenJson, '', 2)).toHaveLength(2);
    expect(normalizePolyHaven(polyHavenJson, '', 10)).toHaveLength(3);
  });

  it('tolerates non-object input', () => {
    expect(normalizePolyHaven(null, 'x', 10)).toEqual([]);
  });
});

describe('normalizeAmbientCg', () => {
  it('maps assets and uses the preview PNG as a direct downloadUrl', () => {
    const r = normalizeAmbientCg(ambientCgJson, 10);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ provider: 'ambientcg', id: 'Bricks075A', license: 'CC0', downloadUrl: 'https://acg.example/Bricks075A_256.png' });
    expect(r[1].downloadUrl).toBeUndefined();
  });
});

describe('searchAssetSources', () => {
  it('aggregates providers, injects browse-only pointers, and reports per-provider errors', async () => {
    const fetchJson = async (url: string) => {
      if (url.includes('polyhaven')) return polyHavenJson;
      if (url.includes('ambientcg')) throw new Error('boom');
      return {};
    };
    const out = await searchAssetSources('brick', { limit: 10 }, fetchJson);
    expect(out.results.some((r) => r.provider === 'polyhaven')).toBe(true);
    expect(out.results.some((r) => r.provider === 'kenney')).toBe(true);
    expect(out.results.some((r) => r.provider === 'quaternius')).toBe(true);
    expect(out.errors.ambientcg).toBe('boom');
    expect(out.results.every((r) => r.license === 'CC0')).toBe(true);
  });

  it('honors an explicit provider subset', async () => {
    const fetchJson = async () => polyHavenJson;
    const out = await searchAssetSources('', { providers: ['polyhaven'], limit: 1 }, fetchJson);
    expect(out.providers).toEqual(['polyhaven']);
    expect(out.results.every((r) => r.provider === 'polyhaven')).toBe(true);
  });
});
