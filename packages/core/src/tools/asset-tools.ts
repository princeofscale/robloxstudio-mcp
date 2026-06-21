// Asset / build / marketplace / image-generation tools, split out of the
// RobloxStudioTools monolith: searching, inserting, uploading, and previewing
// assets, marketplace search + insert, rbxm import/export, build library CRUD,
// image generation (Pollinations), and the import-scene composite operation.
//
// The facade delegates here with identical public signatures so the schema-parity
// invariants hold (instance_id is always the last optional param).

import { runBuildExecutor } from './build-executor.js';
import { interpretInsertResponse } from '../assets.js';
import { toolErrorResult } from '../errors.js';
import type { ToolContent } from './runtime-support.js';
import type { OpenCloudClient } from '../opencloud-client.js';
import type { RobloxCookieClient } from '../roblox-cookie-client.js';
import type { MarketplaceClient } from '../marketplace-client.js';
import type { PollinationsClient, ImageGenOptions } from '../image-client.js';
import { DEFAULT_IMAGE_MODEL } from '../image-client.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type AssetToolRuntime = {
  callSingle(endpoint: string, data: unknown, target: string | undefined, instance_id: string | undefined): Promise<any>;
  runGeneratedLuau(code: string, instance_id?: string): Promise<{ content: ToolContent[] }>;
  recordOperation(kind: string, summary: string): void;
  openCloudClient: OpenCloudClient;
  cookieClient: RobloxCookieClient;
  marketplace: MarketplaceClient;
  imageClient: PollinationsClient;
};

export class AssetTools {
  constructor(private readonly runtime: AssetToolRuntime) {}

  // ─── Static helpers (library path) ────────────────────────────────

  private static findProjectRoot(startDir: string): string | null {
    let dir = path.resolve(startDir);
    let previous = '';
    while (dir !== previous) {
      if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, 'package.json'))) return dir;
      previous = dir;
      dir = path.dirname(dir);
    }
    return null;
  }

  private static isDirectory(candidate: string | null | undefined): candidate is string {
    if (!candidate) return false;
    try { return fs.statSync(candidate).isDirectory(); } catch { return false; }
  }

  private static ensureWritableDirectory(candidate: string, label: string): string {
    const resolved = path.resolve(candidate);
    try { fs.mkdirSync(resolved, { recursive: true }); } catch (error) {
      throw new Error(`Unable to create ${label} build-library directory at ${resolved}: ${(error as Error).message}`);
    }
    if (!AssetTools.isDirectory(resolved)) throw new Error(`${label} build-library path is not a directory: ${resolved}`);
    try { fs.accessSync(resolved, fs.constants.W_OK); } catch (error) {
      throw new Error(`${label} build-library directory is not writable: ${resolved}. ${(error as Error).message}`);
    }
    return resolved;
  }

  private static _cachedLibraryPath: string | undefined;

  private static findLibraryPath(): string {
    if (AssetTools._cachedLibraryPath) return AssetTools._cachedLibraryPath;

    const overridePath = process.env.ROBLOXSTUDIO_MCP_BUILD_LIBRARY || process.env.BUILD_LIBRARY_PATH;
    const cwd = path.resolve(process.cwd());
    const projectRoot = AssetTools.findProjectRoot(cwd);
    const homeLibraryPath = path.join(os.homedir(), '.robloxstudio-mcp', 'build-library');
    const projectLibraryPath = projectRoot ? path.join(projectRoot, 'build-library') : null;
    const cwdLibraryPath = path.join(cwd, 'build-library');

    let result: string;
    if (overridePath) {
      result = AssetTools.ensureWritableDirectory(overridePath, 'override');
    } else {
      const existing = [projectLibraryPath, cwdLibraryPath].find(
        c => c && AssetTools.isDirectory(c) && (() => { try { fs.accessSync(c, fs.constants.W_OK); return true; } catch { return false; } })()
      );
      if (existing) {
        result = path.resolve(existing);
      } else if (projectLibraryPath) {
        try { result = AssetTools.ensureWritableDirectory(projectLibraryPath, 'project-root'); }
        catch (err) {
          console.error(`Warning: could not create build-library at project root (${projectLibraryPath}): ${(err as Error).message}. Falling back to home directory.`);
          result = AssetTools.ensureWritableDirectory(homeLibraryPath, 'home');
        }
      } else {
        result = AssetTools.ensureWritableDirectory(homeLibraryPath, 'home');
      }
    }

    AssetTools._cachedLibraryPath = result;
    return result;
  }

  // ─── Normalize helpers ────────────────────────────────────────────

  private normalizePalette(palette: Record<string, unknown>): Record<string, [string, string]> {
    if (!palette || typeof palette !== 'object' || Array.isArray(palette)) {
      throw new Error('palette must be an object mapping keys to [BrickColor, Material] tuples');
    }
    const normalized: Record<string, [string, string]> = {};
    for (const [key, value] of Object.entries(palette)) {
      if (!Array.isArray(value) || value.length < 2) {
        throw new Error(`Palette key "${key}" must map to [BrickColor, Material]`);
      }
      normalized[key] = [String(value[0]), String(value[1])];
    }
    if (Object.keys(normalized).length === 0) {
      throw new Error('palette must contain at least one key');
    }
    return normalized;
  }

  private normalizeBuildParts(parts: unknown, paletteKeys: Set<string>): any[][] {
    if (!Array.isArray(parts) || parts.length === 0) {
      throw new Error('parts must be a non-empty array');
    }

    const ALLOWED_SHAPES = new Set(['Block', 'Wedge', 'Cylinder', 'Ball', 'CornerWedge']);
    const normalized: any[][] = [];

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];

      if (Array.isArray(part)) {
        if (part.length < 10) {
          throw new Error(`Part ${i} must have at least 10 elements`);
        }
        const [px, py, pz, sx, sy, sz, rx, ry, rz, paletteKey, ...rest] = part;
        if (typeof paletteKey !== 'string' || !paletteKeys.has(paletteKey)) {
          throw new Error(`Part ${i} references unknown palette key "${paletteKey}"`);
        }
        const tuple: any[] = [px, py, pz, sx, sy, sz, rx, ry, rz, paletteKey];
        if (rest[0] !== undefined) {
          if (!ALLOWED_SHAPES.has(rest[0])) throw new Error(`Part ${i} has invalid shape "${rest[0]}"`);
          tuple.push(rest[0]);
        }
        if (rest[1] !== undefined) {
          if (!rest[0]) tuple.push('Block');
          tuple.push(rest[1]);
        }
        normalized.push(tuple);
        continue;
      }

      if (!part || typeof part !== 'object') {
        throw new Error(`Part ${i} must be an array or object`);
      }

      const r = part as Record<string, unknown>;
      const position = r.position as number[];
      const size = r.size as number[];
      const rotation = r.rotation as number[];
      const pk = r.paletteKey as string;

      if (!Array.isArray(position) || position.length !== 3) throw new Error(`Part ${i}: position must be [x,y,z]`);
      if (!Array.isArray(size) || size.length !== 3) throw new Error(`Part ${i}: size must be [x,y,z]`);
      if (!Array.isArray(rotation) || rotation.length !== 3) throw new Error(`Part ${i}: rotation must be [x,y,z]`);
      if (typeof pk !== 'string' || !paletteKeys.has(pk)) throw new Error(`Part ${i} references unknown palette key "${pk}"`);

      const tuple: any[] = [...position, ...size, ...rotation, pk];
      if (r.shape !== undefined) {
        if (!ALLOWED_SHAPES.has(r.shape as string)) throw new Error(`Part ${i} has invalid shape "${r.shape}"`);
        tuple.push(r.shape);
      }
      if (r.transparency !== undefined) {
        if (!r.shape) tuple.push('Block');
        tuple.push(r.transparency);
      }
      normalized.push(tuple);
    }

    return normalized;
  }

  private computeBounds(parts: any[][]): [number, number, number] {
    let maxX = 0, maxY = 0, maxZ = 0;
    for (const p of parts) {
      const px = Math.abs(p[0]) + p[3] / 2;
      const py = Math.abs(p[1]) + p[4] / 2;
      const pz = Math.abs(p[2]) + p[5] / 2;
      maxX = Math.max(maxX, px);
      maxY = Math.max(maxY, py);
      maxZ = Math.max(maxZ, pz);
    }
    return [
      Math.round(maxX * 2 * 10) / 10,
      Math.round(maxY * 2 * 10) / 10,
      Math.round(maxZ * 2 * 10) / 10,
    ];
  }

  // ─── Build library CRUD ──────────────────────────────────────────

  async exportBuild(instancePath: string, outputId?: string, style: string = 'misc', instance_id?: string) {
    if (!instancePath) throw new Error('Instance path is required for export_build');
    const response = await this.runtime.callSingle('/api/export-build', {
      instancePath, outputId, style,
    }, undefined, instance_id) as any;

    if (response && response.success && response.buildData) {
      const buildData = response.buildData;
      const buildId = buildData.id || `${style}/exported`;
      const filePath = path.join(AssetTools.findLibraryPath(), `${buildId}.json`);
      const dirPath = path.dirname(filePath);
      if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(buildData, null, 2));
      response.savedTo = filePath;
    }

    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }

  async createBuild(
    id: string, style: string, palette: Record<string, any>, parts: unknown, bounds?: [number, number, number],
  ) {
    if (!id) throw new Error('id is required for create_build');
    const normalizedPalette = this.normalizePalette(palette);
    const normalizedParts = this.normalizeBuildParts(parts, new Set(Object.keys(normalizedPalette)));
    const computedBounds = bounds || this.computeBounds(normalizedParts);
    const buildData = { id, style, bounds: computedBounds, palette: normalizedPalette, parts: normalizedParts };

    const filePath = path.join(AssetTools.findLibraryPath(), `${id}.json`);
    const dirPath = path.dirname(filePath);
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(buildData, null, 2));

    return {
      content: [{ type: 'text', text: JSON.stringify({
        success: true, id, style, bounds: computedBounds,
        partCount: normalizedParts.length,
        paletteKeys: Object.keys(normalizedPalette),
        savedTo: filePath,
      }) }],
    };
  }

  async generateBuild(id: string, style: string, palette: Record<string, [string, string]>, code: string, seed?: number) {
    if (!id || !palette || !code) throw new Error('id, palette, and code are required for generate_build');
    for (const [key, value] of Object.entries(palette)) {
      if (!Array.isArray(value) || value.length < 2 || value.length > 3) {
        throw new Error(`Palette key "${key}" must map to [BrickColor, Material] or [BrickColor, Material, MaterialVariant]`);
      }
    }
    const result = runBuildExecutor(code, palette, seed);
    const buildData: Record<string, any> = { id, style, bounds: result.bounds, palette, parts: result.parts, generatorCode: code };
    if (seed !== undefined) buildData.generatorSeed = seed;

    const filePath = path.join(AssetTools.findLibraryPath(), `${id}.json`);
    const dirPath = path.dirname(filePath);
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(buildData, null, 2));

    return {
      content: [{ type: 'text', text: JSON.stringify({
        success: true, id, style, bounds: result.bounds,
        partCount: result.partCount, savedTo: filePath,
      }) }],
    };
  }

  async importBuild(buildData: Record<string, any> | string, targetPath: string, position?: [number, number, number], instance_id?: string) {
    if (typeof buildData === 'string') {
      const filePath = path.join(AssetTools.findLibraryPath(), `${buildData}.json`);
      if (!fs.existsSync(filePath)) {
        return toolErrorResult(`Build not found in library: ${buildData}`);
      }
      buildData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
    const response = await this.runtime.callSingle('/api/import-build', {
      buildData, targetPath, position,
    }, undefined, instance_id);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }

  async listLibrary(style?: string) {
    const libPath = AssetTools.findLibraryPath();
    let entries: Array<{ id: string; style: string; bounds?: number[]; partCount?: number }> = [];

    if (fs.existsSync(libPath)) {
      const readDir = (dir: string, parentStyle: string = '') => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            readDir(path.join(dir, entry.name), entry.name);
          } else if (entry.name.endsWith('.json')) {
            try {
              const data = JSON.parse(fs.readFileSync(path.join(dir, entry.name), 'utf-8'));
              if (style && data.style !== style) continue;
              entries.push({
                id: data.id,
                style: data.style,
                bounds: data.bounds,
                partCount: data.parts?.length,
              });
            } catch { /* skip corrupt files */ }
          }
        }
      };
      readDir(libPath);
    }

    if (style) entries = entries.filter(e => e.style === style);
    return { content: [{ type: 'text', text: JSON.stringify({ count: entries.length, entries }) }] };
  }

  async searchMaterials(query?: string, maxResults?: number, instance_id?: string) {
    const response = await this.runtime.callSingle('/api/search-materials', { query, maxResults }, undefined, instance_id);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }

  async getBuild(id: string) {
    const filePath = path.join(AssetTools.findLibraryPath(), `${id}.json`);
    if (!fs.existsSync(filePath)) return toolErrorResult(`Build not found in library: ${id}`);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return { content: [{ type: 'text', text: JSON.stringify(data) }] };
  }

  async importScene(sceneData: Record<string, any>, targetPath?: string, instance_id?: string) {
    if (!sceneData || typeof sceneData !== 'object') throw new Error('sceneData is required for import_scene');
    const customBuilds: Array<{ name: string; palette: Record<string, any>; parts: any[]; position: number[] }> = [];

    if (Array.isArray(sceneData.custom)) {
      for (const custom of sceneData.custom) {
        if (!custom.name) throw new Error('Each custom build must have a name');
        if (!custom.palette) throw new Error(`Custom build "${custom.name}" must have a palette`);
        if (!Array.isArray(custom.parts)) throw new Error(`Custom build "${custom.name}" must have a parts array`);
        customBuilds.push({
          name: custom.name,
          palette: custom.palette,
          parts: custom.parts,
          position: Array.isArray(custom.position) ? custom.position : custom.o ?? [0, 0, 0],
        });
      }
    }

    // Inline custom builds are imported directly rather than going through the
    // build library, since they are ephemeral scene-specific assemblies that
    // shouldn't pollute the shared library namespace.
    for (const cb of customBuilds) {
      const palette = this.normalizePalette(cb.palette);
      const parts = this.normalizeBuildParts(cb.parts, new Set(Object.keys(palette)));
      const buildData = { id: `_scene_${cb.name}`, style: 'custom', bounds: this.computeBounds(parts), palette, parts };
      await this.runtime.callSingle('/api/import-build', {
        buildData, targetPath: targetPath || 'Workspace', position: cb.position,
      }, undefined, instance_id);
    }

    // Resolve library model references.
    const models = sceneData.models as Record<string, string> | undefined;
    const place = sceneData.place as Array<{ modelKey: string; position: number[]; rotation?: number[] }> | undefined;

    if (models && place) {
      for (const entry of place) {
        const e = entry as any;
        const modelKey = e.modelKey || e[0];
        const pos = e.position || (Array.isArray(e[1]) ? e[1] : [0, 0, 0]);
        const rot = e.rotation || undefined;
        const buildId = models[modelKey];
        if (!buildId) throw new Error(`Unknown model key "${modelKey}" in scene placement`);
        const filePath = path.join(AssetTools.findLibraryPath(), `${buildId}.json`);
        if (!fs.existsSync(filePath)) throw new Error(`Build "${buildId}" not found in library`);
        const buildData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        await this.runtime.callSingle('/api/import-build', {
          buildData, targetPath: targetPath || 'Workspace', position: pos, rotation: rot,
        }, undefined, instance_id);
      }
    }

    return { content: [{ type: 'text', text: JSON.stringify({ success: true, customCount: customBuilds.length, placedCount: place?.length ?? 0 }) }] };
  }

  // ─── Marketplace ─────────────────────────────────────────────────

  async marketplaceSearch(keyword: string, category?: string, limit?: number, sortType?: string) {
    if (!keyword || !keyword.trim()) throw new Error('keyword is required for marketplace_search');
    try {
      const results = await this.runtime.marketplace.search({ keyword, category, limit, sortType });
      return {
        content: [{ type: 'text', text: JSON.stringify({
          keyword, category: category ?? 'Model', count: results.length, results,
          hint: results.length > 0
            ? 'Insert one with insert_asset (assetId) or marketplace_search_and_insert.'
            : 'No results — try a different keyword or category.',
        }) }],
      };
    } catch (error) {
      return toolErrorResult(error);
    }
  }

  async marketplaceSearchAndInsert(
    keyword: string, category?: string, parentPath?: string,
    position?: { x: number; y: number; z: number }, instance_id?: string,
  ) {
    if (!keyword || !keyword.trim()) throw new Error('keyword is required for marketplace_search_and_insert');
    let results;
    try {
      results = await this.runtime.marketplace.search({ keyword, category, limit: 5 });
    } catch (error) {
      return toolErrorResult(error);
    }
    if (results.length === 0) {
      return { content: [{ type: 'text', text: JSON.stringify({ inserted: false, reason: `No marketplace results for "${keyword}".` }) }] };
    }
    const attempts: Array<{ id: number; name: string; code?: string }> = [];
    for (const chosen of results) {
      const response = await this.runtime.callSingle('/api/insert-asset', {
        assetId: chosen.id, parentPath: parentPath || 'Workspace', position,
      }, undefined, instance_id) as { error?: string; data?: unknown; returnValue?: string };
      if (response.error) {
        attempts.push({ id: chosen.id, name: chosen.name, code: response.error });
        continue;
      }
      this.runtime.recordOperation('asset_insert', `inserted asset ${chosen.id} (${chosen.name})`);
      return { content: [{ type: 'text', text: JSON.stringify({
        inserted: true, assetId: chosen.id, name: chosen.name, response,
        attemptCount: attempts.length + 1, totalCandidates: results.length,
      }) }] };
    }
    // All candidates failed
    return { content: [{ type: 'text', text: JSON.stringify({
      inserted: false, attempts, totalCandidates: results.length,
      hint: 'All candidates failed to insert. Try a different keyword or check asset_preflight_insert for details.',
    }) }] };
  }

  // ─── OpenCloud asset tools ────────────────────────────────────────

  async searchAssets(assetType: string, query?: string, maxResults?: number, sortBy?: string, verifiedCreatorsOnly?: boolean) {
    const oc = this.runtime.openCloudClient;
    if (!oc.hasApiKey()) {
      return toolErrorResult('ROBLOX_OPEN_CLOUD_API_KEY environment variable is not set. Set it to use Creator Store asset tools.');
    }
    const response = await oc.searchAssets({
      searchCategoryType: assetType as any, query, maxPageSize: maxResults,
      sortCategory: sortBy as any, includeOnlyVerifiedCreators: verifiedCreatorsOnly,
    });
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }

  async getAssetDetails(assetId: number) {
    if (!assetId) throw new Error('Asset ID is required for get_asset_details');
    const oc = this.runtime.openCloudClient;
    const cc = this.runtime.cookieClient;

    if (cc.hasCookie() && !oc.hasApiKey()) {
      const results = await cc.getAssetDetails([assetId]);
      const asset = results[0];
      if (!asset) return toolErrorResult('Asset not found or not owned by authenticated user');
      const raw = asset as Record<string, unknown>;
      return { content: [{ type: 'text', text: JSON.stringify({
        assetId: raw.AssetId ?? raw.assetId ?? assetId,
        name: raw.Name ?? raw.name,
        description: raw.Description ?? raw.description,
        creatorName: raw.CreatorName ?? raw.creatorName,
        creatorId: raw.CreatorId ?? raw.creatorId,
        priceInRobux: raw.PriceInRobux ?? raw.priceInRobux,
        isCopyLocked: raw.IsCopyLocked ?? raw.isCopyLocked,
        isPublicDomain: raw.IsPublicDomain ?? raw.isPublicDomain,
        assetTypeId: raw.AssetTypeId ?? raw.assetTypeId,
        created: raw.Created ?? raw.created,
        updated: raw.Updated ?? raw.updated,
        raw, hint: 'Copy-locked and public-domain status from this endpoint is authoritative. Use asset_preflight_insert for a definitive insertability check.',
      }) }] };
    }

    if (!oc.hasApiKey()) return toolErrorResult('No auth configured. Set ROBLOSECURITY or ROBLOX_OPEN_CLOUD_API_KEY env var.');

    const response = await oc.getAssetDetails(assetId);
    return { content: [{ type: 'text', text: JSON.stringify({
      assetId: response.asset?.id ?? assetId,
      name: response.asset?.name,
      description: response.asset?.description,
      creatorName: response.creator?.name,
      creatorId: response.creator?.userId ?? response.creator?.groupId,
      creatorVerified: response.creator?.verified,
      creatorType: response.creator?.userId ? 'user' : response.creator?.groupId ? 'group' : undefined,
      assetTypeId: response.asset?.assetTypeId,
      created: response.asset?.createTime,
      updated: response.asset?.updateTime,
      upVotes: response.voting?.upVotes,
      downVotes: response.voting?.downVotes,
      voteCount: response.voting?.voteCount,
      upVotePercent: response.voting?.upVotePercent,
      purchasable: response.creatorStoreProduct?.purchasable,
      price: response.creatorStoreProduct?.purchasePrice
        ? `${(response.creatorStoreProduct.purchasePrice.quantity.significand * 10 ** -response.creatorStoreProduct.purchasePrice.quantity.exponent)} ${response.creatorStoreProduct.purchasePrice.currencyCode}`
        : undefined,
      hint: 'Use marketplace_search + asset_preflight_insert for authoritative insertability (copy-lock/public-domain status).',
    }) }] };
  }

  async getAssetThumbnail(assetId: number, size?: string) {
    if (!assetId) throw new Error('Asset ID is required for get_asset_thumbnail');
    const oc = this.runtime.openCloudClient;
    if (!oc.hasApiKey()) return toolErrorResult('Set ROBLOX_OPEN_CLOUD_API_KEY env var for asset thumbnails.');
    const thumbnail = await oc.getAssetThumbnail(assetId, size as '150x150' | '420x420' | '768x432' | undefined);
    return { content: [{ type: 'text', text: JSON.stringify(thumbnail) }] };
  }

  // ─── Insert / preview ────────────────────────────────────────────

  async insertAsset(assetId: number, parentPath?: string, position?: { x: number; y: number; z: number }, instance_id?: string) {
    if (!assetId) throw new Error('Asset ID is required for insert_asset');
    const response = await this.runtime.callSingle('/api/insert-asset', {
      assetId, parentPath, position,
    }, undefined, instance_id) as Record<string, unknown>;
    return interpretInsertResponse(response);
  }

  async previewAsset(assetId: number, includeProperties: boolean = true, maxDepth: number = 10, instance_id?: string) {
    if (!assetId) throw new Error('Asset ID is required for preview_asset');
    const response = await this.runtime.callSingle('/api/preview-asset', {
      assetId, includeProperties, maxDepth,
    }, undefined, instance_id);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }

  async uploadAsset(filePath: string, assetType: string, displayName: string, description?: string, userId?: string, groupId?: string) {
    if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
    const fileContent = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    const cc = this.runtime.cookieClient;
    const oc = this.runtime.openCloudClient;

    // Cookie auth: Decal-only path.
    if (assetType === 'Decal' && cc.hasCookie()) {
      const result = await cc.uploadDecal(fileContent, displayName, description || '');
      return {
        content: [{ type: 'text', text: JSON.stringify({
          done: true,
          response: { assetId: String(result.assetId), displayName, assetType, decalId: String(result.assetId), imageId: String(result.backingAssetId) },
        }) }],
      };
    }

    if (!oc.hasApiKey()) {
      const cookieHint = assetType === 'Decal' ? ' Alternatively, set ROBLOSECURITY to use cookie auth.' : '';
      throw new Error(`No auth configured for ${assetType} upload. Set ROBLOX_OPEN_CLOUD_API_KEY (needs asset:write scope).${cookieHint}`);
    }

    const resolvedGroupId = groupId || process.env.ROBLOX_CREATOR_GROUP_ID;
    const resolvedUserId = userId || process.env.ROBLOX_CREATOR_USER_ID;
    if (!resolvedUserId && !resolvedGroupId) {
      throw new Error('Creator identity required. Set ROBLOX_CREATOR_USER_ID or ROBLOX_CREATOR_GROUP_ID, or pass userId/groupId.');
    }

    const creator: { userId?: string; groupId?: string } = {};
    if (resolvedGroupId) creator.groupId = resolvedGroupId;
    else creator.userId = resolvedUserId;

    const result = await oc.createAsset(
      { assetType: assetType as 'Audio' | 'Decal' | 'Model' | 'Animation' | 'Video', displayName, description: description || '', creationContext: { creator } },
      fileContent, fileName,
    );

    if (assetType === 'Decal') {
      const decalId = result.response?.assetId;
      const imageId = decalId ? await this.resolveImageId(decalId) : null;
      return { content: [{ type: 'text', text: JSON.stringify({ ...result, decalId: decalId ?? null, imageId }) }] };
    }

    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }

  // ─── Rbxm import / export ────────────────────────────────────────

  async exportRbxm(instancePaths: string[], outputPath: string, target?: string, instance_id?: string) {
    if (!Array.isArray(instancePaths) || instancePaths.length === 0) throw new Error('instance_paths must be a non-empty array for export_rbxm');
    if (!outputPath || typeof outputPath !== 'string') throw new Error('output_path is required for export_rbxm');
    const tgt = target || 'edit';
    if (tgt !== 'edit' && tgt !== 'server') throw new Error(`export_rbxm target must be "edit" or "server" (got: ${tgt})`);

    const response = await this.runtime.callSingle('/api/export-rbxm', { instance_paths: instancePaths }, tgt, instance_id) as { error?: string; base64?: string; instance_count?: number };
    if (response.error) return toolErrorResult(response.error);
    if (!response.base64) return toolErrorResult('plugin returned no base64 payload');

    const bytes = Buffer.from(response.base64, 'base64');
    const resolved = path.resolve(outputPath);
    try {
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, bytes);
    } catch (err) {
      return toolErrorResult(`failed to write ${resolved}: ${(err as Error).message}`);
    }

    return { content: [{ type: 'text', text: JSON.stringify({
      bytes_written: bytes.length, instance_count: response.instance_count ?? instancePaths.length, output_path: resolved,
    }) }] };
  }

  async importRbxm(source: { path?: string; url?: string; base64?: string } | undefined, parentPath: string, target?: string, instance_id?: string) {
    if (!source || typeof source !== 'object') throw new Error('source is required for import_rbxm');
    if (!parentPath || typeof parentPath !== 'string') throw new Error('parent_path is required for import_rbxm');
    const tgt = target || 'edit';
    if (tgt !== 'edit' && tgt !== 'server') throw new Error(`import_rbxm target must be "edit" or "server" (got: ${tgt})`);

    const modes = ['path', 'url', 'base64'].filter((k) => (source as Record<string, unknown>)[k] !== undefined);
    if (modes.length !== 1) throw new Error(`source must contain exactly one of { path, url, base64 } (got: ${modes.join(', ') || 'none'})`);

    let bytes: Buffer;
    let sourceLabel: string;
    if (source.path !== undefined) {
      const resolved = path.resolve(source.path);
      try { bytes = fs.readFileSync(resolved); }
      catch (err) { return toolErrorResult(`failed to read ${resolved}: ${(err as Error).message}`); }
      sourceLabel = resolved;
    } else if (source.url !== undefined) {
      let parsedUrl: URL;
      try { parsedUrl = new URL(source.url); }
      catch { return toolErrorResult(`import_rbxm url is not a valid URL: ${source.url}`); }
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return toolErrorResult(`import_rbxm url must use http(s); got ${parsedUrl.protocol}`);

      const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
      try {
        const res = await fetch(source.url);
        if (!res.ok) { const snippet = (await res.text()).slice(0, 500); return toolErrorResult(`fetch ${source.url} returned ${res.status}: ${snippet}`); }
        const claimed = Number(res.headers.get('content-length') ?? '0');
        if (claimed > MAX_IMPORT_BYTES) return toolErrorResult(`fetch ${source.url}: content-length ${claimed} exceeds ${MAX_IMPORT_BYTES} byte cap`);
        const arr = await res.arrayBuffer();
        if (arr.byteLength > MAX_IMPORT_BYTES) return toolErrorResult(`fetch ${source.url}: downloaded ${arr.byteLength} bytes exceeds ${MAX_IMPORT_BYTES} byte cap`);
        bytes = Buffer.from(arr);
      } catch (err) { return toolErrorResult(`fetch ${source.url} failed: ${(err as Error).message}`); }
      sourceLabel = source.url;
    } else {
      try { bytes = Buffer.from(source.base64 as string, 'base64'); }
      catch (err) { return toolErrorResult(`base64 decode failed: ${(err as Error).message}`); }
      sourceLabel = `base64(${bytes.length}B)`;
    }

    const response = await this.runtime.callSingle('/api/import-rbxm', {
      base64: bytes.toString('base64'), parent_path: parentPath, source_label: sourceLabel,
    }, tgt, instance_id);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }

  // ─── Image generation (Pollinations) ─────────────────────────────

  private async _generateImageToFile(prompt: string, options?: ImageGenOptions): Promise<{ file: string; bytes: number; model: string }> {
    const { buffer, contentType } = await this.runtime.imageClient.generate(prompt, options ?? {});
    const ext = contentType.includes('png') ? 'png' : 'jpg';
    const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'image';
    const dir = path.resolve(process.env.ROBLOX_IMAGE_DIR ?? path.join(process.cwd(), 'generated-images'));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${slug}-${Date.now()}.${ext}`);
    fs.writeFileSync(file, buffer);
    return { file, bytes: buffer.length, model: options?.model ?? DEFAULT_IMAGE_MODEL };
  }

  async imageGenerate(prompt: string, options?: ImageGenOptions) {
    if (!prompt || !prompt.trim()) throw new Error('prompt is required for image_generate');
    if (!this.runtime.imageClient.hasApiKey()) {
      return toolErrorResult('POLLINATIONS_API_KEY is not set. Get a server-side sk_ key from https://enter.pollinations.ai and pass it via env or --pollinations-key.');
    }
    try {
      const saved = await this._generateImageToFile(prompt, options);
      this.runtime.recordOperation('image_generate', `generated "${prompt}" → ${saved.file}`);
      return { content: [{ type: 'text', text: JSON.stringify({ prompt, ...saved, next: 'Upload with image_generate_and_upload or upload_asset, then asset_apply_texture.' }) }] };
    } catch (error) {
      return toolErrorResult(error);
    }
  }

  async imageGenerateAndUpload(prompt: string, options?: ImageGenOptions, assetType?: string, displayName?: string) {
    if (!prompt || !prompt.trim()) throw new Error('prompt is required for image_generate_and_upload');
    if (!this.runtime.imageClient.hasApiKey()) return toolErrorResult('POLLINATIONS_API_KEY is not set. Get a server-side sk_ key from https://enter.pollinations.ai.');

    let saved;
    try { saved = await this._generateImageToFile(prompt, options); }
    catch (error) { return toolErrorResult(error); }

    try {
      const upload = await this.uploadAsset(saved.file, assetType ?? 'Decal', displayName ?? prompt.slice(0, 50));
      this.runtime.recordOperation('image_generate', `generated + uploaded "${prompt}"`);
      const uploadText = (upload.content.find((c) => c.type === 'text') as { text?: string } | undefined)?.text ?? '{}';
      return { content: [{ type: 'text', text: JSON.stringify({ generated: saved, upload: JSON.parse(uploadText), next: 'Apply the returned assetId with asset_apply_texture.' }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: JSON.stringify({ generated: saved, uploadError: (error as Error).message, hint: 'Image saved locally; set ROBLOX_OPEN_CLOUD_API_KEY (asset:write) or ROBLOSECURITY to upload, or upload the file manually in Studio.' }) }] };
    }
  }

  // ─── Resolve decal image ID ──────────────────────────────────────

  private async resolveImageId(decalAssetId: string): Promise<string | null> {
    const code = `
      local InsertService = game:GetService("InsertService")
      local ok, result = pcall(function()
        local model = InsertService:LoadAsset(${decalAssetId})
        if model then
          local decal = model:FindFirstChildWhichIsA("Decal")
          if decal and decal.Texture then
            return decal.Texture
          end
        end
        return nil
      end)
      if ok and result then
        return { imageId = tostring(result) }
      end
      return { imageId = nil }
    `;
    try {
      const luauResult = await this.runtime.runGeneratedLuau(code);
      const text = luauResult.content?.[0] && 'text' in luauResult.content[0] ? luauResult.content[0].text : null;
      if (text) {
        const parsed = JSON.parse(text);
        return parsed?.returnValue?.imageId ?? null;
      }
      return null;
    } catch {
      return null;
    }
  }
}
