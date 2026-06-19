// Free marketplace search — no Open Cloud key required. Hits Roblox's public
// toolbox-service marketplace endpoint (the same one Studio's Toolbox uses) so
// an agent can discover asset IDs and hand them to insert_asset. Open Cloud /
// Creator Store (search_assets) stays available for key holders; this is the
// zero-config path.
//
// Discovery is two-step, like Studio's Toolbox: marketplace/{category} returns
// matching asset ids; items/details enriches each with real name, creator,
// popularity (votes) and price. Every result also carries a viewable thumbnail
// URL so an AI agent can *see* candidates and pick the best fit. Pure helpers
// (buildSearchUrl, parseSearchResults, buildDetailsUrl, parseDetails,
// buildThumbnailUrl, rankByRelevanceAndPopularity) are unit tested; search()
// does the network with a CSRF retry and degrades gracefully if enrichment fails.

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
  /** Direct, viewable thumbnail image URL — lets an agent compare candidates. */
  thumbnailUrl?: string;
  /** Popularity signal (up-votes / favorites) used for ranking. */
  favoriteCount?: number;
  /** Price in Robux. 0 means free. */
  price?: number;
  isFree?: boolean;
  description?: string;
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
const THUMBNAIL_BASE = 'https://www.roblox.com/asset-thumbnail/image';

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

  /** A direct, viewable thumbnail image URL for an asset id (no API call needed). */
  buildThumbnailUrl(id: number): string {
    const query = new URLSearchParams({
      assetId: String(id),
      width: '420',
      height: '420',
      format: 'png',
    });
    return `${THUMBNAIL_BASE}?${query.toString()}`;
  }

  /** items/details URL for a batch of asset ids (real names, creator, votes, price). */
  buildDetailsUrl(ids: number[]): string {
    const query = new URLSearchParams({ assetIds: ids.join(',') });
    return `${this.baseUrl}/items/details?${query.toString()}`;
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
        thumbnailUrl: this.buildThumbnailUrl(id),
      });
    }
    return out;
  }

  /** Parse items/details into a map of id -> enriched fields to merge onto search hits. */
  parseDetails(json: unknown): Map<number, Partial<MarketplaceAsset>> {
    const map = new Map<number, Partial<MarketplaceAsset>>();
    const data = (json as { data?: unknown })?.data;
    if (!Array.isArray(data)) return map;
    for (const entry of data) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, any>;
      const asset = (e.asset && typeof e.asset === 'object') ? e.asset : e;
      const id = Number(asset.id ?? asset.assetId ?? e.assetId);
      if (!Number.isFinite(id) || id <= 0) continue;

      const creatorName = (e.creator && typeof e.creator === 'object' ? e.creator.name : undefined)
        ?? e.creatorName ?? asset.creatorName;
      const upVotes = e.voting && typeof e.voting === 'object' ? Number(e.voting.upVotes) : undefined;
      const product = (e.product && typeof e.product === 'object') ? e.product : undefined;
      const rawPrice = product?.price ?? asset.price ?? e.price;
      const price = Number.isFinite(Number(rawPrice)) ? Number(rawPrice) : undefined;

      const fields: Partial<MarketplaceAsset> = {};
      if (asset.name !== undefined) fields.name = String(asset.name);
      if (creatorName !== undefined) fields.creatorName = String(creatorName);
      if (asset.description !== undefined) fields.description = String(asset.description);
      if (Number.isFinite(Number(asset.assetTypeId))) fields.assetTypeId = Number(asset.assetTypeId);
      if (upVotes !== undefined && Number.isFinite(upVotes)) fields.favoriteCount = upVotes;
      if (price !== undefined) {
        fields.price = price;
        fields.isFree = price <= 0;
      }
      map.set(id, fields);
    }
    return map;
  }

  /**
   * Rank candidates so the best fit for `keyword` floats to the top: name-relevance
   * first (exact > word-match > substring), then popularity. Lets an AI agent (or
   * search-and-insert) pick the most appropriate model instead of the first hit.
   */
  rankByRelevanceAndPopularity(assets: MarketplaceAsset[], keyword: string): MarketplaceAsset[] {
    const kw = keyword.trim().toLowerCase();
    const words = kw.split(/\s+/).filter(Boolean);
    const relevance = (a: MarketplaceAsset): number => {
      const name = (a.name ?? '').toLowerCase();
      if (!kw) return 0;
      if (name === kw) return 3;
      if (words.length > 0 && words.every((w) => name.includes(w))) return 2;
      if (name.includes(kw)) return 1;
      return 0;
    };
    return [...assets].sort((a, b) => {
      const rel = relevance(b) - relevance(a);
      if (rel !== 0) return rel;
      return (b.favoriteCount ?? 0) - (a.favoriteCount ?? 0);
    });
  }

  /** Fetch items/details for the given assets and merge real metadata in place. */
  async enrich(assets: MarketplaceAsset[]): Promise<MarketplaceAsset[]> {
    if (assets.length === 0) return assets;
    try {
      const url = this.buildDetailsUrl(assets.map((a) => a.id));
      const headers: Record<string, string> = { Accept: 'application/json' };
      let res = await this.fetchImpl(url, { headers });
      if (res.status === 403 && res.headers.get('x-csrf-token')) {
        headers['x-csrf-token'] = res.headers.get('x-csrf-token') as string;
        res = await this.fetchImpl(url, { headers });
      }
      if (!res.ok) return assets; // degrade gracefully — keep ids + thumbnails
      const details = this.parseDetails(await res.json());
      return assets.map((a) => {
        const extra = details.get(a.id);
        return extra ? { ...a, ...extra } : a;
      });
    } catch {
      return assets;
    }
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
    const hits = this.parseSearchResults(await res.json());
    const enriched = await this.enrich(hits);
    return this.rankByRelevanceAndPopularity(enriched, params.keyword);
  }
}
