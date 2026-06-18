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
});
