// Track A — multi-provider CC0 asset discovery. Searches free, license-clean
// asset libraries and returns ONE normalized descriptor shape across providers,
// so an agent can go: asset_source_search -> pick a result -> import_external_asset
// (feeding a direct file URL) -> provenance recorded. CC0 means no attribution is
// legally required, but the source is still recorded for auditability.
//
// The normalizers are pure (provider JSON -> descriptors) so they're unit-tested
// against fixtures; the live fetch wrapper is thin and network-gated (same posture
// as import_external_asset). The CC0 libraries ship multi-file zips, so a single
// importable URL isn't always available — we surface pageUrl/thumbnailUrl reliably
// and a direct downloadUrl only when the provider's payload gives a single file.

export type AssetSourceProvider = 'polyhaven' | 'ambientcg' | 'kenney' | 'quaternius';

export interface AssetSourceResult {
  provider: AssetSourceProvider;
  id: string;
  name: string;
  type: string;            // texture | hdri | model | pack
  license: string;         // 'CC0'
  attributionRequired: boolean;
  pageUrl: string;
  downloadUrl?: string;    // a single file → feed straight into import_external_asset
  thumbnailUrl?: string;
  note?: string;
}

export interface AssetSourceSearchOptions {
  providers?: AssetSourceProvider[];
  limit?: number;          // per-provider cap (default 10)
}

const POLY_HAVEN_TYPE: Record<number, string> = { 0: 'hdri', 1: 'texture', 2: 'model' };

// Poly Haven: GET https://api.polyhaven.com/assets[?type=textures|hdris|models]
// returns an object map { id: { name, type, categories, ... } }. There's no
// server-side text query, so we filter client-side on id/name/categories.
export function normalizePolyHaven(
  json: unknown,
  query: string,
  limit: number,
): AssetSourceResult[] {
  if (typeof json !== 'object' || json === null) return [];
  const q = query.trim().toLowerCase();
  const out: AssetSourceResult[] = [];
  for (const [id, raw] of Object.entries(json as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const a = raw as { name?: unknown; type?: unknown; categories?: unknown };
    const name = typeof a.name === 'string' ? a.name : id;
    const categories = Array.isArray(a.categories) ? a.categories.map(String) : [];
    const haystack = `${id} ${name} ${categories.join(' ')}`.toLowerCase();
    if (q && !haystack.includes(q)) continue;
    out.push({
      provider: 'polyhaven',
      id,
      name,
      type: POLY_HAVEN_TYPE[Number(a.type)] ?? 'asset',
      license: 'CC0',
      attributionRequired: false,
      pageUrl: `https://polyhaven.com/a/${id}`,
      thumbnailUrl: `https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?width=256&height=256`,
      note: 'Multi-resolution download via polyhaven.com; import a single map file with import_external_asset.',
    });
    if (out.length >= limit) break;
  }
  return out;
}

// ambientCG: GET https://ambientcg.com/api/v2/full_json?q=&type=Material&include=displayData,imageData
// returns { foundAssets: [{ assetId, displayName, category, previewImage }] }.
// previewImage maps sizes → direct PNG URLs, which ARE single importable files.
export function normalizeAmbientCg(json: unknown, limit: number): AssetSourceResult[] {
  const found = (json as { foundAssets?: unknown })?.foundAssets;
  if (!Array.isArray(found)) return [];
  const out: AssetSourceResult[] = [];
  for (const raw of found) {
    if (typeof raw !== 'object' || raw === null) continue;
    const a = raw as { assetId?: unknown; displayName?: unknown; category?: unknown; previewImage?: unknown };
    const id = typeof a.assetId === 'string' ? a.assetId : undefined;
    if (!id) continue;
    const preview = (a.previewImage ?? {}) as Record<string, unknown>;
    const thumb =
      (typeof preview['256-PNG'] === 'string' && preview['256-PNG']) ||
      (typeof preview['128-PNG'] === 'string' && preview['128-PNG']) ||
      undefined;
    out.push({
      provider: 'ambientcg',
      id,
      name: typeof a.displayName === 'string' ? a.displayName : id,
      type: typeof a.category === 'string' ? a.category.toLowerCase() : 'texture',
      license: 'CC0',
      attributionRequired: false,
      pageUrl: `https://ambientcg.com/view?id=${id}`,
      downloadUrl: thumb || undefined,
      thumbnailUrl: thumb || undefined,
      note: thumb
        ? 'downloadUrl is the preview PNG (importable as a Decal). Full PBR maps are zipped on the page.'
        : 'Full PBR maps are zipped on the page; import single files with import_external_asset.',
    });
    if (out.length >= limit) break;
  }
  return out;
}

// Kenney & Quaternius have no public search API (static sites / itch.io packs),
// so we point at them rather than fake search hits.
export const BROWSE_ONLY_SOURCES: Record<'kenney' | 'quaternius', AssetSourceResult> = {
  kenney: {
    provider: 'kenney',
    id: 'kenney',
    name: 'Kenney game assets (CC0)',
    type: 'pack',
    license: 'CC0',
    attributionRequired: false,
    pageUrl: 'https://kenney.nl/assets',
    note: 'Browse-only (no search API). Download a pack, then import_external_asset per file.',
  },
  quaternius: {
    provider: 'quaternius',
    id: 'quaternius',
    name: 'Quaternius 3D models (CC0)',
    type: 'pack',
    license: 'CC0',
    attributionRequired: false,
    pageUrl: 'https://quaternius.com/',
    note: 'Browse-only (no search API). Download a pack, then import_external_asset per file.',
  },
};

type FetchJson = (url: string) => Promise<unknown>;

const defaultFetchJson: FetchJson = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
};

// Live multi-provider search. fetchJson is injectable so the orchestration is
// unit-testable without network. Per-provider failures are reported, not fatal —
// one provider being down shouldn't sink the whole search.
export async function searchAssetSources(
  query: string,
  options: AssetSourceSearchOptions = {},
  fetchJson: FetchJson = defaultFetchJson,
): Promise<{ query: string; providers: AssetSourceProvider[]; results: AssetSourceResult[]; errors: Record<string, string>; hint: string }> {
  const providers = options.providers && options.providers.length > 0
    ? options.providers
    : (['polyhaven', 'ambientcg', 'kenney', 'quaternius'] as AssetSourceProvider[]);
  const limit = Math.min(Math.max(1, options.limit ?? 10), 50);
  const results: AssetSourceResult[] = [];
  const errors: Record<string, string> = {};

  await Promise.all(providers.map(async (provider) => {
    try {
      if (provider === 'polyhaven') {
        const json = await fetchJson('https://api.polyhaven.com/assets');
        results.push(...normalizePolyHaven(json, query, limit));
      } else if (provider === 'ambientcg') {
        const url = `https://ambientcg.com/api/v2/full_json?q=${encodeURIComponent(query)}&limit=${limit}&include=displayData,imageData`;
        results.push(...normalizeAmbientCg(await fetchJson(url), limit));
      } else if (provider === 'kenney') {
        results.push(BROWSE_ONLY_SOURCES.kenney);
      } else if (provider === 'quaternius') {
        results.push(BROWSE_ONLY_SOURCES.quaternius);
      }
    } catch (error) {
      errors[provider] = error instanceof Error ? error.message : String(error);
    }
  }));

  return {
    query,
    providers,
    results,
    errors,
    hint: 'All results are CC0 (no attribution legally required). Pick a result with a downloadUrl and pass it to import_external_asset (which records provenance); browse-only sources need a manual download first.',
  };
}
