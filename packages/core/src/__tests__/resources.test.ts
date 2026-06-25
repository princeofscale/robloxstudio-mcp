import { parseResourceUri, RESOURCE_LIST, RESOURCE_TEMPLATES } from '../resources.js';
import { EpisodeStore } from '../tools/episode-store.js';

describe('parseResourceUri', () => {
  it('parses the world snapshot URI with a view', () => {
    expect(parseResourceUri('roblox://world/snapshot?view=standard')).toEqual({ kind: 'snapshot', view: 'standard' });
    expect(parseResourceUri('roblox://world/snapshot')).toEqual({ kind: 'snapshot', view: 'overview' });
  });

  it('parses the changefeed URI with/without since', () => {
    expect(parseResourceUri('roblox://world/changes?since=snap_42')).toEqual({ kind: 'changes', since: 'snap_42' });
    expect(parseResourceUri('roblox://world/changes')).toEqual({ kind: 'changes', since: undefined });
  });

  it('parses a node URI and decodes the dot-path', () => {
    expect(parseResourceUri('roblox://node/game.Workspace.Map')).toEqual({ kind: 'node', path: 'game.Workspace.Map' });
    expect(parseResourceUri('roblox://node/game.Workspace.My%20Model')).toEqual({ kind: 'node', path: 'game.Workspace.My Model' });
  });

  it('parses playtest episode + episode-list + repro URIs', () => {
    expect(parseResourceUri('roblox://playtest/episode/ep_abc')).toEqual({ kind: 'episode', id: 'ep_abc' });
    expect(parseResourceUri('roblox://playtest/episodes')).toEqual({ kind: 'episodes' });
    expect(parseResourceUri('roblox://repro/bundle')).toEqual({ kind: 'repro' });
  });

  it('parses asset provenance URIs (list + by assetId)', () => {
    expect(parseResourceUri('roblox://asset/provenance')).toEqual({ kind: 'provenance', assetId: undefined });
    expect(parseResourceUri('roblox://asset/provenance/12345')).toEqual({ kind: 'provenance', assetId: '12345' });
  });

  it('returns unknown for foreign or malformed URIs', () => {
    expect(parseResourceUri('https://example.com').kind).toBe('unknown');
    expect(parseResourceUri('roblox://nope/thing').kind).toBe('unknown');
    expect(parseResourceUri('not a uri').kind).toBe('unknown');
  });
});

describe('EpisodeStore', () => {
  it('stores, retrieves, and lists newest-first', () => {
    const store = new EpisodeStore();
    store.add({ episodeId: 'ep_1', createdAt: 1, verdict: 'fail', mode: 'play' });
    store.add({ episodeId: 'ep_2', createdAt: 2, verdict: 'pass', mode: 'play' });
    expect(store.get('ep_1')?.verdict).toBe('fail');
    expect(store.list().map((r) => r.episodeId)).toEqual(['ep_2', 'ep_1']);
  });

  it('caps the ring buffer and evicts oldest', () => {
    const store = new EpisodeStore(2);
    store.add({ episodeId: 'a', createdAt: 1 });
    store.add({ episodeId: 'b', createdAt: 2 });
    store.add({ episodeId: 'c', createdAt: 3 });
    expect(store.get('a')).toBeUndefined();
    expect(store.list().map((r) => r.episodeId)).toEqual(['c', 'b']);
  });

  it('notifies listeners on add and supports unsubscribe', () => {
    const store = new EpisodeStore();
    const seen: string[] = [];
    const remove = store.addListener((id) => seen.push(id));
    store.add({ episodeId: 'ep_x', createdAt: 1 });
    remove();
    store.add({ episodeId: 'ep_y', createdAt: 2 });
    expect(seen).toEqual(['ep_x']);
  });
});

describe('resource catalog', () => {
  it('lists concrete resources and parameterized templates', () => {
    expect(RESOURCE_LIST.every((r) => r.uri.startsWith('roblox://') && r.mimeType === 'application/json')).toBe(true);
    expect(RESOURCE_TEMPLATES.some((t) => t.uriTemplate.includes('{path}'))).toBe(true);
  });
});
