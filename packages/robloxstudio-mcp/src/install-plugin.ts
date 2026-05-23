import { createWriteStream, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { get } from 'https';
import { IncomingMessage } from 'http';

const REPO = 'chrrxs/robloxstudio-mcp';
const ASSET_NAME = 'MCPPlugin.rbxmx';
const TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

function getPluginsFolder(): string {
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Roblox', 'Plugins');
  }
  return join(homedir(), 'Documents', 'Roblox', 'Plugins');
}

function httpsGet(url: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = get(url, { headers: { 'User-Agent': 'robloxstudio-mcp' } }, resolve);
    req.on('error', reject);
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(new Error(`Request timed out after ${TIMEOUT_MS}ms`)); });
  });
}

async function download(url: string, dest: string, redirects = 0): Promise<void> {
  const res = await httpsGet(url);

  if (res.statusCode === 301 || res.statusCode === 302) {
    if (redirects >= MAX_REDIRECTS) throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
    const location = res.headers.location;
    if (!location) throw new Error('Redirect with no location header');
    return download(location, dest, redirects + 1);
  }

  if (res.statusCode !== 200) {
    throw new Error(`Download failed: HTTP ${res.statusCode}`);
  }

  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    const cleanup = (err: Error) => {
      file.close(() => {
        try { unlinkSync(dest); } catch { /* already gone */ }
        reject(err);
      });
    };
    res.pipe(file);
    file.on('finish', () => { file.close(); resolve(); });
    file.on('error', cleanup);
    res.on('error', cleanup);
  });
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await httpsGet(url);
  if (res.statusCode !== 200) {
    throw new Error(`GitHub API returned HTTP ${res.statusCode}`);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of res) {
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

async function findDevRelease(): Promise<{ tag_name: string; assets: { name: string; browser_download_url: string }[] }> {
  const releases = await fetchJson(`https://api.github.com/repos/${REPO}/releases?per_page=20`) as {
    tag_name: string;
    prerelease: boolean;
    assets: { name: string; browser_download_url: string }[];
  }[];
  const prerelease = releases.find(
    (r) => r.prerelease && r.assets.some((a) => a.name === ASSET_NAME),
  );
  if (!prerelease) {
    throw new Error(`No prerelease found with ${ASSET_NAME}`);
  }
  return prerelease;
}

export async function installPlugin(): Promise<void> {
  const dev = process.argv.includes('--dev');
  const pluginsFolder = getPluginsFolder();

  if (!existsSync(pluginsFolder)) {
    mkdirSync(pluginsFolder, { recursive: true });
  }

  console.log(dev ? 'Fetching latest dev prerelease...' : 'Fetching latest release...');
  const release = dev
    ? await findDevRelease()
    : await fetchJson(`https://api.github.com/repos/${REPO}/releases/latest`) as {
        tag_name: string;
        assets: { name: string; browser_download_url: string }[];
      };

  const asset = release.assets?.find((a) => a.name === ASSET_NAME);
  if (!asset) {
    throw new Error(`${ASSET_NAME} not found in release ${release.tag_name}`);
  }

  const dest = join(pluginsFolder, ASSET_NAME);
  console.log(`Downloading ${ASSET_NAME} from ${release.tag_name}...`);
  await download(asset.browser_download_url, dest);
  console.log(`Installed to ${dest}`);
}
