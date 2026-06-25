import { StudioHttpClient } from './studio-client.js';
import { BridgeService, RoutingFailure } from '../bridge-service.js';
import { SafetyManager, OperationKind } from '../safety/safety-manager.js';
import type { ScreenGuiOptions, GuiObjectOptions, LayoutOptions } from '../builders/ui-builders.js';
import type { AtmospherePreset, SkyOptions, DayNightCycleOptions } from '../builders/environment-builders.js';
import type { BaseplateOptions, IslandOptions, MountainsOptions, WaterOptions, PaintMaterialOptions, ClearRegionOptions } from '../builders/terrain-builders.js';
import type { ObbyTemplateOptions, SimulatorTemplateOptions, TycoonTemplateOptions, RoundTemplateOptions } from '../builders/template-builders.js';
import { SyncManager } from '../sync/sync-manager.js';
import { MarketplaceClient } from '../marketplace-client.js';
import { interpretInsertResponse } from '../assets.js';
import { typedError } from '../errors.js';
import { type TelemetryDomain } from '../builders/playtest-telemetry.js';
import { type MutationOp } from '../builders/mutation-plan.js';
import { listRecipes, buildRecipeLuau } from '../builders/recipes.js';
import { type GameplayAssertion } from '../builders/gameplay-assertions.js';
import { type SnapshotLevel } from '../builders/world-model.js';
import { type ToolDomain } from './tool-catalog.js';
import { DiscoveryTools } from './discovery-tools.js';
import { WorldModelTools } from './world-model-tools.js';
import { SafetyTools } from './safety-tools.js';
import { SceneReadTools } from './scene-read-tools.js';
import { ScriptTools } from './script-tools.js';
import { MutationTools } from './mutation-tools.js';
import { AssetTools } from './asset-tools.js';
import { searchAssetSources, type AssetSourceProvider } from './asset-sources.js';
import { EpisodeStore } from './episode-store.js';
import { RuntimeTools } from './runtime-tools.js';
import {
  buildCreateSoundLuau,
  buildPlaySoundLuau,
  buildCreateAnimationLuau,
  buildPlayAnimationLuau,
  buildApplyTextureLuau,
  buildGenerateModelLuau,
  CreateSoundOptions,
  CreateAnimationOptions,
  PlayAnimationOptions,
  ApplyTextureOptions,
  GenerateModelOptions,
} from '../builders/media-builders.js';
import { buildDesignLintLuau, DesignLintOptions, buildApplyThemeLuau, ApplyThemeOptions, getDesignCatalog, buildReviewReparentLuau, buildReviewRestoreLuau, designReviewPrompt } from '../builders/design-builders.js';
import { PollinationsClient, DEFAULT_IMAGE_MODEL, ImageGenOptions } from '../image-client.js';
import { runBuildExecutor } from './build-executor.js';
import { GeneratedBuilderTools } from './generated-builder-tools.js';
import { SyncTools } from './sync-tools.js';
import { OpenCloudClient } from '../opencloud-client.js';
import { RobloxCookieClient } from '../roblox-cookie-client.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  errorMessage,
  normalizeExecuteLuauToolResult,
  type SafetyOptions,
  type ToolContent,
  wrapToolJsonText,
} from './runtime-support.js';

/** Whether a license obliges crediting the source (CC-BY family / explicit attribution). */
export function requiresAttribution(license?: string): boolean {
  return /cc[\s-]?by|attribution/i.test(license ?? '');
}

/** Provenance for an externally-imported asset (Track A). */
interface ProvenanceRecord {
  assetId: string | null;
  source: string;
  sourceName?: string;
  license?: string;
  attribution?: string;
  attributionRequired: boolean;
  assetType: string;
  sha256: string;
  bytes: number;
  importedAt: number;
}

export class RobloxStudioTools {
  private client: StudioHttpClient;
  private bridge: BridgeService;
  private openCloudClient: OpenCloudClient;
  private cookieClient: RobloxCookieClient;
  private safety: SafetyManager;
  private syncTools: SyncTools;
  private marketplace: MarketplaceClient;
  private imageClient: PollinationsClient;
  private generatedTools: GeneratedBuilderTools;
  private discoveryTools: DiscoveryTools;
  private worldTools: WorldModelTools;
  private safetyTools: SafetyTools;
  private sceneReadTools: SceneReadTools;
  private scriptTools: ScriptTools;
  private mutationTools: MutationTools;
  private assetTools: AssetTools;
  private runtimeTools: RuntimeTools;
  private episodes: EpisodeStore;
  /** Provenance for externally-imported assets (Track A) — source/license/hash/assetId. */
  private provenance = new Map<string, ProvenanceRecord>();

  constructor(bridge: BridgeService) {
    this.client = new StudioHttpClient(bridge);
    this.bridge = bridge;
    this.openCloudClient = new OpenCloudClient();
    this.cookieClient = new RobloxCookieClient();
    this.safety = new SafetyManager();
    this.marketplace = new MarketplaceClient();
    this.imageClient = new PollinationsClient();
    this.syncTools = new SyncTools(new SyncManager(), {
      callSingle: this._callSingle.bind(this),
      recordOperation: (kind, summary) => this.safety.recordOperation({ kind, summary }),
    });
    this.generatedTools = new GeneratedBuilderTools({
      runGeneratedLuau: this._runGeneratedLuau.bind(this),
      safetyGate: this._safetyGate.bind(this),
      recordOperation: (kind, summary) => this.safety.recordOperation({ kind, summary }),
    });
    this.discoveryTools = new DiscoveryTools();
    this.worldTools = new WorldModelTools({
      callSingle: this._callSingle.bind(this),
    });
    this.safetyTools = new SafetyTools({
      safety: this.safety,
      callSingle: this._callSingle.bind(this),
    });
    this.sceneReadTools = new SceneReadTools({
      callSingle: this._callSingle.bind(this),
      runGeneratedLuau: this._runGeneratedLuau.bind(this),
      bridge: this.bridge,
      client: this.client,
    });
    this.scriptTools = new ScriptTools({
      callSingle: this._callSingle.bind(this),
      safetyGate: this._safetyGate.bind(this),
      backupScript: (path, source) => this.safety.backupScript(path, source),
      recordOperation: (kind, summary) => this.safety.recordOperation({ kind: kind as OperationKind, summary }),
    });
    this.mutationTools = new MutationTools({
      callSingle: this._callSingle.bind(this),
      safetyGate: this._safetyGate.bind(this),
      recordOperation: (kind, summary) => this.safety.recordOperation({ kind: kind as OperationKind, summary }),
    });
    this.assetTools = new AssetTools({
      callSingle: this._callSingle.bind(this),
      runGeneratedLuau: (code, instance_id) => this._runGeneratedLuau(code, instance_id),
      recordOperation: (kind, summary) => this.safety.recordOperation({ kind, summary }),
      openCloudClient: this.openCloudClient,
      cookieClient: this.cookieClient,
      marketplace: this.marketplace,
      imageClient: this.imageClient,
    });
    this.episodes = new EpisodeStore();
    this.runtimeTools = new RuntimeTools({
      bridge: this.bridge,
      client: this.client,
      callSingle: this._callSingle.bind(this),
      safetyGate: this._safetyGate.bind(this),
      recordOperation: (kind, summary) => this.safety.recordOperation({ kind, summary }),
      episodes: this.episodes,
    });
  }

  /** The playtest-episode store — used by the resource plane (roblox://playtest/...)
   *  and by the server to wire resources/updated notifications (Track G3). */
  getEpisodeStore(): EpisodeStore { return this.episodes; }

  // === Safety layer ===
  // A single guard every destructive/bulk tool consults before touching the
  // bridge. It returns a ready-to-send MCP result when an operation must be
  // gated (confirmation), blocked (hard limit), or previewed (dry-run); it
  // returns null when the operation is cleared to proceed. Keeping the policy
  // here means each tool opts in with one line and shares identical behavior.

  private _safetyGate(
    kind: OperationKind,
    detail: string,
    input: { path?: string; count?: number; scriptSize?: number; code?: string },
    options?: SafetyOptions,
  ): { content: ToolContent[] } | null {
    const assessment = this.safety.assess({
      kind,
      ...input,
      dryRun: options?.dryRun,
      confirmed: options?.confirm,
    });
    if (assessment.dryRun || !assessment.allowed) {
      return this._formatSafety(kind, detail, assessment);
    }
    return null;
  }

  private _formatSafety(
    kind: OperationKind,
    detail: string,
    assessment: ReturnType<SafetyManager['assess']>,
  ): { content: ToolContent[] } {
    const lines: string[] = [];
    if (assessment.dryRun) {
      lines.push(`Dry-run preview for ${kind}: ${detail}. No changes were made.`);
    } else if (assessment.blocked) {
      lines.push(`Operation blocked: ${kind} — ${detail}.`);
    } else {
      lines.push(`Confirmation required for ${kind}: ${detail}.`);
    }
    if (assessment.reasons.length) lines.push('Reasons:\n- ' + assessment.reasons.join('\n- '));
    if (assessment.warnings.length) lines.push('Warnings:\n- ' + assessment.warnings.join('\n- '));
    if (!assessment.dryRun && assessment.requiresConfirmation && !assessment.blocked) {
      lines.push('To proceed, re-run this tool with confirm: true.');
    }
    return { content: [{ type: 'text', text: lines.join('\n\n') }] };
  }

  // Safety/audit read tools live in SafetyTools; the facade delegates.
  async getOperationHistory(limit?: number) { return this.safetyTools.getOperationHistory(limit); }
  async listScriptBackups() { return this.safetyTools.listScriptBackups(); }
  async restoreScriptBackup(instancePath: string, instance_id?: string) { return this.safetyTools.restoreScriptBackup(instancePath, instance_id); }

  // === Generated-Luau builders (UI / environment / terrain) ===
  // These tools compose typed parameters into Luau that runs in the plugin's
  // edit context. Centralizing execution here means the safety layer, history,
  // and instance routing all apply uniformly without touching the plugin.

  private async _runGeneratedLuau(code: string, instance_id?: string) {
    const response = await this._callSingle('/api/execute-luau', { code }, 'edit', instance_id);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] as ToolContent[] };
  }

  // --- Generated-Luau builder domain facade ---

  async uiCreateScreenGui(options: ScreenGuiOptions, instance_id?: string) { return this.generatedTools.uiCreateScreenGui(options, instance_id); }
  async uiCreateFrame(options: GuiObjectOptions, instance_id?: string) { return this.generatedTools.uiCreateFrame(options, instance_id); }
  async uiCreateTextLabel(options: GuiObjectOptions, instance_id?: string) { return this.generatedTools.uiCreateTextLabel(options, instance_id); }
  async uiCreateTextButton(options: GuiObjectOptions, instance_id?: string) { return this.generatedTools.uiCreateTextButton(options, instance_id); }
  async uiCreateImageLabel(options: GuiObjectOptions, instance_id?: string) { return this.generatedTools.uiCreateImageLabel(options, instance_id); }
  async uiCreateImageButton(options: GuiObjectOptions, instance_id?: string) { return this.generatedTools.uiCreateImageButton(options, instance_id); }
  async uiApplyLayout(options: LayoutOptions & { targetPath: string }, instance_id?: string) { return this.generatedTools.uiApplyLayout(options, instance_id); }
  async uiMakeMobileFriendly(targetPath: string, instance_id?: string) { return this.generatedTools.uiMakeMobileFriendly(targetPath, instance_id); }

  async environmentSetTimeOfDay(time: number | string, instance_id?: string) { return this.generatedTools.environmentSetTimeOfDay(time, instance_id); }
  async environmentSetLightingPreset(preset: string, withPostFx?: boolean, instance_id?: string) { return this.generatedTools.environmentSetLightingPreset(preset, withPostFx, instance_id); }
  async environmentSetAtmosphere(options: AtmospherePreset, instance_id?: string) { return this.generatedTools.environmentSetAtmosphere(options, instance_id); }
  async environmentSetSky(options: SkyOptions, instance_id?: string) { return this.generatedTools.environmentSetSky(options, instance_id); }
  async environmentCreateDayNightCycleScript(options: DayNightCycleOptions, instance_id?: string) { return this.generatedTools.environmentCreateDayNightCycleScript(options, instance_id); }

  async terrainGenerateBaseplate(options: BaseplateOptions & SafetyOptions, instance_id?: string) { return this.generatedTools.terrainGenerateBaseplate(options, instance_id); }
  async terrainGenerateIsland(options: IslandOptions & SafetyOptions, instance_id?: string) { return this.generatedTools.terrainGenerateIsland(options, instance_id); }
  async terrainGenerateMountains(options: MountainsOptions & SafetyOptions, instance_id?: string) { return this.generatedTools.terrainGenerateMountains(options, instance_id); }
  async terrainGenerateWater(options: WaterOptions & SafetyOptions, instance_id?: string) { return this.generatedTools.terrainGenerateWater(options, instance_id); }
  async terrainPaintMaterial(options: PaintMaterialOptions & SafetyOptions, instance_id?: string) { return this.generatedTools.terrainPaintMaterial(options, instance_id); }
  async terrainClearRegion(options: ClearRegionOptions & SafetyOptions, instance_id?: string) { return this.generatedTools.terrainClearRegion(options, instance_id); }

  async templateCreateObbyGame(options: ObbyTemplateOptions, instance_id?: string) { return this.generatedTools.templateCreateObbyGame(options, instance_id); }
  async templateCreateSimulatorGame(options: SimulatorTemplateOptions, instance_id?: string) { return this.generatedTools.templateCreateSimulatorGame(options, instance_id); }
  async templateCreateTycoonGame(options: TycoonTemplateOptions, instance_id?: string) { return this.generatedTools.templateCreateTycoonGame(options, instance_id); }
  async templateCreateRoundGame(options: RoundTemplateOptions, instance_id?: string) { return this.generatedTools.templateCreateRoundGame(options, instance_id); }

  // === Local sync facade ===

  async syncPull(syncDir?: string, instance_id?: string) { return this.syncTools.syncPull(syncDir, instance_id); }
  async syncStatus(syncDir?: string, instance_id?: string) { return this.syncTools.syncStatus(syncDir, instance_id); }
  async syncPush(syncDir?: string, instance_id?: string, options?: SafetyOptions) { return this.syncTools.syncPush(syncDir, instance_id, options); }

  // Resolve (instance_id, target-role) → concrete (instanceId, role) and
  // dispatch a single request. Throws RoutingFailure if the resolution is
  // ambiguous, missing, or asks for fanout on a non-fanout-capable tool —
  // the MCP transport layer surfaces it as a structured error result so
  // the LLM can recover via the embedded data.instances list.
  private async _callSingle(
    endpoint: string,
    data: any,
    target: string | undefined,
    instance_id: string | undefined,
  ): Promise<any> {
    // Pass target through as-is so resolveTarget can tell "caller didn't
    // specify" (target=undefined → multiple_instances_connected) apart
    // from "caller picked edit explicitly" (target='edit' → ambiguous_target).
    // Tools that intrinsically need a specific role pass it as a string
    // literal here; tools without a target arg pass undefined.
    const r = this.bridge.resolveTarget({ instance_id, target });
    if (!r.ok) throw new RoutingFailure(r.error);
    if (r.mode !== 'single') {
      throw new RoutingFailure({
        code: 'target_role_not_present_on_instance',
        message: 'This tool does not support target=all. Pick a specific role or omit target.',
        data: {
          instances: this.bridge.getPublicInstances(),
          count: this.bridge.getInstances().length,
        },
      });
    }
    return this.client.request(endpoint, data, r.targetInstanceId, r.targetRole);
  }


  // Scene-read inspection tools live in SceneReadTools; the facade delegates with
  // identical signatures.
  async getFileTree(path: string = '', instance_id?: string) { return this.sceneReadTools.getFileTree(path, instance_id); }

  async searchFiles(query: string, searchType: string = 'name', instance_id?: string) {
    const response = await this._callSingle('/api/search-files', { query, searchType }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }


  async getPlaceInfo(instance_id?: string) { return this.sceneReadTools.getPlaceInfo(instance_id); }

  async getServices(serviceName?: string, instance_id?: string) { return this.sceneReadTools.getServices(serviceName, instance_id); }

  async searchObjects(query: string, searchType: string = 'name', propertyName?: string, limit?: number, offset?: number, fields?: string[], instance_id?: string) { return this.sceneReadTools.searchObjects(query, searchType, propertyName, limit, offset, fields, instance_id); }

  async getInstanceProperties(instancePath: string, excludeSource?: boolean, instance_id?: string) { return this.sceneReadTools.getInstanceProperties(instancePath, excludeSource, instance_id); }

  async getInstanceChildren(instancePath: string, instance_id?: string) { return this.sceneReadTools.getInstanceChildren(instancePath, instance_id); }

  async searchByProperty(propertyName: string, propertyValue: string, instance_id?: string) { return this.sceneReadTools.searchByProperty(propertyName, propertyValue, instance_id); }

  async getClassInfo(className: string, instance_id?: string) { return this.sceneReadTools.getClassInfo(className, instance_id); }

  async getProjectStructure(path?: string, maxDepth?: number, scriptsOnly?: boolean, instance_id?: string) { return this.sceneReadTools.getProjectStructure(path, maxDepth, scriptsOnly, instance_id); }



  // Mutation tools live in MutationTools; the facade delegates with identical signatures.
  async setProperty(instancePath: string, propertyName: string, propertyValue: any, instance_id?: string) { return this.mutationTools.setProperty(instancePath, propertyName, propertyValue, instance_id); }

  async setProperties(instancePath: string, properties: Record<string, any>, instance_id?: string) { return this.mutationTools.setProperties(instancePath, properties, instance_id); }

  async massSetProperty(paths: string[], propertyName: string, propertyValue: any, instance_id?: string) { return this.mutationTools.massSetProperty(paths, propertyName, propertyValue, instance_id); }

  async massGetProperty(paths: string[], propertyName: string, instance_id?: string) { return this.mutationTools.massGetProperty(paths, propertyName, instance_id); }

  async createObject(className: string, parent: string, name?: string, properties?: Record<string, any>, instance_id?: string) { return this.mutationTools.createObject(className, parent, name, properties, instance_id); }

  async massCreateObjects(objects: Array<{className: string, parent: string, name?: string, properties?: Record<string, any>}>, instance_id?: string, options?: SafetyOptions) { return this.mutationTools.massCreateObjects(objects, instance_id, options); }

  async deleteObject(instancePath: string, instance_id?: string, options?: SafetyOptions) { return this.mutationTools.deleteObject(instancePath, instance_id, options); }

  async smartDuplicate(
    instancePath: string,
    count: number,
    options?: {
      namePattern?: string;
      positionOffset?: [number, number, number];
      rotationOffset?: [number, number, number];
      scaleOffset?: [number, number, number];
      propertyVariations?: Record<string, any[]>;
      targetParents?: string[];
    },
    instance_id?: string
  ) { return this.mutationTools.smartDuplicate(instancePath, count, options, instance_id); }

  async massDuplicate(
    duplications: Array<{
      instancePath: string;
      count: number;
      options?: {
        namePattern?: string;
        positionOffset?: [number, number, number];
        rotationOffset?: [number, number, number];
        scaleOffset?: [number, number, number];
        propertyVariations?: Record<string, any[]>;
        targetParents?: string[];
      }
    }>,
    instance_id?: string
  ) { return this.mutationTools.massDuplicate(duplications, instance_id); }




  // Script tools live in ScriptTools; the facade delegates with identical signatures.
  async getScriptSource(instancePath: string, startLine?: number, endLine?: number, instance_id?: string) { return this.scriptTools.getScriptSource(instancePath, startLine, endLine, instance_id); }

  async setScriptSource(instancePath: string, source: string, instance_id?: string, options?: SafetyOptions) { return this.scriptTools.setScriptSource(instancePath, source, instance_id, options); }

  async editScriptLines(instancePath: string, oldString: string, newString: string, startLine?: number, instance_id?: string) { return this.scriptTools.editScriptLines(instancePath, oldString, newString, startLine, instance_id); }

  async insertScriptLines(instancePath: string, afterLine: number, newContent: string, instance_id?: string) { return this.scriptTools.insertScriptLines(instancePath, afterLine, newContent, instance_id); }

  async deleteScriptLines(instancePath: string, startLine: number, endLine: number, instance_id?: string) { return this.scriptTools.deleteScriptLines(instancePath, startLine, endLine, instance_id); }

  async grepScripts(
    pattern: string,
    options?: {
      caseSensitive?: boolean;
      usePattern?: boolean;
      contextLines?: number;
      maxResults?: number;
      maxResultsPerScript?: number;
      filesOnly?: boolean;
      path?: string;
      classFilter?: string;
    },
    instance_id?: string
  ) { return this.scriptTools.grepScripts(pattern, options, instance_id); }

  async setAttribute(instancePath: string, attributeName: string, attributeValue: any, valueType?: string, instance_id?: string) { return this.mutationTools.setAttribute(instancePath, attributeName, attributeValue, valueType, instance_id); }

  async getAttributes(instancePath: string, instance_id?: string) { return this.mutationTools.getAttributes(instancePath, instance_id); }

  async deleteAttribute(instancePath: string, attributeName: string, instance_id?: string) { return this.mutationTools.deleteAttribute(instancePath, attributeName, instance_id); }

  async getTags(instancePath: string, instance_id?: string) { return this.mutationTools.getTags(instancePath, instance_id); }

  async addTag(instancePath: string, tagName: string, instance_id?: string) { return this.mutationTools.addTag(instancePath, tagName, instance_id); }

  async removeTag(instancePath: string, tagName: string, instance_id?: string) { return this.mutationTools.removeTag(instancePath, tagName, instance_id); }

  async getTagged(tagName: string, instance_id?: string) { return this.mutationTools.getTagged(tagName, instance_id); }

  async getSelection(instance_id?: string) { return this.sceneReadTools.getSelection(instance_id); }

  // Runtime / playtest / eval / simulation tools live in RuntimeTools; the facade
  // delegates with identical public signatures (instance_id stays the last param).
  async executeLuau(code: string, target?: string, instance_id?: string, options?: SafetyOptions) { return this.runtimeTools.executeLuau(code, target, instance_id, options); }

  async executeLuauAsync(code: string, target?: string, instance_id?: string, options?: SafetyOptions) { return this.runtimeTools.executeLuauAsync(code, target, instance_id, options); }

  async getJobStatus(jobId: string, target?: string, instance_id?: string) { return this.runtimeTools.getJobStatus(jobId, target, instance_id); }

  async getJobResult(jobId: string, target?: string, instance_id?: string) { return this.runtimeTools.getJobResult(jobId, target, instance_id); }

  async cancelJob(jobId: string, target?: string, instance_id?: string) { return this.runtimeTools.cancelJob(jobId, target, instance_id); }

  async evalServerRuntime(code: string, instance_id?: string) { return this.runtimeTools.evalServerRuntime(code, instance_id); }

  async evalClientRuntime(code: string, target?: string, instance_id?: string) { return this.runtimeTools.evalClientRuntime(code, target, instance_id); }

  async setNetworkProfile(profile: string, target?: string, overrides?: Record<string, unknown>, instance_id?: string) { return this.runtimeTools.setNetworkProfile(profile, target, overrides, instance_id); }

  async getSimulationState(include?: string, target?: string, instance_id?: string) { return this.runtimeTools.getSimulationState(include, target, instance_id); }

  async resetSimulationState(target?: string, network?: boolean, deviceSimulator?: boolean, instance_id?: string) { return this.runtimeTools.resetSimulationState(target, network, deviceSimulator, instance_id); }

  async getDeviceSimulatorState(target?: string, deviceId?: string, includeDeviceList?: boolean, instance_id?: string) { return this.runtimeTools.getDeviceSimulatorState(target, deviceId, includeDeviceList, instance_id); }

  async setDeviceSimulator(
    target?: string,
    deviceId?: string,
    orientation?: string,
    resolution?: unknown,
    pixelDensity?: number,
    scalingMode?: string,
    stopSimulation?: boolean,
    instance_id?: string,
  ) { return this.runtimeTools.setDeviceSimulator(target, deviceId, orientation, resolution, pixelDensity, scalingMode, stopSimulation, instance_id); }

  async captureDeviceMatrix(
    entries: unknown,
    target?: string,
    format?: string,
    quality?: number,
    settleSeconds?: number,
    restoreAfter?: boolean,
    instance_id?: string,
  ) { return this.runtimeTools.captureDeviceMatrix(entries, target, format, quality, settleSeconds, restoreAfter, instance_id); }

  async getRuntimeLogs(target?: string, since?: number, tail?: number, filter?: string, instance_id?: string) { return this.runtimeTools.getRuntimeLogs(target, since, tail, filter, instance_id); }

  async captureScriptProfiler(target?: string, request: Record<string, unknown> = {}, instance_id?: string) { return this.runtimeTools.captureScriptProfiler(target, request, instance_id); }

  async breakpoints(action: string, request: Record<string, unknown> = {}, target?: string, instance_id?: string) { return this.runtimeTools.breakpoints(action, request, target, instance_id); }

  async startPlaytest(mode: string, numPlayers?: number, instance_id?: string) { return this.runtimeTools.startPlaytest(mode, numPlayers, instance_id); }

  async stopPlaytest(instance_id?: string) { return this.runtimeTools.stopPlaytest(instance_id); }

  async multiplayerTestStart(numPlayers: number, testArgs?: unknown, timeout?: number, instance_id?: string) { return this.runtimeTools.multiplayerTestStart(numPlayers, testArgs, timeout, instance_id); }

  async multiplayerTestState(instance_id?: string) { return this.runtimeTools.multiplayerTestState(instance_id); }

  async multiplayerTestAddPlayers(numPlayers: number, timeout?: number, instance_id?: string) { return this.runtimeTools.multiplayerTestAddPlayers(numPlayers, timeout, instance_id); }

  async multiplayerTestLeaveClient(target: string = 'client-1', timeout?: number, instance_id?: string) { return this.runtimeTools.multiplayerTestLeaveClient(target, timeout, instance_id); }

  async multiplayerTestEnd(value?: unknown, timeout?: number, instance_id?: string) { return this.runtimeTools.multiplayerTestEnd(value, timeout, instance_id); }

  async getConnectedInstances() {
    const instances = this.bridge.getPublicInstances();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ instances, count: instances.length })
        }
      ]
    };
  }

  async undo(instance_id?: string) { return this.runtimeTools.undo(instance_id); }

  async redo(instance_id?: string) { return this.runtimeTools.redo(instance_id); }


  private static findProjectRoot(startDir: string): string | null {
    let dir = path.resolve(startDir);
    let previous = '';
    while (dir !== previous) {
      if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, 'package.json'))) {
        return dir;
      }
      previous = dir;
      dir = path.dirname(dir);
    }
    return null;
  }

  private static isDirectory(candidate: string | null | undefined): candidate is string {
    if (!candidate) return false;
    try {
      return fs.statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  }

  private static ensureWritableDirectory(candidate: string, label: string): string {
    const resolved = path.resolve(candidate);
    try {
      fs.mkdirSync(resolved, { recursive: true });
    } catch (error) {
      throw new Error(`Unable to create ${label} build-library directory at ${resolved}: ${(error as Error).message}`);
    }
    if (!RobloxStudioTools.isDirectory(resolved)) {
      throw new Error(`${label} build-library path is not a directory: ${resolved}`);
    }
    try {
      fs.accessSync(resolved, fs.constants.W_OK);
    } catch (error) {
      throw new Error(`${label} build-library directory is not writable: ${resolved}. ${(error as Error).message}`);
    }
    return resolved;
  }

  private static _cachedLibraryPath: string | undefined;

  private static findLibraryPath(): string {
    if (RobloxStudioTools._cachedLibraryPath) return RobloxStudioTools._cachedLibraryPath;

    const overridePath = process.env.ROBLOXSTUDIO_MCP_BUILD_LIBRARY || process.env.BUILD_LIBRARY_PATH;
    const cwd = path.resolve(process.cwd());
    const projectRoot = RobloxStudioTools.findProjectRoot(cwd);
    const homeLibraryPath = path.join(os.homedir(), '.robloxstudio-mcp', 'build-library');
    const projectLibraryPath = projectRoot ? path.join(projectRoot, 'build-library') : null;
    const cwdLibraryPath = path.join(cwd, 'build-library');

    let result: string;

    if (overridePath) {
      result = RobloxStudioTools.ensureWritableDirectory(overridePath, 'override');
    } else {
      const existing = [projectLibraryPath, cwdLibraryPath].find(
        c => c && RobloxStudioTools.isDirectory(c) && (() => { try { fs.accessSync(c, fs.constants.W_OK); return true; } catch { return false; } })()
      );
      if (existing) {
        result = path.resolve(existing);
      } else if (projectLibraryPath) {
        try {
          result = RobloxStudioTools.ensureWritableDirectory(projectLibraryPath, 'project-root');
        } catch (err) {
          console.error(`Warning: could not create build-library at project root (${projectLibraryPath}): ${(err as Error).message}. Falling back to home directory.`);
          result = RobloxStudioTools.ensureWritableDirectory(homeLibraryPath, 'home');
        }
      } else {
        result = RobloxStudioTools.ensureWritableDirectory(homeLibraryPath, 'home');
      }
    }

    RobloxStudioTools._cachedLibraryPath = result;
    return result;
  }

  async exportBuild(instancePath: string, outputId?: string, style: string = 'misc', instance_id?: string) {
    if (!instancePath) {
      throw new Error('Instance path is required for export_build');
    }
    const response = await this._callSingle('/api/export-build', {
      instancePath,
      outputId,
      style
    }, undefined, instance_id) as any;

    // Auto-save to library
    if (response && response.success && response.buildData) {
      const buildData = response.buildData;
      const buildId = buildData.id || `${style}/exported`;
      const filePath = path.join(RobloxStudioTools.findLibraryPath(), `${buildId}.json`);
      const dirPath = path.dirname(filePath);

      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
      fs.writeFileSync(filePath, JSON.stringify(buildData, null, 2));
      response.savedTo = filePath;
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

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

  async createBuild(
    id: string,
    style: string,
    palette: Record<string, any>,
    parts: unknown,
    bounds?: [number, number, number]
  ) {
    if (!id) {
      throw new Error('id is required for create_build');
    }

    const normalizedPalette = this.normalizePalette(palette);
    const normalizedParts = this.normalizeBuildParts(parts, new Set(Object.keys(normalizedPalette)));

    // Auto-compute bounds if not provided
    const computedBounds = bounds || this.computeBounds(normalizedParts);

    const buildData = { id, style, bounds: computedBounds, palette: normalizedPalette, parts: normalizedParts };

    const filePath = path.join(RobloxStudioTools.findLibraryPath(), `${id}.json`);
    const dirPath = path.dirname(filePath);

    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(buildData, null, 2));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            id,
            style,
            bounds: computedBounds,
            partCount: normalizedParts.length,
            paletteKeys: Object.keys(normalizedPalette),
            savedTo: filePath
          })
        }
      ]
    };
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
      Math.round(maxZ * 2 * 10) / 10
    ];
  }

  async generateBuild(
    id: string,
    style: string,
    palette: Record<string, [string, string]>,
    code: string,
    seed?: number
  ) {
    if (!id || !palette || !code) {
      throw new Error('id, palette, and code are required for generate_build');
    }

    // Validate palette
    for (const [key, value] of Object.entries(palette)) {
      if (!Array.isArray(value) || value.length < 2 || value.length > 3) {
        throw new Error(`Palette key "${key}" must map to [BrickColor, Material] or [BrickColor, Material, MaterialVariant]`);
      }
    }

    // Run the build executor
    const result = runBuildExecutor(code, palette, seed);

    const buildData: Record<string, any> = {
      id,
      style,
      bounds: result.bounds,
      palette,
      parts: result.parts,
      generatorCode: code,
    };
    if (seed !== undefined) buildData.generatorSeed = seed;

    const filePath = path.join(RobloxStudioTools.findLibraryPath(), `${id}.json`);
    const dirPath = path.dirname(filePath);

    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(buildData, null, 2));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            id,
            style,
            bounds: result.bounds,
            partCount: result.partCount,
            paletteKeys: Object.keys(palette),
            savedTo: filePath
          })
        }
      ]
    };
  }

  async importBuild(buildData: Record<string, any> | string, targetPath: string, position?: [number, number, number], instance_id?: string) {
    if (!buildData || !targetPath) {
      throw new Error('buildData (or library ID string) and targetPath are required for import_build');
    }

    // If buildData is a string, treat it as a library ID and load the file
    let resolved: Record<string, any>;
    if (typeof buildData === 'string') {
      const filePath = path.join(RobloxStudioTools.findLibraryPath(), `${buildData}.json`);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Build not found in library: ${buildData}`);
      }
      resolved = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } else if (buildData.id && !buildData.parts) {
      // Object with just an id - try loading from library
      const filePath = path.join(RobloxStudioTools.findLibraryPath(), `${buildData.id}.json`);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Build not found in library: ${buildData.id}`);
      }
      resolved = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } else {
      resolved = buildData;
    }

    const response = await this._callSingle('/api/import-build', {
      buildData: resolved,
      targetPath,
      position
    }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async listLibrary(style?: string) {
    const libraryPath = RobloxStudioTools.findLibraryPath();
    const styles = style ? [style] : ['medieval', 'modern', 'nature', 'scifi', 'misc'];
    const builds: Array<{ id: string; style: string; bounds: number[]; partCount: number }> = [];

    for (const s of styles) {
      const dirPath = path.join(libraryPath, s);
      if (!fs.existsSync(dirPath)) continue;

      const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(dirPath, file), 'utf-8');
          const data = JSON.parse(content);
          builds.push({
            id: data.id || `${s}/${file.replace('.json', '')}`,
            style: data.style || s,
            bounds: data.bounds || [0, 0, 0],
            partCount: Array.isArray(data.parts) ? data.parts.length : 0
          });
        } catch {
          // Skip invalid JSON files
        }
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ builds, total: builds.length })
        }
      ]
    };
  }

  async searchMaterials(query?: string, maxResults?: number, instance_id?: string) {
    const response = await this._callSingle('/api/search-materials', {
      query: query ?? '',
      maxResults: maxResults ?? 50
    }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async getBuild(id: string) {
    if (!id) {
      throw new Error('Build ID is required for get_build');
    }

    const filePath = path.join(RobloxStudioTools.findLibraryPath(), `${id}.json`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Build not found in library: ${id}`);
    }

    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

    // Return metadata + code (but not the full parts array to save tokens)
    const result: Record<string, any> = {
      id: data.id,
      style: data.style,
      bounds: data.bounds,
      partCount: Array.isArray(data.parts) ? data.parts.length : 0,
      paletteKeys: data.palette ? Object.keys(data.palette) : [],
      palette: data.palette,
    };

    if (data.generatorCode) {
      result.generatorCode = data.generatorCode;
      result.generatorSeed = data.generatorSeed;
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result)
        }
      ]
    };
  }

  async importScene(
    sceneData: {
      models?: Record<string, string>;
      place?: Array<
        [string, number[], number[]?]
        | { modelKey: string; position: number[]; rotation?: number[] }
      >;
      custom?: Array<{ n: string; o: number[]; palette: Record<string, [string, string]>; parts: any[][] }>;
    },
    targetPath: string = 'game.Workspace',
    instance_id?: string
  ) {
    if (!sceneData) {
      throw new Error('sceneData is required for import_scene');
    }

    const libraryPath = RobloxStudioTools.findLibraryPath();
    const expandedBuilds: Array<{ buildData: Record<string, any>; position: number[]; rotation: number[]; name: string }> = [];

    // Resolve model references from library
    const modelMap = sceneData.models || {};
    const placements = sceneData.place || [];

    const isVec3Tuple = (value: unknown): value is [number, number, number] => {
      return Array.isArray(value)
        && value.length === 3
        && value.every(component => typeof component === 'number' && Number.isFinite(component));
    };

    for (const [placementIndex, placement] of placements.entries()) {
      let modelKey: string;
      let position: [number, number, number];
      let rotation: [number, number, number] | undefined;
      let validatedKeyPath: string;

      if (Array.isArray(placement)) {
        if (placement.length < 2 || placement.length > 3) {
          throw new Error(
            `Invalid sceneData.place[${placementIndex}]: expected [modelKey, [x,y,z], [rotX?,rotY?,rotZ?]]`
          );
        }
        const [tupleModelKey, tuplePosition, tupleRotation] = placement;
        if (typeof tupleModelKey !== 'string' || tupleModelKey.trim() === '') {
          throw new Error(`Invalid sceneData.place[${placementIndex}][0]: model key must be a non-empty string`);
        }
        modelKey = tupleModelKey.trim();
        validatedKeyPath = `sceneData.place[${placementIndex}][0]`;
        if (!isVec3Tuple(tuplePosition)) {
          throw new Error(`Invalid sceneData.place[${placementIndex}][1]: position must be a numeric [x,y,z] tuple`);
        }
        position = tuplePosition;
        if (tupleRotation !== undefined) {
          if (!isVec3Tuple(tupleRotation)) {
            throw new Error(
              `Invalid sceneData.place[${placementIndex}][2]: rotation must be a numeric [x,y,z] tuple when provided`
            );
          }
          rotation = tupleRotation;
        }
      } else if (placement && typeof placement === 'object') {
        const placementRecord = placement as Record<string, unknown>;
        const objectModelKey = placementRecord.modelKey;
        const objectPosition = placementRecord.position;
        const objectRotation = placementRecord.rotation;
        if (typeof objectModelKey !== 'string' || objectModelKey.trim() === '') {
          throw new Error(`Invalid sceneData.place[${placementIndex}].modelKey: model key must be a non-empty string`);
        }
        if (!isVec3Tuple(objectPosition)) {
          throw new Error(`Invalid sceneData.place[${placementIndex}].position: must be a numeric [x,y,z] tuple`);
        }
        if (objectRotation !== undefined && !isVec3Tuple(objectRotation)) {
          throw new Error(
            `Invalid sceneData.place[${placementIndex}].rotation: must be a numeric [x,y,z] tuple when provided`
          );
        }
        modelKey = objectModelKey.trim();
        validatedKeyPath = `sceneData.place[${placementIndex}].modelKey`;
        position = objectPosition;
        rotation = objectRotation as [number, number, number] | undefined;
      } else {
        throw new Error(
          `Invalid sceneData.place[${placementIndex}]: expected an object placement or [modelKey, [x,y,z], [rotX?,rotY?,rotZ?]] tuple`
        );
      }

      const buildId = modelMap[modelKey];
      if (!buildId) {
        throw new Error(
          `Invalid ${validatedKeyPath}: model key "${modelKey}" is not defined in sceneData.models`
        );
      }

      // Load build data from library
      const filePath = path.join(libraryPath, `${buildId}.json`);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Build not found in library: ${buildId}`);
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      const buildData = JSON.parse(content);
      const buildName = buildId.split('/').pop() || buildId;

      expandedBuilds.push({
        buildData,
        position,
        rotation: rotation || [0, 0, 0],
        name: buildName
      });
    }

    // Add custom inline builds
    const customs = sceneData.custom || [];
    for (const custom of customs) {
      expandedBuilds.push({
        buildData: {
          palette: custom.palette,
          parts: custom.parts
        },
        position: custom.o || [0, 0, 0],
        rotation: [0, 0, 0],
        name: custom.n || 'Custom'
      });
    }

    if (expandedBuilds.length === 0) {
      throw new Error('No builds to import - check model references and library');
    }

    // Send expanded builds to plugin
    const response = await this._callSingle('/api/import-scene', {
      expandedBuilds,
      targetPath
    }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }


  // === Asset Tools ===

  async searchAssets(
    assetType: string,
    query?: string,
    maxResults?: number,
    sortBy?: string,
    verifiedCreatorsOnly?: boolean
  ) {
    if (!this.openCloudClient.hasApiKey()) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: 'ROBLOX_OPEN_CLOUD_API_KEY environment variable is not set. Set it to use Creator Store asset tools.' })
        }]
      };
    }

    const response = await this.openCloudClient.searchAssets({
      searchCategoryType: assetType as any,
      query,
      maxPageSize: maxResults,
      sortCategory: sortBy as any,
      includeOnlyVerifiedCreators: verifiedCreatorsOnly,
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response)
      }]
    };
  }

  async getAssetDetails(assetId: number) {
    if (!assetId) {
      throw new Error('Asset ID is required for get_asset_details');
    }

    if (this.cookieClient.hasCookie() && !this.openCloudClient.hasApiKey()) {
      const results = await this.cookieClient.getAssetDetails([assetId]);
      const asset = results[0];
      if (!asset) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Asset not found or not owned by authenticated user' }) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(asset) }] };
    }

    if (!this.openCloudClient.hasApiKey()) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: 'No auth configured. Set ROBLOSECURITY or ROBLOX_OPEN_CLOUD_API_KEY env var.' })
        }]
      };
    }

    const response = await this.openCloudClient.getAssetDetails(assetId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response)
      }]
    };
  }

  async getAssetThumbnail(assetId: number, size?: string) {
    if (!assetId) {
      throw new Error('Asset ID is required for get_asset_thumbnail');
    }
    if (!this.openCloudClient.hasApiKey()) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: 'ROBLOX_OPEN_CLOUD_API_KEY environment variable is not set. Set it to use Creator Store asset tools.' })
        }]
      };
    }

    const result = await this.openCloudClient.getAssetThumbnail(assetId, size as any);
    if (!result) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: 'Thumbnail not available for this asset' })
        }]
      };
    }

    return {
      content: [{
        type: 'image',
        data: result.base64,
        mimeType: result.mimeType,
      }]
    };
  }

  async insertAsset(assetId: number, parentPath?: string, position?: { x: number; y: number; z: number }, instance_id?: string) {
    if (!assetId) {
      throw new Error('Asset ID is required for insert_asset');
    }
    const response = await this._callSingle('/api/insert-asset', {
      assetId,
      parentPath: parentPath || 'game.Workspace',
      position
    }, undefined, instance_id);
    const outcome = interpretInsertResponse(response);
    if (!outcome.ok) {
      const hint = outcome.code === 'AUTH'
        ? 'This asset is copy-locked: InsertService can only load assets you own or that are public + copy-enabled. Pick a free/owned asset (e.g. via marketplace_search, which ranks insertable candidates) and try another id.'
        : outcome.code === 'NOT_FOUND'
          ? `Parent path "${parentPath || 'game.Workspace'}" did not resolve. Verify it with get_instance_children before inserting.`
          : undefined;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ ...typedError(outcome.message ?? 'Insert failed', outcome.code), inserted: false, hint, response }),
        }],
      };
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response)
      }]
    };
  }

  async previewAsset(assetId: number, includeProperties?: boolean, maxDepth?: number, instance_id?: string) {
    if (!assetId) {
      throw new Error('Asset ID is required for preview_asset');
    }
    const response = await this._callSingle('/api/preview-asset', {
      assetId,
      includeProperties: includeProperties ?? true,
      maxDepth: maxDepth ?? 10
    }, undefined, instance_id);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response)
      }]
    };
  }

  // === Free marketplace (no Open Cloud key) ===
  // Search Roblox's public toolbox for insertable assets, then insert with
  // insert_asset (InsertService — also key-free). Pairs the discovery gap that
  // search_assets (Creator Store) leaves for users without an API key.

  async marketplaceSearch(keyword: string, category?: string, limit?: number, sortType?: string) {
    if (!keyword || !keyword.trim()) {
      throw new Error('keyword is required for marketplace_search');
    }
    try {
      const results = await this.marketplace.search({ keyword, category, limit, sortType });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            keyword,
            category: category ?? 'Model',
            count: results.length,
            results,
            hint: results.length > 0 ? 'Insert one with insert_asset (assetId) or marketplace_search_and_insert.' : 'No results — try a different keyword or category.',
          }),
        }] as ToolContent[],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: errorMessage(error) }) }] as ToolContent[] };
    }
  }

  async marketplaceSearchAndInsert(
    keyword: string,
    category?: string,
    parentPath?: string,
    position?: { x: number; y: number; z: number },
    instance_id?: string,
  ) {
    if (!keyword || !keyword.trim()) {
      throw new Error('keyword is required for marketplace_search_and_insert');
    }
    let results;
    try {
      results = await this.marketplace.search({ keyword, category, limit: 5 });
    } catch (error) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: errorMessage(error) }) }] as ToolContent[] };
    }
    if (results.length === 0) {
      return { content: [{ type: 'text', text: JSON.stringify({ inserted: false, reason: `No marketplace results for "${keyword}".` }) }] as ToolContent[] };
    }
    // Results are already ranked best-fit-first. Many toolbox models are
    // copy-locked (InsertService AUTH); walk the candidates and insert the first
    // that actually loads, rather than failing on a single locked hit.
    const attempts: Array<{ id: number; name: string; code?: string }> = [];
    for (const chosen of results) {
      const response = await this._callSingle('/api/insert-asset', {
        assetId: chosen.id,
        parentPath: parentPath || 'game.Workspace',
        position,
      }, undefined, instance_id);
      const outcome = interpretInsertResponse(response);
      if (outcome.ok) {
        this.safety.recordOperation({ kind: 'marketplace_insert', summary: `inserted "${chosen.name}" (${chosen.id})` });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              inserted: true,
              asset: chosen,
              triedBeforeSuccess: attempts,
              alternatives: results.filter((r) => r.id !== chosen.id),
              response,
            }),
          }] as ToolContent[],
        };
      }
      attempts.push({ id: chosen.id, name: chosen.name, code: outcome.code });
      // Stop early on non-asset problems (e.g. bad parent) — retrying other ids won't help.
      if (outcome.code === 'NOT_FOUND') break;
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          inserted: false,
          reason: `None of the ${attempts.length} ranked candidate(s) for "${keyword}" could be inserted (mostly copy-locked / auth-blocked).`,
          tried: attempts,
          candidates: results,
          hint: 'Toolbox models are often copy-locked. Try a different keyword, or pick a result you own / that is public+copy-enabled.',
        }),
      }] as ToolContent[],
    };
  }

  // One-shot: search + batch-preflight + rank, so the agent makes ONE call instead of
  // hand-looping marketplace_search + asset_preflight_insert (the round-trip churn the
  // round-5 eval flagged on asset-heavy builds). Plan-only: insert the recommended id
  // with the existing insert_asset.
  async planAssetInsert(keyword: string, category?: string, count?: number, instance_id?: string) {
    if (!keyword || !keyword.trim()) {
      throw new Error('keyword is required for plan_asset_insert');
    }
    const n = Math.min(Math.max(1, Math.floor(count ?? 5)), 10);
    let results;
    try {
      results = await this.marketplace.search({ keyword, category, limit: n });
    } catch (error) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: errorMessage(error) }) }] as ToolContent[] };
    }
    if (results.length === 0) {
      return { content: [{ type: 'text', text: JSON.stringify({
        keyword, category: category ?? 'Model', candidateCount: 0, candidates: [], recommended: [],
        hint: `No marketplace results for "${keyword}" — try a different keyword or category.`,
      }) }] as ToolContent[] };
    }
    // Authoritatively preflight each top candidate (reuses the canonical check, incl.
    // its error classification) and fold in the search-time metadata as risk flags.
    const candidates: Array<{
      assetId: number; name: string; searchRank: number; insertable: boolean;
      isFree?: boolean; hasScripts?: boolean; price?: number; warnings?: string[];
    }> = [];
    for (let rank = 0; rank < results.length; rank++) {
      const r = results[rank];
      let verdict: Record<string, unknown> = {};
      try {
        const pf = await this.worldTools.assetPreflightInsert(r.id, instance_id);
        const text = (pf?.content?.[0] as { text?: string } | undefined)?.text;
        if (typeof text === 'string') verdict = JSON.parse(text) as Record<string, unknown>;
      } catch { /* preflight failed -> leave insertability unknown */ }
      const insertable = verdict.insertabilityVerdict === 'yes';
      const warnings: string[] = [];
      if (r.hasScripts) warnings.push('contains scripts — review before trusting');
      if (r.isFree === false) warnings.push('not free — may fail LoadAsset with AUTH in Edit');
      if (!insertable && typeof verdict.error === 'string') warnings.push(verdict.error);
      candidates.push({
        assetId: r.id, name: r.name, searchRank: rank, insertable,
        isFree: r.isFree, hasScripts: r.hasScripts, price: r.price,
        ...(warnings.length ? { warnings } : {}),
      });
    }
    // Rank: insertable first, then free, then script-free, then original search order.
    const score = (c: { insertable: boolean; isFree?: boolean; hasScripts?: boolean }) =>
      (c.insertable ? 8 : 0) + (c.isFree ? 4 : 0) + (c.hasScripts ? 0 : 2);
    const ranked = [...candidates].sort((a, b) => score(b) - score(a) || a.searchRank - b.searchRank);
    const recommended = ranked.filter((c) => c.insertable).map((c) => c.assetId);
    return { content: [{ type: 'text', text: JSON.stringify({
      keyword, category: category ?? 'Model', candidateCount: ranked.length,
      candidates: ranked, recommended,
      hint: recommended.length
        ? `Insert the top pick with insert_asset (assetId ${recommended[0]}), or choose another from "recommended".`
        : 'No candidate passed the insertability preflight — try a different keyword (prefer free, copy-unlocked assets).',
    }) }] as ToolContent[] };
  }

  // === Media tools (audio / animation / texture) ===

  async audioCreateSound(options: CreateSoundOptions, instance_id?: string) {
    if (!options?.parentPath || options?.soundId === undefined) throw new Error('parentPath and soundId are required for audio_create_sound');
    const result = await this._runGeneratedLuau(buildCreateSoundLuau(options), instance_id);
    this.safety.recordOperation({ kind: 'audio', summary: `sound ${options.soundId} under ${options.parentPath}` });
    return result;
  }

  async audioPlaySound(path: string, instance_id?: string) {
    if (!path) throw new Error('path is required for audio_play_sound');
    return this._runGeneratedLuau(buildPlaySoundLuau({ path }), instance_id);
  }

  async animationCreate(options: CreateAnimationOptions, instance_id?: string) {
    if (!options?.parentPath || options?.animationId === undefined) throw new Error('parentPath and animationId are required for animation_create');
    const result = await this._runGeneratedLuau(buildCreateAnimationLuau(options), instance_id);
    this.safety.recordOperation({ kind: 'animation', summary: `animation ${options.animationId} under ${options.parentPath}` });
    return result;
  }

  async animationPlay(options: PlayAnimationOptions, instance_id?: string) {
    if (!options?.rigPath || options?.animationId === undefined) throw new Error('rigPath and animationId are required for animation_play');
    return this._runGeneratedLuau(buildPlayAnimationLuau(options), instance_id);
  }

  async generateModelNative(options: GenerateModelOptions, instance_id?: string) {
    if (!options?.prompt || !options.prompt.trim()) throw new Error('prompt is required for generate_model_native');
    const result = await this._runGeneratedLuau(buildGenerateModelLuau(options), instance_id);
    this.safety.recordOperation({ kind: 'generate_model', summary: `generated model "${options.prompt}" under ${options.parentPath ?? 'Workspace'}` });
    return result;
  }

  async designLint(options: DesignLintOptions = {}, instance_id?: string) {
    return this._runGeneratedLuau(buildDesignLintLuau(options), instance_id);
  }

  async uiComponentCatalog() {
    return { content: [{ type: 'text', text: JSON.stringify(getDesignCatalog()) }] as ToolContent[] };
  }

  async applyTheme(options: ApplyThemeOptions, instance_id?: string) {
    if (!options?.rootPath) throw new Error('rootPath is required for apply_theme');
    const result = await this._runGeneratedLuau(buildApplyThemeLuau(options), instance_id);
    this.safety.recordOperation({ kind: 'apply_theme', summary: `themed ${options.rootPath} (${options.theme ?? 'dark'})` });
    return result;
  }

  async designReview(options: { rootPath: string; instruction?: string; model?: string }, instance_id?: string) {
    if (!options?.rootPath) throw new Error('rootPath is required for design_review');
    if (!this.imageClient.hasApiKey()) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'POLLINATIONS_API_KEY is not set. Get a server-side sk_ key from https://enter.pollinations.ai and pass it via env or --pollinations-key.' }) }] as ToolContent[] };
    }
    // 1. Stage the ScreenGui under CoreGui so it renders to the editor viewport.
    const setup = await this._runGeneratedLuau(buildReviewReparentLuau(options.rootPath), instance_id);
    const setupRet = this._returnValueOf(setup) as { newPath?: string; origParentPath?: string } | null;
    const newPath = setupRet?.newPath;
    const origParentPath = setupRet?.origParentPath ?? 'StarterGui';
    if (!newPath) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'design_review could not stage the UI for capture — pass a ScreenGui path.', setup: setupRet }) }] as ToolContent[] };
    }
    try {
      // 2. Capture the viewport (now showing the UI overlay).
      const cap = await this.runtimeTools.captureScreenshot(instance_id, 'jpeg', 80);
      const img = cap.content.find((c) => c.type === 'image') as { data?: string; mimeType?: string } | undefined;
      if (!img?.data) {
        const errText = (cap.content.find((c) => c.type === 'text') as { text?: string } | undefined)?.text;
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Screenshot capture failed', detail: errText }) }] as ToolContent[] };
      }
      // 3. Vision critique.
      const review = await this.imageClient.reviewImage(img.data, img.mimeType ?? 'image/jpeg', designReviewPrompt(options.instruction), { model: options.model });
      this.safety.recordOperation({ kind: 'design_review', summary: `reviewed ${options.rootPath}` });
      return { content: [{ type: 'text', text: JSON.stringify({ rootPath: options.rootPath, review }) }] as ToolContent[] };
    } finally {
      // 4. Always restore the original parent.
      await this._runGeneratedLuau(buildReviewRestoreLuau(newPath, origParentPath), instance_id);
    }
  }

  /** Extract the Luau `returnValue` table from a _runGeneratedLuau result. */
  private _returnValueOf(result: { content?: ToolContent[] }): unknown {
    const first = result.content?.[0];
    const text = first && 'text' in first ? (first as { text?: string }).text : undefined;
    if (!text) return null;
    try { return (JSON.parse(text) as { returnValue?: unknown }).returnValue ?? null; }
    catch { return null; }
  }

  // ─── Track A: provenance-first external asset ingest ─────────────────────
  // Reuses the proven Open Cloud uploadAsset path (asset:write). Brings an
  // external file/URL into the place AND records where it came from + its
  // license, so the asset is auditable and its attribution obligations are
  // tracked — the thing a free WEPPY-level tool needs before re-uploading
  // third-party content.

  async importExternalAsset(
    options: {
      source: string;
      assetType?: string;
      displayName?: string;
      license?: string;
      attribution?: string;
      sourceName?: string;
      parentPath?: string;
    },
    instance_id?: string,
  ) {
    if (!options?.source) throw new Error('source (URL or local file path) is required for import_external_asset');
    const assetType = options.assetType ?? 'Decal';

    // 1. Resolve the source to a local file (download URLs to a temp file).
    let filePath: string;
    let bytes: number;
    let cleanup = false;
    if (/^https?:\/\//i.test(options.source)) {
      let res: Response;
      try { res = await fetch(options.source); }
      catch (error) { return { content: [{ type: 'text', text: JSON.stringify({ error: `Download failed: ${errorMessage(error)}` }) }] as ToolContent[] }; }
      if (!res.ok) return { content: [{ type: 'text', text: JSON.stringify({ error: `Download failed: HTTP ${res.status} for ${options.source}` }) }] as ToolContent[] };
      const buf = Buffer.from(await res.arrayBuffer());
      const ext = path.extname(new URL(options.source).pathname) || '.bin';
      filePath = path.join(os.tmpdir(), `mcp-ext-${Date.now()}${ext}`);
      fs.writeFileSync(filePath, buf);
      bytes = buf.length;
      cleanup = true;
    } else {
      if (!fs.existsSync(options.source)) throw new Error(`File not found: ${options.source}`);
      filePath = options.source;
      bytes = fs.statSync(filePath).size;
    }

    // 2. Hash for provenance/dedup, then upload via the existing Open Cloud path.
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    let uploadRaw: { response?: { assetId?: string }; decalId?: string; imageId?: string } = {};
    try {
      const up = await this.uploadAsset(filePath, assetType, options.displayName ?? options.sourceName ?? path.basename(filePath));
      const text = (up.content?.find((c) => 'text' in c) as { text?: string } | undefined)?.text ?? '{}';
      uploadRaw = JSON.parse(text);
    } catch (error) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: errorMessage(error), hint: 'External import needs ROBLOX_OPEN_CLOUD_API_KEY (asset:write) + a creator id (ROBLOX_CREATOR_USER_ID / ROBLOX_CREATOR_GROUP_ID).' }) }] as ToolContent[] };
    } finally {
      if (cleanup) { try { fs.unlinkSync(filePath); } catch { /* temp already gone */ } }
    }

    const assetId = uploadRaw.response?.assetId ?? uploadRaw.decalId ?? uploadRaw.imageId ?? null;

    // 3. Record provenance.
    const record: ProvenanceRecord = {
      assetId: assetId ?? null,
      source: options.source,
      sourceName: options.sourceName,
      license: options.license,
      attribution: options.attribution,
      attributionRequired: requiresAttribution(options.license),
      assetType,
      sha256,
      bytes,
      importedAt: Date.now(),
    };
    if (assetId) this.provenance.set(String(assetId), record);

    // 4. Optionally drop it into the place.
    let inserted: unknown;
    if (assetId && options.parentPath) {
      try { inserted = await this.insertAsset(Number(assetId), options.parentPath, undefined, instance_id); }
      catch (error) { inserted = { error: errorMessage(error) }; }
    }

    return { content: [{ type: 'text', text: JSON.stringify({ assetId, provenance: record, upload: uploadRaw, inserted: inserted ?? null }) }] as ToolContent[] };
  }

  // Multi-provider CC0 asset discovery (Track A). Live search across free,
  // license-clean libraries returning one normalized descriptor shape; a result's
  // downloadUrl feeds straight into import_external_asset. Studio-agnostic (web only).
  async assetSourceSearch(
    query?: string,
    options?: { providers?: AssetSourceProvider[]; limit?: number },
  ) {
    const result = await searchAssetSources(query ?? '', options ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(result) }] as ToolContent[] };
  }

  async getAssetProvenance(assetId?: string) {
    if (assetId) {
      const rec = this.provenance.get(String(assetId)) ?? null;
      return { content: [{ type: 'text', text: JSON.stringify({ assetId, provenance: rec }) }] as ToolContent[] };
    }
    return { content: [{ type: 'text', text: JSON.stringify({ records: [...this.provenance.values()] }) }] as ToolContent[] };
  }

  async assetApplyTexture(options: ApplyTextureOptions, instance_id?: string) {
    if (!options?.targetPath || options?.assetId === undefined) throw new Error('targetPath and assetId are required for asset_apply_texture');
    const result = await this._runGeneratedLuau(buildApplyTextureLuau(options), instance_id);
    this.safety.recordOperation({ kind: 'texture', summary: `applied ${options.assetId} to ${options.targetPath}` });
    return result;
  }

  // === AI image generation (Pollinations) ===
  // Generates an image from a text prompt and saves it locally. To use it in
  // Roblox: upload it (image_generate_and_upload or upload_asset) to get an
  // asset id, then asset_apply_texture it. Requires POLLINATIONS_API_KEY.

  private async _generateImageToFile(prompt: string, options?: ImageGenOptions): Promise<{ file: string; bytes: number; model: string }> {
    const { buffer, contentType } = await this.imageClient.generate(prompt, options ?? {});
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
    if (!this.imageClient.hasApiKey()) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'POLLINATIONS_API_KEY is not set. Get a server-side sk_ key from https://enter.pollinations.ai and pass it via env or --pollinations-key.' }) }] as ToolContent[] };
    }
    try {
      const saved = await this._generateImageToFile(prompt, options);
      this.safety.recordOperation({ kind: 'image_generate', summary: `generated "${prompt}" → ${saved.file}` });
      return { content: [{ type: 'text', text: JSON.stringify({ prompt, ...saved, next: 'Upload with image_generate_and_upload or upload_asset, then asset_apply_texture.' }) }] as ToolContent[] };
    } catch (error) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: errorMessage(error) }) }] as ToolContent[] };
    }
  }

  async imageGenerateAndUpload(prompt: string, options?: ImageGenOptions, assetType?: string, displayName?: string) {
    if (!prompt || !prompt.trim()) throw new Error('prompt is required for image_generate_and_upload');
    if (!this.imageClient.hasApiKey()) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'POLLINATIONS_API_KEY is not set. Get a server-side sk_ key from https://enter.pollinations.ai.' }) }] as ToolContent[] };
    }
    let saved;
    try {
      saved = await this._generateImageToFile(prompt, options);
    } catch (error) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: errorMessage(error) }) }] as ToolContent[] };
    }
    // Reuse the existing Roblox upload path (Open Cloud / cookie auth). It
    // returns a structured result with the new assetId once moderation clears.
    try {
      const upload = await this.uploadAsset(saved.file, assetType ?? 'Decal', displayName ?? prompt.slice(0, 50));
      this.safety.recordOperation({ kind: 'image_generate', summary: `generated + uploaded "${prompt}"` });
      const uploadText = (upload.content.find((c) => c.type === 'text') as { text?: string } | undefined)?.text ?? '{}';
      return { content: [{ type: 'text', text: JSON.stringify({ generated: saved, upload: JSON.parse(uploadText), next: 'Apply the returned assetId with asset_apply_texture.' }) }] as ToolContent[] };
    } catch (error) {
      return { content: [{ type: 'text', text: JSON.stringify({ generated: saved, uploadError: errorMessage(error), hint: 'Image saved locally; set ROBLOX_OPEN_CLOUD_API_KEY (asset:write) or ROBLOSECURITY to upload, or upload the file manually in Studio.' }) }] as ToolContent[] };
    }
  }

  // === Diagnostics ("fix all script errors") ===

  async diagnoseScripts(maxEntries?: number, instance_id?: string) { return this.scriptTools.diagnoseScripts(maxEntries, instance_id); }

  // Decal asset IDs are the wrapper asset; ImageLabel.Image needs the underlying image
  // content ID. The only reliable cross-auth way to resolve this is InsertService:LoadAsset
  // via the connected Studio plugin - the unauthenticated economy endpoint returns 401.
  private async resolveImageId(decalAssetId: string): Promise<string | null> {
    const code = `
      local InsertService = game:GetService("InsertService")
      local ok, result = pcall(function() return InsertService:LoadAsset(${decalAssetId}) end)
      if not ok then return nil end
      local decal = result:FindFirstChildWhichIsA("Decal", true)
      local id = decal and decal.Texture:match("(%d+)") or nil
      result:Destroy()
      return id
    `;
    try {
      const response = await this._callSingle('/api/execute-luau', { code }, 'edit', undefined) as { returnValue?: unknown };
      const returnValue = response?.returnValue;
      if (returnValue !== undefined && returnValue !== null && /^\d+$/.test(String(returnValue))) {
        return String(returnValue);
      }
    } catch {
      // plugin not connected or luau execution failed
    }
    return null;
  }

  async uploadAsset(
    filePath: string,
    assetType: string,
    displayName: string,
    description?: string,
    userId?: string,
    groupId?: string
  ) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const fileContent = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);

    if (assetType === 'Decal' && this.cookieClient.hasCookie()) {
      const result = await this.cookieClient.uploadDecal(fileContent, displayName, description || '');
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            done: true,
            response: {
              assetId: String(result.assetId),
              displayName,
              assetType,
              decalId: String(result.assetId),
              imageId: String(result.backingAssetId),
            },
          })
        }]
      };
    }

    if (!this.openCloudClient.hasApiKey()) {
      const cookieHint = assetType === 'Decal'
        ? ' Alternatively, set ROBLOSECURITY to use cookie auth.'
        : '';
      throw new Error(
        `No auth configured for ${assetType} upload. Set ROBLOX_OPEN_CLOUD_API_KEY (needs asset:write scope).${cookieHint}`
      );
    }

    const resolvedGroupId = groupId || process.env.ROBLOX_CREATOR_GROUP_ID;
    const resolvedUserId = userId || process.env.ROBLOX_CREATOR_USER_ID;

    if (!resolvedUserId && !resolvedGroupId) {
      throw new Error(
        'Creator identity required for Open Cloud upload. Set ROBLOX_CREATOR_USER_ID or ROBLOX_CREATOR_GROUP_ID, or pass userId/groupId as parameters.'
      );
    }

    const creator: { userId?: string; groupId?: string } = {};
    if (resolvedGroupId) {
      creator.groupId = resolvedGroupId;
    } else {
      creator.userId = resolvedUserId;
    }

    const result = await this.openCloudClient.createAsset(
      {
        assetType: assetType as 'Audio' | 'Decal' | 'Model' | 'Animation' | 'Video',
        displayName,
        description: description || '',
        creationContext: { creator },
      },
      fileContent,
      fileName
    );

    // Decals: also resolve the underlying image content ID for ImageLabel.Image usage.
    if (assetType === 'Decal') {
      const decalId = result.response?.assetId;
      const imageId = decalId ? await this.resolveImageId(decalId) : null;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ...result,
            decalId: decalId ?? null,
            imageId,
          })
        }]
      };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result)
      }]
    };
  }

  async simulateMouseInput(action: string, x: number, y: number, button?: string, scrollDirection?: string, target?: string, instance_id?: string) { return this.runtimeTools.simulateMouseInput(action, x, y, button, scrollDirection, target, instance_id); }

  async simulateKeyboardInput(keyCode?: string, action?: string, duration?: number, text?: string, target?: string, instance_id?: string) { return this.runtimeTools.simulateKeyboardInput(keyCode, action, duration, text, target, instance_id); }

  async characterNavigation(position?: number[], instancePath?: string, waitForCompletion?: boolean, timeout?: number, target?: string, instance_id?: string) { return this.runtimeTools.characterNavigation(position, instancePath, waitForCompletion, timeout, target, instance_id); }

  async cloneObject(instancePath: string, targetParentPath: string, instance_id?: string) { return this.mutationTools.cloneObject(instancePath, targetParentPath, instance_id); }

  async getDescendants(
    instancePath: string,
    maxDepth?: number,
    classFilter?: string,
    limit?: number,
    offset?: number,
    fields?: string[],
    instance_id?: string,
  ) { return this.sceneReadTools.getDescendants(instancePath, maxDepth, classFilter, limit, offset, fields, instance_id); }

  async getSceneSummary(instancePath?: string, topN?: number, instance_id?: string) { return this.sceneReadTools.getSceneSummary(instancePath, topN, instance_id); }

  async applyMutationPlan(operations: MutationOp[], dryRun?: boolean, confirm?: boolean, instance_id?: string) { return this.mutationTools.applyMutationPlan(operations, dryRun, confirm, instance_id); }

  // Recipes: proven idempotent build macros. list is pure; apply runs the recipe's
  // Luau (creates/replaces named instances).
  async listRecipes() {
    return { content: [{ type: 'text', text: JSON.stringify({ recipes: listRecipes() }) }] as ToolContent[] };
  }

  async applyRecipe(recipe: string, params?: Record<string, unknown>, instance_id?: string) {
    if (!recipe) throw new Error('recipe is required for apply_recipe (see list_recipes)');
    const code = buildRecipeLuau(recipe, params ?? {});
    const response = await this._callSingle('/api/execute-luau', { code }, 'edit', instance_id);
    const result = wrapToolJsonText(normalizeExecuteLuauToolResult(response, {
      recipe,
      error: 'apply_recipe returned non-object execute-luau output',
    })) as { content: ToolContent[] };
    this.safety.recordOperation({ kind: 'bulk_create', summary: `applied recipe ${recipe}` });
    return result;
  }

  // Live playtest telemetry + gameplay assertions live in RuntimeTools; the facade delegates.
  async playtestSampleState(domains?: TelemetryDomain[], target?: string, instance_id?: string) { return this.runtimeTools.playtestSampleState(domains, target, instance_id); }

  async runGameplayAssertions(assertions: GameplayAssertion[], target?: string, instance_id?: string) { return this.runtimeTools.runGameplayAssertions(assertions, target, instance_id); }

  async runPlaytestEpisode(mode?: string, assertions?: GameplayAssertion[], sampleDomains?: TelemetryDomain[], durationS?: number, instance_id?: string) { return this.runtimeTools.runPlaytestEpisode(mode ?? 'play', assertions, sampleDomains, durationS, instance_id); }

  async summarizeEpisode(episodeId: string, comparedToEpisodeId?: string) { return this.runtimeTools.summarizeEpisode(episodeId, comparedToEpisodeId); }

  async proposeNextAction(episodeId?: string) { return this.runtimeTools.proposeNextAction(episodeId); }

  // Episode resource-plane readers (roblox://playtest/...), not tools.
  getEpisode(episodeId: string) { return this.runtimeTools.getEpisode(episodeId); }
  listEpisodes() { return this.runtimeTools.listEpisodes(); }

  // A point-in-time reproduction/audit bundle: connected places, world overview,
  // recent mutating operations, and playtest episodes — one call to capture "what
  // state is this and how did it get here". Also readable at roblox://repro/bundle.
  // Track G2. ponytail: composes existing readers; no new persistence.
  async getReproductionBundle(instance_id?: string) {
    const parse = (r: { content?: ReadonlyArray<unknown> }): unknown => {
      try {
        const t = (r?.content?.[0] as { text?: string } | undefined)?.text;
        return typeof t === 'string' ? JSON.parse(t) : {};
      } catch { return {}; }
    };
    const [snapshot, recentOperations, instances, episodes] = await Promise.all([
      this.getWorldSnapshot(undefined, 'overview', undefined, instance_id).then(parse).catch(() => ({})),
      Promise.resolve(this.getOperationHistory(25)).then(parse).catch(() => ({})),
      Promise.resolve(this.getConnectedInstances()).then(parse).catch(() => ({})),
      Promise.resolve(this.listEpisodes()).then(parse).catch(() => ({})),
    ]);
    return { content: [{ type: 'text', text: JSON.stringify({
      generatedAt: new Date().toISOString(),
      instances, snapshot, recentOperations, episodes,
      hint: 'Point-in-time bundle to reproduce/audit current state. Re-read at roblox://repro/bundle; pair with get_changes_since for before/after deltas.',
    }) }] as ToolContent[] };
  }

  // Discovery + world-model tools live in their own domain classes; the facade
  // delegates so the public tool surface (names + signatures, incl. instance_id)
  // stays identical.
  async loadToolset(body: { toolsets?: string[] }) { return this.discoveryTools.loadToolset(body); }
  async toolCatalogSearch(body: { query: string; domains?: ToolDomain[]; readOnly?: boolean; limit?: number }) { return this.discoveryTools.toolCatalogSearch(body); }

  async getWorldSnapshot(path?: string, level?: SnapshotLevel, topNPerClass?: number, instance_id?: string) { return this.worldTools.getWorldSnapshot(path, level, topNPerClass, instance_id); }
  async sceneSearch(query: string, path?: string, limit?: number, instance_id?: string) { return this.worldTools.sceneSearch(query, path, limit, instance_id); }
  async getNodeBatch(paths: string[], fields?: string[], includeChildrenCount?: boolean, instance_id?: string) { return this.worldTools.getNodeBatch(paths, fields, includeChildrenCount, instance_id); }
  async getChangesSince(snapshotId?: string, path?: string, instance_id?: string) { return this.worldTools.getChangesSince(snapshotId, path, instance_id); }
  async assetPreflightInsert(assetId: number, instance_id?: string) { return this.worldTools.assetPreflightInsert(assetId, instance_id); }

  async compareInstances(instancePathA: string, instancePathB: string, instance_id?: string) { return this.sceneReadTools.compareInstances(instancePathA, instancePathB, instance_id); }

  async bulkSetAttributes(instancePath: string, attributes: Record<string, unknown>, instance_id?: string) { return this.mutationTools.bulkSetAttributes(instancePath, attributes, instance_id); }

  async findAndReplaceInScripts(
    pattern: string,
    replacement: string,
    options?: {
      caseSensitive?: boolean;
      usePattern?: boolean;
      path?: string;
      classFilter?: string;
      dryRun?: boolean;
      maxReplacements?: number;
    },
    instance_id?: string
  ) { return this.scriptTools.findAndReplaceInScripts(pattern, replacement, options, instance_id); }

  async getMemoryBreakdown(target?: string, tags?: string[], instance_id?: string) { return this.sceneReadTools.getMemoryBreakdown(target, tags, instance_id); }

  async getSceneAnalysis(mode?: string, target?: string, topN?: number, raw?: boolean, instance_id?: string) { return this.sceneReadTools.getSceneAnalysis(mode, target, topN, raw, instance_id); }

  async exportRbxm(instancePaths: string[], outputPath: string, target?: string, instance_id?: string) {
    if (!Array.isArray(instancePaths) || instancePaths.length === 0) {
      throw new Error('instance_paths must be a non-empty array for export_rbxm');
    }
    if (!outputPath || typeof outputPath !== 'string') {
      throw new Error('output_path is required for export_rbxm');
    }
    const tgt = target || 'edit';
    if (tgt !== 'edit' && tgt !== 'server') {
      throw new Error(`export_rbxm target must be "edit" or "server" (got: ${tgt})`);
    }

    const response = await this._callSingle(
      '/api/export-rbxm',
      { instance_paths: instancePaths },
      tgt,
      instance_id,
    ) as { error?: string; base64?: string; instance_count?: number };

    if (response.error) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: response.error }) }] };
    }
    if (!response.base64) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'plugin returned no base64 payload' }) }] };
    }

    const bytes = Buffer.from(response.base64, 'base64');
    const resolved = path.resolve(outputPath);
    try {
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, bytes);
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `failed to write ${resolved}: ${(err as Error).message}` }) }] };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          bytes_written: bytes.length,
          instance_count: response.instance_count ?? instancePaths.length,
          output_path: resolved,
        }),
      }],
    };
  }

  async importRbxm(
    source: { path?: string; url?: string; base64?: string } | undefined,
    parentPath: string,
    target?: string,
    instance_id?: string
  ) {
    if (!source || typeof source !== 'object') {
      throw new Error('source is required for import_rbxm');
    }
    if (!parentPath || typeof parentPath !== 'string') {
      throw new Error('parent_path is required for import_rbxm');
    }
    const tgt = target || 'edit';
    if (tgt !== 'edit' && tgt !== 'server') {
      throw new Error(`import_rbxm target must be "edit" or "server" (got: ${tgt})`);
    }

    const modes = ['path', 'url', 'base64'].filter((k) => (source as Record<string, unknown>)[k] !== undefined);
    if (modes.length !== 1) {
      throw new Error(`source must contain exactly one of { path, url, base64 } (got: ${modes.join(', ') || 'none'})`);
    }

    let bytes: Buffer;
    let sourceLabel: string;
    if (source.path !== undefined) {
      const resolved = path.resolve(source.path);
      try {
        bytes = fs.readFileSync(resolved);
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `failed to read ${resolved}: ${(err as Error).message}` }) }] };
      }
      sourceLabel = resolved;
    } else if (source.url !== undefined) {
      // SSRF guard: only http(s). Blocks file://, ftp://, gopher://, etc.
      // Does NOT block requests to internal IPs (127.0.0.1, 169.254.x, RFC1918) —
      // a local MCP server has legitimate reasons to hit localhost, so internal-IP
      // blocking should be opt-in if needed.
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(source.url);
      } catch {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `import_rbxm url is not a valid URL: ${source.url}` }) }] };
      }
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `import_rbxm url must use http(s); got ${parsedUrl.protocol}` }) }] };
      }

      // 50 MiB matches the project's existing express.json('50mb') cap and is
      // empirically well within the Studio plugin's HttpService:RequestAsync
      // response ceiling (probed up to 100 MiB without issue, 150+ stalls on
      // Studio memory, not protocol). Far above any realistic rbxm size.
      const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
      try {
        const res = await fetch(source.url);
        if (!res.ok) {
          const snippet = (await res.text()).slice(0, 500);
          return { content: [{ type: 'text', text: JSON.stringify({ error: `fetch ${source.url} returned ${res.status}: ${snippet}` }) }] };
        }
        const claimed = Number(res.headers.get('content-length') ?? '0');
        if (claimed > MAX_IMPORT_BYTES) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: `fetch ${source.url}: content-length ${claimed} exceeds ${MAX_IMPORT_BYTES} byte cap` }) }] };
        }
        const arr = await res.arrayBuffer();
        if (arr.byteLength > MAX_IMPORT_BYTES) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: `fetch ${source.url}: downloaded ${arr.byteLength} bytes exceeds ${MAX_IMPORT_BYTES} byte cap` }) }] };
        }
        bytes = Buffer.from(arr);
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `fetch ${source.url} failed: ${(err as Error).message}` }) }] };
      }
      sourceLabel = source.url;
    } else {
      try {
        bytes = Buffer.from(source.base64 as string, 'base64');
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `base64 decode failed: ${(err as Error).message}` }) }] };
      }
      sourceLabel = `base64(${bytes.length}B)`;
    }

    const response = await this._callSingle(
      '/api/import-rbxm',
      {
        base64: bytes.toString('base64'),
        parent_path: parentPath,
        source_label: sourceLabel,
      },
      tgt,
      instance_id,
    );

    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }

  async captureScreenshot(instance_id?: string, format?: string, quality?: number) { return this.runtimeTools.captureScreenshot(instance_id, format, quality); }
}
