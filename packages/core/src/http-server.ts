import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { RobloxStudioTools } from './tools/index.js';
import { BridgeService, RoutingFailure, toPublic } from './bridge-service.js';
import type { RegisterInstanceResult } from './bridge-service.js';
import type { ToolDefinition } from './tools/definitions.js';
import { ToolRegistry } from './tools/tool-pipeline.js';
import { toolDefinitionToMcpTool } from './tools/tool-shape.js';
import { toolErrorResult } from './errors.js';
import { attachStructuredContent } from './tools/structured-output.js';
import { SERVER_INSTRUCTIONS } from './server-instructions.js';
import { RESOURCE_LIST, RESOURCE_TEMPLATES, readResource } from './resources.js';

interface StreamableHttpConfig {
  name: string;
  version: string;
  tools: ToolDefinition[];
}

export type ToolHandler = (tools: RobloxStudioTools, body: any) => Promise<any>;

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  tool_catalog_search: (tools, body) => tools.toolCatalogSearch(body),
  load_toolset: (tools, body) => tools.loadToolset(body),
  get_world_snapshot: (tools, body) => tools.getWorldSnapshot(body.path, body.level, body.topNPerClass, body.instance_id),
  get_node_batch: (tools, body) => tools.getNodeBatch(body.paths, body.fields, body.includeChildrenCount, body.instance_id),
  get_changes_since: (tools, body) => tools.getChangesSince(body.snapshotId, body.path, body.instance_id),
  scene_search: (tools, body) => tools.sceneSearch(body.query, body.path, body.limit, body.instance_id),
  playtest_sample_state: (tools, body) => tools.playtestSampleState(body.domains, body.target, body.instance_id),
  apply_mutation_plan: (tools, body) => tools.applyMutationPlan(body.operations, body.dryRun, body.confirm, body.instance_id),
  list_recipes: (tools) => tools.listRecipes(),
  apply_recipe: (tools, body) => tools.applyRecipe(body.recipe, body.params, body.instance_id),
  run_gameplay_assertions: (tools, body) => tools.runGameplayAssertions(body.assertions, body.target, body.instance_id),
  run_playtest_episode: (tools, body) => tools.runPlaytestEpisode(body.mode, body.assertions, body.sampleDomains, body.durationS, body.instance_id),
  summarize_episode: (tools, body) => tools.summarizeEpisode(body.episodeId, body.comparedToEpisodeId),
  propose_next_action: (tools, body) => tools.proposeNextAction(body.episodeId),
  get_reproduction_bundle: (tools, body) => tools.getReproductionBundle(body.instance_id),
  asset_preflight_insert: (tools, body) => tools.assetPreflightInsert(body.assetId, body.instance_id),
  execute_luau_async: (tools, body) => tools.executeLuauAsync(body.code, body.target, body.instance_id, { dryRun: body.dryRun, confirm: body.confirm }),
  get_job_status: (tools, body) => tools.getJobStatus(body.jobId, body.target, body.instance_id),
  get_job_result: (tools, body) => tools.getJobResult(body.jobId, body.target, body.instance_id),
  cancel_job: (tools, body) => tools.cancelJob(body.jobId, body.target, body.instance_id),
  get_file_tree: (tools, body) => tools.getFileTree(body.path, body.instance_id),
  search_files: (tools, body) => tools.searchFiles(body.query, body.searchType, body.instance_id),
  get_place_info: (tools, body) => tools.getPlaceInfo(body.instance_id),
  get_services: (tools, body) => tools.getServices(body.serviceName, body.instance_id),
  search_objects: (tools, body) => tools.searchObjects(body.query, body.searchType, body.propertyName, body.limit, body.offset, body.fields, body.instance_id),
  get_instance_properties: (tools, body) => tools.getInstanceProperties(body.instancePath, body.excludeSource, body.instance_id),
  get_instance_children: (tools, body) => tools.getInstanceChildren(body.instancePath, body.instance_id),
  search_by_property: (tools, body) => tools.searchByProperty(body.propertyName, body.propertyValue, body.instance_id),
  get_class_info: (tools, body) => tools.getClassInfo(body.className, body.instance_id),
  get_project_structure: (tools, body) => tools.getProjectStructure(body.path, body.maxDepth, body.scriptsOnly, body.instance_id),
  set_property: (tools, body) => tools.setProperty(body.instancePath, body.propertyName, body.propertyValue, body.instance_id),
  set_properties: (tools, body) => tools.setProperties(body.instancePath, body.properties, body.instance_id),
  mass_set_property: (tools, body) => tools.massSetProperty(body.paths, body.propertyName, body.propertyValue, body.instance_id),
  mass_get_property: (tools, body) => tools.massGetProperty(body.paths, body.propertyName, body.instance_id),
  create_object: (tools, body) => tools.createObject(body.className, body.parent, body.name, body.properties, body.instance_id),
  mass_create_objects: (tools, body) => tools.massCreateObjects(body.objects, body.instance_id, { dryRun: body.dryRun, confirm: body.confirm }),
  delete_object: (tools, body) => tools.deleteObject(body.instancePath, body.instance_id, { dryRun: body.dryRun, confirm: body.confirm }),
  smart_duplicate: (tools, body) => tools.smartDuplicate(body.instancePath, body.count, body.options, body.instance_id),
  mass_duplicate: (tools, body) => tools.massDuplicate(body.duplications, body.instance_id),
  grep_scripts: (tools, body) => tools.grepScripts(body.pattern, {
    caseSensitive: body.caseSensitive,
    usePattern: body.usePattern,
    contextLines: body.contextLines,
    maxResults: body.maxResults,
    maxResultsPerScript: body.maxResultsPerScript,
    filesOnly: body.filesOnly,
    path: body.path,
    classFilter: body.classFilter,
  }, body.instance_id),
  get_script_source: (tools, body) => tools.getScriptSource(body.instancePath, body.startLine, body.endLine, body.instance_id),
  set_script_source: (tools, body) => tools.setScriptSource(body.instancePath, body.source, body.instance_id, { dryRun: body.dryRun, confirm: body.confirm }),
  restore_script_backup: (tools, body) => tools.restoreScriptBackup(body.instancePath, body.instance_id),
  list_script_backups: (tools) => tools.listScriptBackups(),
  get_operation_history: (tools, body) => tools.getOperationHistory(body.limit),
  edit_script_lines: (tools, body) => tools.editScriptLines(body.instancePath, body.old_string, body.new_string, body.startLine, body.instance_id),
  insert_script_lines: (tools, body) => tools.insertScriptLines(body.instancePath, body.afterLine, body.newContent, body.instance_id),
  delete_script_lines: (tools, body) => tools.deleteScriptLines(body.instancePath, body.startLine, body.endLine, body.instance_id),
  set_attribute: (tools, body) => tools.setAttribute(body.instancePath, body.attributeName, body.attributeValue, body.valueType, body.instance_id),
  get_attributes: (tools, body) => tools.getAttributes(body.instancePath, body.instance_id),
  delete_attribute: (tools, body) => tools.deleteAttribute(body.instancePath, body.attributeName, body.instance_id),
  get_tags: (tools, body) => tools.getTags(body.instancePath, body.instance_id),
  add_tag: (tools, body) => tools.addTag(body.instancePath, body.tagName, body.instance_id),
  remove_tag: (tools, body) => tools.removeTag(body.instancePath, body.tagName, body.instance_id),
  get_tagged: (tools, body) => tools.getTagged(body.tagName, body.instance_id),
  get_selection: (tools, body) => tools.getSelection(body.instance_id),
  execute_luau: (tools, body) => tools.executeLuau(body.code, body.target, body.instance_id, { dryRun: body.dryRun, confirm: body.confirm }),
  eval_server_runtime: (tools, body) => tools.evalServerRuntime(body.code, body.instance_id),
  eval_client_runtime: (tools, body) => tools.evalClientRuntime(body.code, body.target, body.instance_id),
  set_network_profile: (tools, body) => tools.setNetworkProfile(body.profile, body.target, body.overrides, body.instance_id),
  get_simulation_state: (tools, body) => tools.getSimulationState(body.include, body.target, body.instance_id),
  reset_simulation_state: (tools, body) => tools.resetSimulationState(body.target, body.network, body.deviceSimulator, body.instance_id),
  get_device_simulator_state: (tools, body) => tools.getDeviceSimulatorState(body.target, body.deviceId, body.includeDeviceList, body.instance_id),
  set_device_simulator: (tools, body) => tools.setDeviceSimulator(body.target, body.deviceId, body.orientation, body.resolution, body.pixelDensity, body.scalingMode, body.stopSimulation, body.instance_id),
  capture_device_matrix: (tools, body) => tools.captureDeviceMatrix(body.entries, body.target, body.format, body.quality, body.settleSeconds, body.restoreAfter, body.instance_id),
  start_playtest: (tools, body) => tools.startPlaytest(body.mode, body.numPlayers, body.instance_id),
  stop_playtest: (tools, body) => tools.stopPlaytest(body.instance_id),
  multiplayer_test_start: (tools, body) => tools.multiplayerTestStart(body.numPlayers, body.testArgs, body.timeout, body.instance_id),
  multiplayer_test_state: (tools, body) => tools.multiplayerTestState(body.instance_id),
  multiplayer_test_add_players: (tools, body) => tools.multiplayerTestAddPlayers(body.numPlayers, body.timeout, body.instance_id),
  multiplayer_test_leave_client: (tools, body) => tools.multiplayerTestLeaveClient(body.target, body.timeout, body.instance_id),
  multiplayer_test_end: (tools, body) => tools.multiplayerTestEnd(body.value, body.timeout, body.instance_id),
  get_runtime_logs: (tools, body) => tools.getRuntimeLogs(body.target, body.since, body.tail, body.filter, body.instance_id),
  capture_script_profiler: (tools, body) => tools.captureScriptProfiler(body.target, {
    duration_ms: body.duration_ms,
    frequency: body.frequency,
    max_functions: body.max_functions,
    min_total_us: body.min_total_us,
    filter: body.filter,
    include_native: body.include_native,
    include_plugin: body.include_plugin,
    output_path: body.output_path,
  }, body.instance_id),
  breakpoints: (tools, body) => tools.breakpoints(body.action, body, body.target, body.instance_id),
  get_connected_instances: (tools) => tools.getConnectedInstances(),
  export_build: (tools, body) => tools.exportBuild(body.instancePath, body.outputId, body.style, body.instance_id),
  create_build: (tools, body) => tools.createBuild(body.id, body.style, body.palette, body.parts, body.bounds),
  generate_build: (tools, body) => tools.generateBuild(body.id, body.style, body.palette, body.code, body.seed),
  import_build: (tools, body) => tools.importBuild(body.buildData, body.targetPath, body.position, body.instance_id),
  list_library: (tools, body) => tools.listLibrary(body.style),
  search_materials: (tools, body) => tools.searchMaterials(body.query, body.maxResults, body.instance_id),
  get_build: (tools, body) => tools.getBuild(body.id),
  import_scene: (tools, body) => tools.importScene(body.sceneData, body.targetPath, body.instance_id),
  undo: (tools, body) => tools.undo(body.instance_id),
  redo: (tools, body) => tools.redo(body.instance_id),
  search_assets: (tools, body) => tools.searchAssets(body.assetType, body.query, body.maxResults, body.sortBy, body.verifiedCreatorsOnly),
  get_asset_details: (tools, body) => tools.getAssetDetails(body.assetId),
  get_asset_thumbnail: (tools, body) => tools.getAssetThumbnail(body.assetId, body.size),
  insert_asset: (tools, body) => tools.insertAsset(body.assetId, body.parentPath, body.position, body.instance_id),
  preview_asset: (tools, body) => tools.previewAsset(body.assetId, body.includeProperties, body.maxDepth, body.instance_id),
  upload_asset: (tools, body) => tools.uploadAsset(body.filePath, body.assetType, body.displayName, body.description, body.userId, body.groupId),
  asset_source_search: (tools, body) => tools.assetSourceSearch(body.query, { providers: body.providers, limit: body.limit }),
  import_external_asset: (tools, body) => tools.importExternalAsset(body, body.instance_id),
  get_asset_provenance: (tools, body) => tools.getAssetProvenance(body.assetId),
  clone_object: (tools, body) => tools.cloneObject(body.instancePath, body.targetParentPath, body.instance_id),
  get_descendants: (tools, body) => tools.getDescendants(body.instancePath, body.maxDepth, body.classFilter, body.limit, body.offset, body.fields, body.instance_id),
  compare_instances: (tools, body) => tools.compareInstances(body.instancePathA, body.instancePathB, body.instance_id),
  bulk_set_attributes: (tools, body) => tools.bulkSetAttributes(body.instancePath, body.attributes, body.instance_id),
  capture_screenshot: (tools, body) => tools.captureScreenshot(body.instance_id, body.format, body.quality),
  simulate_mouse_input: (tools, body) => tools.simulateMouseInput(body.action, body.x, body.y, body.button, body.scrollDirection, body.target, body.instance_id),
  simulate_keyboard_input: (tools, body) => tools.simulateKeyboardInput(body.keyCode, body.action, body.duration, body.text, body.target, body.instance_id),
  character_navigation: (tools, body) => tools.characterNavigation(body.position, body.instancePath, body.waitForCompletion, body.timeout, body.target, body.instance_id),
  get_memory_breakdown: (tools, body) => tools.getMemoryBreakdown(body.target, body.tags, body.instance_id),
  get_scene_analysis: (tools, body) => tools.getSceneAnalysis(body.mode, body.target, body.topN, body.raw, body.instance_id),
  get_scene_summary: (tools, body) => tools.getSceneSummary(body.instancePath, body.topN, body.instance_id),
  export_rbxm: (tools, body) => tools.exportRbxm(body.instance_paths, body.output_path, body.target, body.instance_id),
  import_rbxm: (tools, body) => tools.importRbxm(body.source, body.parent_path, body.target, body.instance_id),
  find_and_replace_in_scripts: (tools, body) => tools.findAndReplaceInScripts(body.pattern, body.replacement, {
    caseSensitive: body.caseSensitive,
    usePattern: body.usePattern,
    path: body.path,
    classFilter: body.classFilter,
    dryRun: body.dryRun,
    maxReplacements: body.maxReplacements,
  }, body.instance_id),

  // UI builder tools — body doubles as the options object.
  ui_create_screen_gui: (tools, body) => tools.uiCreateScreenGui(body, body.instance_id),
  ui_create_frame: (tools, body) => tools.uiCreateFrame(body, body.instance_id),
  ui_create_text_label: (tools, body) => tools.uiCreateTextLabel(body, body.instance_id),
  ui_create_text_button: (tools, body) => tools.uiCreateTextButton(body, body.instance_id),
  ui_create_image_label: (tools, body) => tools.uiCreateImageLabel(body, body.instance_id),
  ui_create_image_button: (tools, body) => tools.uiCreateImageButton(body, body.instance_id),
  ui_apply_layout: (tools, body) => tools.uiApplyLayout(body, body.instance_id),
  ui_make_mobile_friendly: (tools, body) => tools.uiMakeMobileFriendly(body.targetPath, body.instance_id),

  // Environment tools.
  environment_set_time_of_day: (tools, body) => tools.environmentSetTimeOfDay(body.time, body.instance_id),
  environment_set_lighting_preset: (tools, body) => tools.environmentSetLightingPreset(body.preset, body.withPostFx, body.instance_id),
  environment_set_atmosphere: (tools, body) => tools.environmentSetAtmosphere(body, body.instance_id),
  environment_set_sky: (tools, body) => tools.environmentSetSky(body, body.instance_id),
  environment_create_day_night_cycle_script: (tools, body) => tools.environmentCreateDayNightCycleScript(body, body.instance_id),

  // Terrain tools — body doubles as the options object (incl. dryRun/confirm).
  terrain_generate_baseplate: (tools, body) => tools.terrainGenerateBaseplate(body, body.instance_id),
  terrain_generate_island: (tools, body) => tools.terrainGenerateIsland(body, body.instance_id),
  terrain_generate_mountains: (tools, body) => tools.terrainGenerateMountains(body, body.instance_id),
  terrain_generate_water: (tools, body) => tools.terrainGenerateWater(body, body.instance_id),
  terrain_paint_material: (tools, body) => tools.terrainPaintMaterial(body, body.instance_id),
  terrain_clear_region: (tools, body) => tools.terrainClearRegion(body, body.instance_id),

  // Game templates — body doubles as the options object.
  template_create_obby_game: (tools, body) => tools.templateCreateObbyGame(body, body.instance_id),
  template_create_simulator_game: (tools, body) => tools.templateCreateSimulatorGame(body, body.instance_id),
  template_create_tycoon_game: (tools, body) => tools.templateCreateTycoonGame(body, body.instance_id),
  template_create_round_game: (tools, body) => tools.templateCreateRoundGame(body, body.instance_id),

  // Local sync.
  sync_pull: (tools, body) => tools.syncPull(body.syncDir, body.instance_id),
  sync_status: (tools, body) => tools.syncStatus(body.syncDir, body.instance_id),
  sync_push: (tools, body) => tools.syncPush(body.syncDir, body.instance_id, { dryRun: body.dryRun, confirm: body.confirm }),

  // Free marketplace (no Open Cloud key).
  marketplace_search: (tools, body) => tools.marketplaceSearch(body.keyword, body.category, body.limit, body.sortType),
  marketplace_search_and_insert: (tools, body) => tools.marketplaceSearchAndInsert(body.keyword, body.category, body.parentPath, body.position, body.instance_id),
  plan_asset_insert: (tools, body) => tools.planAssetInsert(body.keyword, body.category, body.count, body.instance_id),

  // Media (audio / animation / texture).
  audio_create_sound: (tools, body) => tools.audioCreateSound(body, body.instance_id),
  audio_play_sound: (tools, body) => tools.audioPlaySound(body.path, body.instance_id),
  animation_create: (tools, body) => tools.animationCreate(body, body.instance_id),
  animation_play: (tools, body) => tools.animationPlay(body, body.instance_id),
  asset_apply_texture: (tools, body) => tools.assetApplyTexture(body, body.instance_id),

  // Diagnostics.
  diagnose_scripts: (tools, body) => tools.diagnoseScripts(body.maxEntries, body.instance_id),

  // Native AI 3D model generation (GenerationService) — runs in the place.
  generate_model_native: (tools, body) => tools.generateModelNative(body, body.instance_id),

  // UI design quality (Track D).
  ui_component_catalog: (tools) => tools.uiComponentCatalog(),
  apply_theme: (tools, body) => tools.applyTheme(body, body.instance_id),
  design_lint: (tools, body) => tools.designLint(body, body.instance_id),
  design_review: (tools, body) => tools.designReview(body, body.instance_id),

  // AI image generation (Pollinations) — server-side, no Studio routing.
  image_generate: (tools, body) => tools.imageGenerate(body.prompt, body),
  image_generate_and_upload: (tools, body) => tools.imageGenerateAndUpload(body.prompt, body, body.assetType, body.displayName),
};

// Self-contained diagnostics page (no external assets) served at /dashboard.
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>robloxstudio-mcp dashboard</title>
<style>
  body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #14161c; color: #e6e6ea; margin: 0; padding: 24px; }
  h1 { font-size: 18px; margin: 0 0 16px; }
  .row { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
  .card { background: #1d2029; border: 1px solid #2a2e3a; border-radius: 8px; padding: 12px 16px; min-width: 160px; }
  .label { font-size: 11px; text-transform: uppercase; color: #8a8f9c; }
  .value { font-size: 18px; margin-top: 4px; }
  .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
  .ok { background: #4ade80; } .bad { background: #f87171; }
  button { background: #2a2e3a; color: #e6e6ea; border: 1px solid #3a3f4d; border-radius: 6px; padding: 8px 14px; cursor: pointer; font: inherit; }
  button:hover { background: #343a48; }
  pre { background: #1d2029; border: 1px solid #2a2e3a; border-radius: 8px; padding: 12px; overflow: auto; max-height: 50vh; white-space: pre-wrap; }
</style>
</head>
<body>
<h1>robloxstudio-mcp dashboard</h1>
<div class="row">
  <div class="card"><div class="label">Studio</div><div class="value" id="conn"><span class="dot bad"></span>—</div></div>
  <div class="card"><div class="label">Places connected</div><div class="value" id="count">—</div></div>
  <div class="card"><div class="label">Server version</div><div class="value" id="ver">—</div></div>
  <div class="card"><div class="label">Pending requests</div><div class="value" id="pending">—</div></div>
</div>
<div class="row">
  <button onclick="refresh()">Reconnect / Refresh</button>
  <button onclick="document.getElementById('ops').textContent=''">Clear logs</button>
  <button onclick="exportDiag()">Export diagnostics</button>
</div>
<div class="label">Recent operations</div>
<pre id="ops">loading…</pre>
<script>
let last = {};
async function refresh() {
  try {
    const r = await fetch('/dashboard/data');
    const d = await r.json();
    last = d;
    document.getElementById('conn').innerHTML = '<span class="dot ' + (d.pluginConnected ? 'ok' : 'bad') + '"></span>' + (d.pluginConnected ? 'Connected' : 'Disconnected');
    document.getElementById('count').textContent = d.instanceCount;
    document.getElementById('ver').textContent = d.serverVersion || '—';
    document.getElementById('pending').textContent = d.pendingRequests;
    document.getElementById('ops').textContent = d.operations || 'none';
  } catch (e) {
    document.getElementById('ops').textContent = 'Failed to reach server: ' + e;
  }
}
function exportDiag() {
  const blob = new Blob([JSON.stringify(last, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'robloxstudio-mcp-diagnostics.json';
  a.click();
}
refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>`;

export function createHttpServer(tools: RobloxStudioTools, bridge: BridgeService, allowedTools?: Set<string>, serverConfig?: StreamableHttpConfig, registry?: ToolRegistry) {
  const app = express();
  let mcpServerActive = false;
  let lastMCPActivity = 0;
  let mcpServerStartTime = 0;
  const proxyInstances = new Set<string>();
  const warnedVersionMismatches = new Set<string>();

  const setMCPServerActive = (active: boolean) => {
    mcpServerActive = active;
    if (active) {
      mcpServerStartTime = Date.now();
      lastMCPActivity = Date.now();
    } else {
      mcpServerStartTime = 0;
      lastMCPActivity = 0;
    }
  };

  const trackMCPActivity = () => {
    if (mcpServerActive) {
      lastMCPActivity = Date.now();
    }
  };

  const isMCPServerActive = () => {
    if (!mcpServerActive) return false;
    return (Date.now() - lastMCPActivity) < 30000;
  };

  const isPluginConnected = () => {
    return bridge.getInstances().length > 0;
  };

  app.use(cors());
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));


  app.get('/health', (req, res) => {
    const instances = bridge.getInstances();
    const publicInstances = instances.map(toPublic);
    res.json({
      status: 'ok',
      service: 'robloxstudio-mcp',
      version: serverConfig?.version,
      serverVersion: serverConfig?.version,
      pluginConnected: instances.length > 0,
      instanceCount: instances.length,
      instances: publicInstances,
      versionMismatch: publicInstances.some((inst) => inst.versionMismatch),
      mcpServerActive: isMCPServerActive(),
      uptime: mcpServerActive ? Date.now() - mcpServerStartTime : 0,
      pendingRequests: bridge.getPendingRequestCount(),
      proxyInstanceCount: proxyInstances.size,
      streamableHttp: !!serverConfig,
    });
  });


  app.post('/ready', (req, res) => {
    const {
      pluginSessionId,
      instanceId,
      role,
      placeId,
      placeName,
      dataModelName,
      isRunning,
      pluginVersion,
      pluginVariant,
    } = req.body;
    const requestContext = {
      instanceId: typeof instanceId === 'string' ? instanceId : undefined,
      role: typeof role === 'string' ? role : undefined,
      placeId: typeof placeId === 'number' ? placeId : undefined,
      placeName: typeof placeName === 'string' ? placeName : undefined,
      dataModelName: typeof dataModelName === 'string' ? dataModelName : undefined,
      isRunning: typeof isRunning === 'boolean' ? isRunning : undefined,
      pluginVersion: typeof pluginVersion === 'string' ? pluginVersion : undefined,
      pluginVariant: typeof pluginVariant === 'string' ? pluginVariant : undefined,
    };

    if (!pluginSessionId || !instanceId || !role) {
      const missingFields = [
        !pluginSessionId ? 'pluginSessionId' : undefined,
        !instanceId ? 'instanceId' : undefined,
        !role ? 'role' : undefined,
      ].filter((field): field is string => !!field);
      res.status(400).json({
        success: false,
        error: 'missing_ready_fields',
        message: `/ready missing required field(s): ${missingFields.join(', ')}`,
        missingFields,
        request: requestContext,
      });
      return;
    }

    let result: RegisterInstanceResult;
    try {
      result = bridge.registerInstance({
        pluginSessionId,
        instanceId,
        role,
        placeId: typeof placeId === 'number' ? placeId : 0,
        placeName: typeof placeName === 'string' ? placeName : '',
        dataModelName: typeof dataModelName === 'string' ? dataModelName : '',
        isRunning: !!isRunning,
        pluginVersion: typeof pluginVersion === 'string' ? pluginVersion : '',
        pluginVariant: typeof pluginVariant === 'string' ? pluginVariant : 'unknown',
        serverVersion: serverConfig?.version ?? '',
      });
    } catch (err) {
      res.status(500).json({
        success: false,
        error: 'ready_registration_exception',
        message: err instanceof Error ? err.message : String(err),
        request: requestContext,
      });
      return;
    }

    if (!result.ok) {
      res.status(409).json({
        success: false,
        error: result.error.code,
        message: result.error.message,
        request: requestContext,
        existing: result.error.existing,
      });
      return;
    }
    const registered = bridge.getInstanceBySessionId(pluginSessionId);
    if (registered?.versionMismatch && !warnedVersionMismatches.has(pluginSessionId)) {
      warnedVersionMismatches.add(pluginSessionId);
      console.error(
        `[version-mismatch] Studio plugin v${registered.pluginVersion} (${registered.pluginVariant}) ` +
        `does not match MCP server v${registered.serverVersion} for ${registered.instanceId}/${registered.role}`,
      );
    }

    res.json({
      success: true,
      assignedRole: result.assignedRole,
      instanceId: result.instanceId,
      serverVersion: serverConfig?.version,
      versionMismatch: registered?.versionMismatch ?? false,
    });
  });


  app.post('/disconnect', (req, res) => {
    const { pluginSessionId } = req.body;

    if (pluginSessionId) {
      bridge.unregisterInstance(pluginSessionId);
    }
    res.json({ success: true });
  });


  app.get('/status', (req, res) => {
    const instances = bridge.getInstances();
    const publicInstances = instances.map(toPublic);
    res.json({
      pluginConnected: instances.length > 0,
      instanceCount: instances.length,
      instances: publicInstances,
      serverVersion: serverConfig?.version,
      versionMismatch: publicInstances.some((inst) => inst.versionMismatch),
      mcpServerActive: isMCPServerActive(),
      lastMCPActivity,
      uptime: mcpServerActive ? Date.now() - mcpServerStartTime : 0
    });
  });


  // Minimal diagnostics dashboard. /dashboard serves a static page that polls
  // /dashboard/data for live connection state and recent safety-layer ops.
  app.get('/dashboard/data', async (_req, res) => {
    const instances = bridge.getInstances().map(toPublic);
    let operations = 'unavailable';
    try {
      const result = await tools.getOperationHistory(25);
      const node = result.content.find((c) => c.type === 'text') as { text?: string } | undefined;
      operations = node?.text ?? 'none';
    } catch {
      /* getOperationHistory is local and shouldn't throw, but never break the dashboard */
    }
    res.json({
      serverVersion: serverConfig?.version,
      pluginConnected: instances.length > 0,
      instanceCount: instances.length,
      instances,
      versionMismatch: instances.some((inst) => inst.versionMismatch),
      mcpServerActive: isMCPServerActive(),
      uptime: mcpServerActive ? Date.now() - mcpServerStartTime : 0,
      pendingRequests: bridge.getPendingRequestCount(),
      operations,
      generatedAt: new Date().toISOString(),
    });
  });

  app.get('/dashboard', (_req, res) => {
    res.type('html').send(DASHBOARD_HTML);
  });

  app.get('/instances', (req, res) => {
    // Includes the internal pluginSessionId so proxy-mode subprocesses can
    // reproduce the full PluginInstance shape (they need the session id for
    // local bookkeeping; not exposed via MCP tools).
    const instances = bridge.getInstances();
    res.json({
      instances,
      serverVersion: serverConfig?.version,
      versionMismatch: instances.some((inst) => inst.versionMismatch),
    });
  });


  app.get('/poll', (req, res) => {
    const pluginSessionId = req.query.pluginSessionId as string | undefined;

    if (pluginSessionId) {
      bridge.updateInstanceActivity(pluginSessionId);
    }

    let callerInstanceId: string | undefined;
    let callerRole: string | undefined;
    let knownInstance = false;
    let callerPluginVersion: string | undefined;
    let callerPluginVariant: string | undefined;
    let versionMismatch = false;
    if (pluginSessionId) {
      const inst = bridge.getInstanceBySessionId(pluginSessionId);
      if (inst) {
        callerInstanceId = inst.instanceId;
        callerRole = inst.role;
        callerPluginVersion = inst.pluginVersion;
        callerPluginVariant = inst.pluginVariant;
        versionMismatch = inst.versionMismatch;
        knownInstance = true;
      }
    }

    if (!isMCPServerActive()) {
      res.status(503).json({
        error: 'MCP server not connected',
        pluginConnected: true,
        mcpConnected: false,
        knownInstance,
        serverVersion: serverConfig?.version,
        pluginVersion: callerPluginVersion,
        pluginVariant: callerPluginVariant,
        versionMismatch,
        request: null
      });
      return;
    }

    // knownInstance=false signals to the plugin that the MCP server has
    // restarted (its in-memory instances map is empty) and the plugin
    // should re-issue /ready. Without this, polls succeed (HTTP 200) but
    // the server treats the plugin as anonymous and routes nothing to it.
    const pendingRequest = knownInstance && callerInstanceId && callerRole
      ? bridge.getPendingRequest(callerInstanceId, callerRole)
      : null;

    if (pendingRequest) {
      res.json({
        request: pendingRequest.request,
        requestId: pendingRequest.requestId,
        mcpConnected: true,
        pluginConnected: true,
        knownInstance,
        serverVersion: serverConfig?.version,
        pluginVersion: callerPluginVersion,
        pluginVariant: callerPluginVariant,
        versionMismatch,
        proxyInstanceCount: proxyInstances.size
      });
    } else {
      res.json({
        request: null,
        mcpConnected: true,
        pluginConnected: true,
        knownInstance,
        serverVersion: serverConfig?.version,
        pluginVersion: callerPluginVersion,
        pluginVariant: callerPluginVariant,
        versionMismatch,
        proxyInstanceCount: proxyInstances.size
      });
    }
  });


  app.post('/response', (req, res) => {
    const { requestId, response, error } = req.body;

    if (error) {
      bridge.rejectRequest(requestId, error);
    } else {
      bridge.resolveRequest(requestId, response);
    }

    res.json({ success: true });
  });


  app.post('/proxy', async (req, res) => {
    const { endpoint, data, targetInstanceId, targetRole, proxyInstanceId } = req.body;

    if (!endpoint || !targetInstanceId || !targetRole) {
      res.status(400).json({ error: 'endpoint, targetInstanceId, and targetRole are required' });
      return;
    }

    if (proxyInstanceId) {
      proxyInstances.add(proxyInstanceId);
    }

    try {
      const response = await bridge.sendRequest(endpoint, data, targetInstanceId, targetRole);
      res.json({ response });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Proxy request failed' });
    }
  });


  // Streamable HTTP MCP transport
  if (serverConfig) {
    const legacyFilteredTools = serverConfig.tools.filter(t => !allowedTools || allowedTools.has(t.name));
    const isLazyHttp = !!(registry?.lazyMode);

    app.post('/mcp', async (req, res) => {
      try {
        trackMCPActivity();

        const server = new Server(
          { name: serverConfig.name, version: serverConfig.version },
          { capabilities: { tools: isLazyHttp ? { listChanged: true } : {}, resources: { subscribe: true, listChanged: true } }, instructions: SERVER_INSTRUCTIONS }
        );

        server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: RESOURCE_LIST }));
        server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: RESOURCE_TEMPLATES }));
        server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
          try {
            return await readResource(tools, request.params.uri);
          } catch (error) {
            throw new McpError(ErrorCode.InvalidParams, error instanceof Error ? error.message : String(error));
          }
        });
        // Subscriptions are accepted for protocol conformance, but this transport is
        // stateless (a fresh server per POST, closed on response), so resources/updated
        // can't be pushed here — subscriptions deliver on the persistent stdio server.
        server.setRequestHandler(SubscribeRequestSchema, async () => ({}));
        server.setRequestHandler(UnsubscribeRequestSchema, async () => ({}));

        server.setRequestHandler(ListToolsRequestSchema, async () => {
          const candidates = (isLazyHttp && registry)
            ? registry.definitions
            : legacyFilteredTools;
          return { tools: candidates.map(toolDefinitionToMcpTool) };
        });

        server.setRequestHandler(CallToolRequestSchema, async (request) => {
          const { name, arguments: args } = request.params;

          if (allowedTools && !allowedTools.has(name)) {
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
          }

          // 1. Try the registry first (pipeline-wrapped). Returns null when
          //    the tool isn't registered; cast through unknown for the MCP
          //    SDK's ServerResult type.
          if (registry) {
            const registryResult: unknown = await registry.callTool(name, tools, args || {});
            if (registryResult !== null && registryResult !== undefined) {
              return registryResult;
            }
          }

          // 2. Fall through to the legacy TOOL_HANDLERS map.
          const handler = TOOL_HANDLERS[name];
          if (!handler) {
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
          }

          try {
            const result = await handler(tools, args || {});
            return attachStructuredContent(result as Record<string, unknown>);
          } catch (error) {
            if (error instanceof RoutingFailure) {
              // Surface routing errors as structured tool-call results with
              // the full instance list embedded so the LLM can recover by
              // picking an instance_id from data.instances — no need for a
              // separate get_connected_instances round-trip.
              return {
                content: [{
                  type: 'text',
                  text: JSON.stringify({
                    error: error.routingError.code,
                    message: error.routingError.message,
                    data: error.routingError.data,
                  }),
                }],
                isError: true,
              };
            }
            if (error instanceof McpError) throw error;
            return toolErrorResult(error, name);
          }
        });

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        res.on('close', () => {
          transport.close();
          server.close();
        });
      } catch (error) {
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          });
        }
      }
    });

    app.get('/mcp', (req, res) => {
      res.writeHead(405).end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed.' },
        id: null,
      }));
    });

    app.delete('/mcp', (req, res) => {
      res.writeHead(405).end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed.' },
        id: null,
      }));
    });
  }

  app.use('/mcp/*', (req, res, next) => {
    trackMCPActivity();
    next();
  });

  // Register /mcp/* routes dynamically based on allowedTools
  for (const [toolName, handler] of Object.entries(TOOL_HANDLERS)) {
    if (allowedTools && !allowedTools.has(toolName)) continue;

    app.post(`/mcp/${toolName}`, async (req, res) => {
      try {
        // Try the registry first (pipeline-wrapped tools).
        if (registry) {
          const registryResult = await registry.callTool(toolName, tools, req.body);
          if (registryResult !== undefined) { res.json(registryResult); return; }
        }
        // Fall through to legacy handler.
        const result = await handler(tools, req.body);
        res.json(result);
      } catch (error) {
        if (error instanceof RoutingFailure) {
          res.status(400).json({
            error: error.routingError.code,
            message: error.routingError.message,
            data: error.routingError.data,
          });
          return;
        }
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
      }
    });
  }


  (app as any).isPluginConnected = isPluginConnected;
  (app as any).setMCPServerActive = setMCPServerActive;
  (app as any).isMCPServerActive = isMCPServerActive;
  (app as any).trackMCPActivity = trackMCPActivity;

  return app;
}

/**
 * Attempt to bind an Express app to a port, using an explicit http.Server
 * so that EADDRINUSE errors are properly caught.
 */
export function listenWithRetry(
  app: express.Express,
  host: string,
  startPort: number,
  maxAttempts: number = 5
): Promise<{ server: http.Server; port: number }> {
  return new Promise(async (resolve, reject) => {
    for (let i = 0; i < maxAttempts; i++) {
      const port = startPort + i;
      try {
        const server = await bindPort(app, host, port);
        resolve({ server, port });
        return;
      } catch (err: any) {
        if (err.code === 'EADDRINUSE') {
          console.error(`Port ${port} in use, trying next...`);
          continue;
        }
        reject(err);
        return;
      }
    }
    reject(new Error(`All ports ${startPort}-${startPort + maxAttempts - 1} are in use. Stop some MCP server instances and retry.`));
  });
}

function bindPort(app: express.Express, host: string, port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener('error', onError);
      reject(err);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve(server);
    });
  });
}
