// Pollinations text-to-image client (gen.pollinations.ai). Generates images from
// a prompt with a server-side secret key (sk_…), read from POLLINATIONS_API_KEY
// so the key is NEVER hardcoded or committed. Pure buildImageUrl is unit-tested;
// generate() does the fetch. Default model seedream5; any model from
// https://enter.pollinations.ai/#models can be passed.

export interface ImageGenOptions {
  model?: string;
  width?: number;
  height?: number;
  seed?: number;
}

export const DEFAULT_IMAGE_MODEL = 'seedream5';
const DEFAULT_BASE_URL = 'https://gen.pollinations.ai';

function clampDimension(value: number | undefined, fallback: number): number {
  const n = Math.floor(value ?? fallback);
  return Math.max(16, Math.min(2048, n));
}

export class PollinationsClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { apiKey?: string; baseUrl?: string; fetchImpl?: typeof fetch } = {}) {
    this.apiKey = options.apiKey ?? process.env.POLLINATIONS_API_KEY ?? '';
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  hasApiKey(): boolean {
    return this.apiKey.length > 0;
  }

  buildImageUrl(prompt: string, options: ImageGenOptions = {}): string {
    const params = new URLSearchParams({
      model: options.model ?? DEFAULT_IMAGE_MODEL,
      width: String(clampDimension(options.width, 1024)),
      height: String(clampDimension(options.height, 1024)),
      seed: String(Math.floor(options.seed ?? 0)),
    });
    return `${this.baseUrl}/image/${encodeURIComponent(prompt)}?${params.toString()}`;
  }

  async generate(prompt: string, options: ImageGenOptions = {}): Promise<{ buffer: Buffer; contentType: string }> {
    if (!this.hasApiKey()) {
      throw new Error('Pollinations API key not configured. Set POLLINATIONS_API_KEY (a server-side sk_ key from https://enter.pollinations.ai).');
    }
    if (!prompt || !prompt.trim()) {
      throw new Error('A prompt is required for image generation.');
    }
    const url = this.buildImageUrl(prompt, options);
    const res = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'image/*' },
    });
    if (!res.ok) {
      throw new Error(`Image generation failed (HTTP ${res.status}). Check the model name and your Pollinations key/quota.`);
    }
    const contentType = res.headers.get('content-type') ?? 'image/jpeg';
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, contentType };
  }
}
