import { PollinationsClient, DEFAULT_IMAGE_MODEL } from '../image-client.js';

describe('PollinationsClient.buildImageUrl', () => {
  const client = new PollinationsClient({ apiKey: 'sk_test' });

  it('url-encodes the prompt into the /image path', () => {
    const url = client.buildImageUrl('a red cat');
    expect(url).toContain('gen.pollinations.ai/image/a%20red%20cat');
  });

  it('defaults to the configured model', () => {
    expect(DEFAULT_IMAGE_MODEL).toBe('zimage');
    expect(client.buildImageUrl('x')).toContain(`model=${DEFAULT_IMAGE_MODEL}`);
  });

  it('passes width, height, and seed', () => {
    const url = client.buildImageUrl('x', { width: 512, height: 768, seed: 42 });
    expect(url).toContain('width=512');
    expect(url).toContain('height=768');
    expect(url).toContain('seed=42');
  });

  it('lets a custom model through and clamps dimensions', () => {
    const url = client.buildImageUrl('x', { model: 'flux', width: 99999, height: 4 });
    expect(url).toContain('model=flux');
    expect(url).toContain('width=2048');
    expect(url).toContain('height=16');
  });
});

describe('PollinationsClient.hasApiKey', () => {
  it('is true when a key is provided and false otherwise', () => {
    expect(new PollinationsClient({ apiKey: 'sk_x' }).hasApiKey()).toBe(true);
    expect(new PollinationsClient({ apiKey: '' }).hasApiKey()).toBe(false);
  });
});

describe('PollinationsClient.generate', () => {
  it('sends the Bearer token and returns image bytes', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fakeFetch = (async (url: string, init: any) => {
      calls.push({ url, headers: init.headers });
      return {
        ok: true,
        headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? 'image/png' : null) },
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const client = new PollinationsClient({ apiKey: 'sk_secret', fetchImpl: fakeFetch });
    const result = await client.generate('a tree');
    expect(result.contentType).toBe('image/png');
    expect(result.buffer.length).toBe(3);
    expect(calls[0].headers.Authorization).toBe('Bearer sk_secret');
  });

  it('throws a clear error without a key', async () => {
    const client = new PollinationsClient({ apiKey: '' });
    await expect(client.generate('x')).rejects.toThrow(/POLLINATIONS_API_KEY/);
  });
});

describe('PollinationsClient.reviewImage', () => {
  it('posts an OpenAI-style vision message and returns the content', async () => {
    let captured: any;
    const fakeFetch = (async (url: string, init: any) => {
      captured = { url, init };
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'Scores: hierarchy=7' } }] }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const client = new PollinationsClient({ apiKey: 'sk_secret', fetchImpl: fakeFetch });
    const out = await client.reviewImage('BASE64DATA', 'image/jpeg', 'rate this');
    expect(out).toContain('hierarchy=7');
    expect(captured.url).toContain('/v1/chat/completions');
    const body = JSON.parse(captured.init.body);
    expect(body.messages[0].content[1].image_url.url).toBe('data:image/jpeg;base64,BASE64DATA');
    expect(captured.init.headers.Authorization).toBe('Bearer sk_secret');
  });

  it('throws when the model returns empty content', async () => {
    const fakeFetch = (async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '' } }] }) } as unknown as Response)) as unknown as typeof fetch;
    const client = new PollinationsClient({ apiKey: 'sk_x', fetchImpl: fakeFetch });
    await expect(client.reviewImage('d', 'image/png', 'p')).rejects.toThrow(/empty content/);
  });

  it('throws without a key', async () => {
    await expect(new PollinationsClient({ apiKey: '' }).reviewImage('d', 'image/png', 'p')).rejects.toThrow(/POLLINATIONS_API_KEY/);
  });
});
