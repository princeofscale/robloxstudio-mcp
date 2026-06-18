// Free marketplace search — no Open Cloud key required. Hits Roblox's public
// toolbox-service marketplace endpoint (the same one Studio's Toolbox uses) so
// an agent can discover asset IDs and hand them to insert_asset. Open Cloud /
// Creator Store (search_assets) stays available for key holders; this is the
// zero-config path. Pure helpers (buildSearchUrl, parseSearchResults) are unit
// tested; search() does the fetch with a CSRF retry and clear errors.

export interface MarketplaceSearchParams {
  keyword: string;
  /** Friendly name (Model, Decal, Audio, …) or a raw toolbox category id. */
  category?: string;
  limit?: number;
  sortType?: string;
}

export interface MarketplaceAsset {
  id: number;
  name: string;
  creatorName?: string;
  assetTypeId?: number;
}

// Toolbox marketplace category ids. Friendly names map to the ids the toolbox
// endpoint expects; unknown values are passed through so callers can use any id.
export const TOOLBOX_CATEGORIES: Record<string, string> = {
  Model: '10',
  Decal: '13',
  Audio: '3',
  Mesh: '40',
  MeshPart: '40',
  Plugin: '38',
  Video: '62',
  Image: '13',
};

const DEFAULT_BASE_URL = 'https://apis.roblox.com/toolbox-service/v1';

export class MarketplaceClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { baseUrl?: string; fetchImpl?: typeof fetch } = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private resolveCategory(category?: string): string {
    if (!category) return TOOLBOX_CATEGORIES.Model;
    return TOOLBOX_CATEGORIES[category] ?? category;
  }

  buildSearchUrl(params: MarketplaceSearchParams): string {
    const category = this.resolveCategory(params.category);
    const limit = Math.max(1, Math.min(50, Math.floor(params.limit ?? 10)));
    const query = new URLSearchParams({
      keyword: params.keyword,
      limit: String(limit),
      sortType: params.sortType ?? 'Relevance',
    });
    return `${this.baseUrl}/marketplace/${category}?${query.toString()}`;
  }

  parseSearchResults(json: unknown): MarketplaceAsset[] {
    const data = (json as { data?: unknown })?.data;
    if (!Array.isArray(data)) return [];
    const out: MarketplaceAsset[] = [];
    for (const entry of data) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, any>;
      const asset = (e.asset && typeof e.asset === 'object') ? e.asset : e;
      const id = Number(asset.id ?? asset.assetId ?? e.assetId);
      if (!Number.isFinite(id) || id <= 0) continue;
      const creatorName = e.creatorName
        ?? (e.creator && typeof e.creator === 'object' ? e.creator.name : undefined)
        ?? asset.creatorName;
      out.push({
        id,
        name: String(asset.name ?? e.name ?? `Asset ${id}`),
        creatorName: creatorName ? String(creatorName) : undefined,
        assetTypeId: Number.isFinite(Number(asset.assetTypeId)) ? Number(asset.assetTypeId) : undefined,
      });
    }
    return out;
  }

  async search(params: MarketplaceSearchParams): Promise<MarketplaceAsset[]> {
    if (!params.keyword || !params.keyword.trim()) {
      throw new Error('A keyword is required for marketplace search.');
    }
    const url = this.buildSearchUrl(params);
    const headers: Record<string, string> = { Accept: 'application/json' };

    let res = await this.fetchImpl(url, { headers });
    // Roblox endpoints sometimes reject the first call with 403 + an
    // x-csrf-token to echo on the retry.
    if (res.status === 403 && res.headers.get('x-csrf-token')) {
      headers['x-csrf-token'] = res.headers.get('x-csrf-token') as string;
      res = await this.fetchImpl(url, { headers });
    }
    if (!res.ok) {
      throw new Error(`Marketplace search failed (HTTP ${res.status}). Roblox's public toolbox may be rate-limited; retry shortly.`);
    }
    return this.parseSearchResults(await res.json());
  }
}
