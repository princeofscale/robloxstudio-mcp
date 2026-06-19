import { MarketplaceClient, TOOLBOX_CATEGORIES } from '../marketplace-client.js';

describe('MarketplaceClient.buildSearchUrl', () => {
  const client = new MarketplaceClient();

  it('builds a toolbox search URL with an encoded keyword and limit', () => {
    const url = client.buildSearchUrl({ keyword: 'red car', limit: 5 });
    expect(url).toContain('/toolbox-service/v1/marketplace/');
    expect(url).toContain('keyword=red+car');
    expect(url).toContain('limit=5');
  });

  it('maps a friendly category name to its toolbox category id', () => {
    const url = client.buildSearchUrl({ keyword: 'sword', category: 'Model' });
    expect(url).toContain(`/marketplace/${TOOLBOX_CATEGORIES.Model}?`);
  });

  it('passes a raw numeric category through unchanged', () => {
    const url = client.buildSearchUrl({ keyword: 'sword', category: '13' });
    expect(url).toContain('/marketplace/13?');
  });

  it('clamps the limit into a sane range', () => {
    expect(client.buildSearchUrl({ keyword: 'a', limit: 999 })).toContain('limit=50');
    expect(client.buildSearchUrl({ keyword: 'a', limit: 0 })).toContain('limit=1');
  });
});

describe('MarketplaceClient.parseSearchResults', () => {
  const client = new MarketplaceClient();

  it('parses the flat toolbox shape (id/name/creatorName)', () => {
    const results = client.parseSearchResults({
      data: [
        { id: 123, name: 'Cool Car', creatorName: 'Builderman', assetTypeId: 10 },
        { id: 456, name: 'Fast Car', creatorName: 'Shedletsky' },
      ],
    });
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ id: 123, name: 'Cool Car', creatorName: 'Builderman' });
  });

  it('parses the nested shape (asset/creator objects)', () => {
    const results = client.parseSearchResults({
      data: [{ asset: { id: 789, name: 'Tree', assetTypeId: 10 }, creator: { name: 'Roblox' } }],
    });
    expect(results[0]).toMatchObject({ id: 789, name: 'Tree', creatorName: 'Roblox' });
  });

  it('skips entries without a usable id and returns [] for junk', () => {
    expect(client.parseSearchResults({ data: [{ name: 'no id' }] })).toEqual([]);
    expect(client.parseSearchResults({})).toEqual([]);
    expect(client.parseSearchResults(null)).toEqual([]);
  });

  it('always attaches a viewable thumbnail URL per result', () => {
    const results = client.parseSearchResults({ data: [{ id: 123, name: 'Cool Car' }] });
    expect(results[0].thumbnailUrl).toContain('123');
    expect(results[0].thumbnailUrl).toMatch(/^https?:\/\//);
  });
});

describe('MarketplaceClient.buildThumbnailUrl', () => {
  const client = new MarketplaceClient();
  it('builds a direct asset-thumbnail image URL for an id', () => {
    const url = client.buildThumbnailUrl(987);
    expect(url).toMatch(/^https?:\/\//);
    expect(url).toContain('987');
  });
});

describe('MarketplaceClient.buildDetailsUrl', () => {
  const client = new MarketplaceClient();
  it('builds an items/details URL with comma-joined asset ids', () => {
    const url = client.buildDetailsUrl([1, 2, 3]);
    expect(url).toContain('/items/details');
    expect(url).toContain('assetIds=1%2C2%2C3');
  });
});

describe('MarketplaceClient.parseDetails', () => {
  const client = new MarketplaceClient();

  it('maps id -> enriched fields (name, creator, votes, price, isFree)', () => {
    const map = client.parseDetails({
      data: [
        {
          asset: { id: 55, name: 'Oak Tree', assetTypeId: 10, description: 'A tree' },
          creator: { name: 'Roblox' },
          voting: { upVotes: 90, downVotes: 10 },
          product: { price: 0, isForSale: false },
        },
      ],
    });
    expect(map.get(55)).toMatchObject({
      name: 'Oak Tree',
      creatorName: 'Roblox',
      description: 'A tree',
      favoriteCount: 90,
      price: 0,
      isFree: true,
    });
  });

  it('treats a positive price as not free', () => {
    const map = client.parseDetails({ data: [{ asset: { id: 7 }, product: { price: 25 } }] });
    expect(map.get(7)).toMatchObject({ price: 25, isFree: false });
  });

  it('returns an empty map for junk', () => {
    expect(client.parseDetails(null).size).toBe(0);
    expect(client.parseDetails({}).size).toBe(0);
  });
});

describe('MarketplaceClient.rankByRelevanceAndPopularity', () => {
  const client = new MarketplaceClient();
  it('keeps name-matching results above popular-but-irrelevant ones', () => {
    const ranked = client.rankByRelevanceAndPopularity(
      [
        { id: 1, name: 'Random Rock', favoriteCount: 9999 },
        { id: 2, name: 'Low Poly Tree', favoriteCount: 5 },
      ],
      'tree',
    );
    expect(ranked[0].id).toBe(2);
  });

  it('breaks ties by popularity', () => {
    const ranked = client.rankByRelevanceAndPopularity(
      [
        { id: 1, name: 'Tree A', favoriteCount: 10 },
        { id: 2, name: 'Tree B', favoriteCount: 800 },
      ],
      'tree',
    );
    expect(ranked[0].id).toBe(2);
  });
});
