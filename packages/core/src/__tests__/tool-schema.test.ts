import { TOOL_DEFINITIONS } from '../tools/definitions.js';
import { CONTRACTED_OUTPUT_TOOL_NAMES, OUTPUT_SCHEMAS, withOutputSchemas } from '../tools/output-schemas.js';
import { ASSET_TOOL_DEFINITIONS } from '../tools/definitions/assets.js';
import { BROWSING_TOOL_DEFINITIONS } from '../tools/definitions/browsing.js';
import { BUILD_TOOL_DEFINITIONS } from '../tools/definitions/builds.js';
import { GENERATED_TOOL_DEFINITIONS } from '../tools/definitions/generated.js';
import { MUTATION_TOOL_DEFINITIONS } from '../tools/definitions/mutation.js';
import { SCENE_TOOL_DEFINITIONS } from '../tools/definitions/scene.js';
import { RUNTIME_TOOL_DEFINITIONS } from '../tools/definitions/runtime.js';
import { SCRIPTING_TOOL_DEFINITIONS } from '../tools/definitions/scripting.js';
import { META_TOOL_DEFINITIONS } from '../tools/definitions/meta.js';
import { TOOL_HANDLERS } from '../http-server.js';
import { RobloxStudioTools } from '../tools/index.js';
import { toolDefinitionToMcpTool } from '../tools/tool-shape.js';
import { BridgeService } from '../bridge-service.js';

type JsonSchema = Record<string, unknown>;

function collectArraySchemasMissingItems(schema: unknown, path: string, out: string[]) {
  if (!schema || typeof schema !== 'object') return;
  const node = schema as JsonSchema;
  if (node.type === 'array' && !('items' in node)) {
    out.push(path);
  }
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const value = node[key];
    if (Array.isArray(value)) {
      value.forEach((entry, index) => collectArraySchemasMissingItems(entry, `${path}.${key}[${index}]`, out));
    }
  }
  const properties = node.properties;
  if (properties && typeof properties === 'object') {
    for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
      collectArraySchemasMissingItems(value, `${path}.properties.${key}`, out);
    }
  }
  const items = node.items;
  if (Array.isArray(items)) {
    items.forEach((entry, index) => collectArraySchemasMissingItems(entry, `${path}.items[${index}]`, out));
  } else {
    collectArraySchemasMissingItems(items, `${path}.items`, out);
  }
}

describe('Tool schema compatibility', () => {
  test('domain definition modules compose TOOL_DEFINITIONS in canonical order', () => {
    const grouped = withOutputSchemas([
      ...BROWSING_TOOL_DEFINITIONS,
      ...MUTATION_TOOL_DEFINITIONS,
      ...SCRIPTING_TOOL_DEFINITIONS,
      ...RUNTIME_TOOL_DEFINITIONS,
      ...BUILD_TOOL_DEFINITIONS,
      ...ASSET_TOOL_DEFINITIONS,
      ...SCENE_TOOL_DEFINITIONS,
      ...GENERATED_TOOL_DEFINITIONS,
      ...META_TOOL_DEFINITIONS,
    ]);
    expect(grouped.map((tool) => tool.name)).toEqual(TOOL_DEFINITIONS.map((tool) => tool.name));
    expect(grouped).toEqual(TOOL_DEFINITIONS);
  });

  test('every array schema declares items', () => {
    const missing: string[] = [];
    for (const tool of TOOL_DEFINITIONS) {
      collectArraySchemasMissingItems(tool.inputSchema, tool.name, missing);
    }
    expect(missing).toEqual([]);
  });

  test('MCP tool shape includes outputSchema only when the tool publishes one', () => {
    const noOutput = toolDefinitionToMcpTool({
      name: 'example_no_output',
      category: 'read',
      description: 'Example without output schema.',
      inputSchema: { type: 'object', properties: {} },
    });
    expect(noOutput).toEqual({
      name: 'example_no_output',
      description: 'Example without output schema.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
    });

    const withOutput = toolDefinitionToMcpTool({
      name: 'example_with_output',
      category: 'read',
      description: 'Example with output schema.',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
      },
    });
    expect(withOutput).toEqual({
      name: 'example_with_output',
      description: 'Example with output schema.',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
      },
      annotations: { readOnlyHint: true },
    });
  });

  test('annotations: reads are readOnly, destructive writes flagged, marketplace is open-world', () => {
    const byName = new Map(TOOL_DEFINITIONS.map((t) => [t.name, t]));
    const ann = (name: string) => toolDefinitionToMcpTool(byName.get(name)!).annotations;
    // A pure read.
    expect(ann('get_world_snapshot')).toMatchObject({ readOnlyHint: true });
    expect(ann('get_world_snapshot')).not.toHaveProperty('destructiveHint');
    // A destructive write.
    expect(ann('delete_object')).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    // A non-destructive write.
    expect(ann('create_object')).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    // An external-service tool.
    expect(ann('marketplace_search')).toMatchObject({ openWorldHint: true });
  });

  test('first-wave contracted tools advertise outputSchema from the central registry', () => {
    const byName = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));

    for (const toolName of CONTRACTED_OUTPUT_TOOL_NAMES) {
      const tool = byName.get(toolName);
      expect(tool).toBeTruthy();
      expect(tool!.outputSchema).toEqual(OUTPUT_SCHEMAS[toolName]);
    }
  });

  test('no tool advertises outputSchema outside the central registry', () => {
    const allowed = new Set(CONTRACTED_OUTPUT_TOOL_NAMES);
    const offenders = TOOL_DEFINITIONS
      .filter((tool) => tool.outputSchema && !allowed.has(tool.name))
      .map((tool) => tool.name);

    expect(offenders).toEqual([]);
  });

  test('every array output schema declares items', () => {
    const missing: string[] = [];
    for (const [toolName, schema] of Object.entries(OUTPUT_SCHEMAS)) {
      collectArraySchemasMissingItems(schema, `${toolName}.outputSchema`, missing);
    }
    expect(missing).toEqual([]);
  });

  // Tools that don't dispatch to Studio (asset uploads, local file ops, build
  // library, etc.) intentionally don't take instance_id. Everything else
  // should expose it in the schema AND thread it through the HTTP handler.
  const STUDIO_AGNOSTIC_TOOLS = new Set([
    'search_assets',
    'get_asset_details',
    'get_asset_thumbnail',
    'upload_asset',
    'list_library',
    'get_build',
    'create_build',
    'generate_build',
    'get_connected_instances',
    // Safety/audit tools operate on in-memory server state, not a Studio place.
    'get_operation_history',
    'list_script_backups',
    // Free marketplace search runs server-side (public toolbox), not in a place.
    'marketplace_search',
    // AI image generation is server-side (Pollinations + local file / upload).
    'image_generate',
    'image_generate_and_upload',
    // Discovery/meta tools — operate on the server's own catalog, not a Studio place.
    'tool_catalog_search',
    'load_toolset',
    // Recipe listing is pure (server-side registry), not a Studio call.
    'list_recipes',
    // The UI design-system catalog is static data, not a Studio call.
    'ui_component_catalog',
    // Provenance lookup reads the in-memory store, not a Studio place.
    'get_asset_provenance',
    // CC0 asset discovery is a web search — no Studio place involved.
    'asset_source_search',
    // Episode summary reads the in-memory episode store, not a Studio place.
    'summarize_episode',
    // Deterministic next-action reasons over the in-memory episode store.
    'propose_next_action',
  ]);

  function toolHandlerBody(toolName: string): string {
    const handler = TOOL_HANDLERS[toolName];
    if (!handler) throw new Error(`No HTTP handler registered for tool ${toolName}`);
    return handler.toString();
  }

  test('every Studio-routing tool exposes instance_id in its schema', () => {
    const offenders: string[] = [];
    for (const tool of TOOL_DEFINITIONS) {
      if (STUDIO_AGNOSTIC_TOOLS.has(tool.name)) continue;
      const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      if (!('instance_id' in props)) {
        offenders.push(tool.name);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('every Studio-routing tool threads body.instance_id through the HTTP handler', () => {
    const offenders: string[] = [];
    for (const tool of TOOL_DEFINITIONS) {
      if (STUDIO_AGNOSTIC_TOOLS.has(tool.name)) continue;
      const body = toolHandlerBody(tool.name);
      if (!body.includes('body.instance_id')) {
        offenders.push(tool.name);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('every Studio-routing tool implementation accepts an instance_id parameter', () => {
    // Reflects on the actual method signatures on RobloxStudioTools. If the
    // tool method's stringified source doesn't mention instance_id at all,
    // it can't be routing it through resolveTarget — which means the handler
    // wiring is a no-op.
    const bridge = new BridgeService();
    const tools = new RobloxStudioTools(bridge);
    const proto = Object.getPrototypeOf(tools);
    const offenders: string[] = [];
    // Map snake_case tool name to the camelCase method name used in
    // RobloxStudioTools. Most are mechanical; a few are exceptions.
    const methodNameOf: Record<string, string> = {
      get_file_tree: 'getFileTree',
      search_files: 'searchFiles',
      get_place_info: 'getPlaceInfo',
      get_services: 'getServices',
      search_objects: 'searchObjects',
      get_instance_properties: 'getInstanceProperties',
      get_instance_children: 'getInstanceChildren',
      search_by_property: 'searchByProperty',
      get_class_info: 'getClassInfo',
      get_project_structure: 'getProjectStructure',
      set_property: 'setProperty',
      set_properties: 'setProperties',
      mass_set_property: 'massSetProperty',
      mass_get_property: 'massGetProperty',
      create_object: 'createObject',
      mass_create_objects: 'massCreateObjects',
      delete_object: 'deleteObject',
      smart_duplicate: 'smartDuplicate',
      mass_duplicate: 'massDuplicate',
      apply_mutation_plan: 'applyMutationPlan',
      grep_scripts: 'grepScripts',
      get_script_source: 'getScriptSource',
      set_script_source: 'setScriptSource',
      edit_script_lines: 'editScriptLines',
      insert_script_lines: 'insertScriptLines',
      delete_script_lines: 'deleteScriptLines',
      set_attribute: 'setAttribute',
      get_attributes: 'getAttributes',
      delete_attribute: 'deleteAttribute',
      get_tags: 'getTags',
      add_tag: 'addTag',
      remove_tag: 'removeTag',
      get_tagged: 'getTagged',
      get_selection: 'getSelection',
      execute_luau: 'executeLuau',
      eval_server_runtime: 'evalServerRuntime',
      eval_client_runtime: 'evalClientRuntime',
      set_network_profile: 'setNetworkProfile',
      get_simulation_state: 'getSimulationState',
      reset_simulation_state: 'resetSimulationState',
      get_device_simulator_state: 'getDeviceSimulatorState',
      set_device_simulator: 'setDeviceSimulator',
      capture_device_matrix: 'captureDeviceMatrix',
      start_playtest: 'startPlaytest',
      stop_playtest: 'stopPlaytest',
      multiplayer_test_start: 'multiplayerTestStart',
      multiplayer_test_state: 'multiplayerTestState',
      multiplayer_test_add_players: 'multiplayerTestAddPlayers',
      multiplayer_test_leave_client: 'multiplayerTestLeaveClient',
      multiplayer_test_end: 'multiplayerTestEnd',
      get_runtime_logs: 'getRuntimeLogs',
      execute_luau_async: 'executeLuauAsync',
      get_job_status: 'getJobStatus',
      get_job_result: 'getJobResult',
      cancel_job: 'cancelJob',
      capture_script_profiler: 'captureScriptProfiler',
      playtest_sample_state: 'playtestSampleState',
      run_gameplay_assertions: 'runGameplayAssertions',
      run_playtest_episode: 'runPlaytestEpisode',
      summarize_episode: 'summarizeEpisode',
      propose_next_action: 'proposeNextAction',
      get_reproduction_bundle: 'getReproductionBundle',
      breakpoints: 'breakpoints',
      export_build: 'exportBuild',
      import_build: 'importBuild',
      search_materials: 'searchMaterials',
      import_scene: 'importScene',
      undo: 'undo',
      redo: 'redo',
      insert_asset: 'insertAsset',
      preview_asset: 'previewAsset',
      asset_preflight_insert: 'assetPreflightInsert',
      clone_object: 'cloneObject',
      get_descendants: 'getDescendants',
      get_scene_summary: 'getSceneSummary',
      get_world_snapshot: 'getWorldSnapshot',
      get_node_batch: 'getNodeBatch',
      get_changes_since: 'getChangesSince',
      scene_search: 'sceneSearch',
      compare_instances: 'compareInstances',
      bulk_set_attributes: 'bulkSetAttributes',
      capture_screenshot: 'captureScreenshot',
      simulate_mouse_input: 'simulateMouseInput',
      simulate_keyboard_input: 'simulateKeyboardInput',
      character_navigation: 'characterNavigation',
      get_memory_breakdown: 'getMemoryBreakdown',
      get_scene_analysis: 'getSceneAnalysis',
      export_rbxm: 'exportRbxm',
      import_rbxm: 'importRbxm',
      find_and_replace_in_scripts: 'findAndReplaceInScripts',
      restore_script_backup: 'restoreScriptBackup',
      ui_create_screen_gui: 'uiCreateScreenGui',
      ui_create_frame: 'uiCreateFrame',
      ui_create_text_label: 'uiCreateTextLabel',
      ui_create_text_button: 'uiCreateTextButton',
      ui_create_image_label: 'uiCreateImageLabel',
      ui_create_image_button: 'uiCreateImageButton',
      ui_apply_layout: 'uiApplyLayout',
      ui_make_mobile_friendly: 'uiMakeMobileFriendly',
      environment_set_time_of_day: 'environmentSetTimeOfDay',
      environment_set_lighting_preset: 'environmentSetLightingPreset',
      environment_set_atmosphere: 'environmentSetAtmosphere',
      environment_set_sky: 'environmentSetSky',
      environment_create_day_night_cycle_script: 'environmentCreateDayNightCycleScript',
      terrain_generate_baseplate: 'terrainGenerateBaseplate',
      terrain_generate_island: 'terrainGenerateIsland',
      terrain_generate_mountains: 'terrainGenerateMountains',
      terrain_generate_water: 'terrainGenerateWater',
      terrain_paint_material: 'terrainPaintMaterial',
      terrain_clear_region: 'terrainClearRegion',
      template_create_obby_game: 'templateCreateObbyGame',
      template_create_simulator_game: 'templateCreateSimulatorGame',
      template_create_tycoon_game: 'templateCreateTycoonGame',
      template_create_round_game: 'templateCreateRoundGame',
      sync_pull: 'syncPull',
      sync_status: 'syncStatus',
      sync_push: 'syncPush',
      marketplace_search_and_insert: 'marketplaceSearchAndInsert',
      plan_asset_insert: 'planAssetInsert',
      audio_create_sound: 'audioCreateSound',
      audio_play_sound: 'audioPlaySound',
      animation_create: 'animationCreate',
      animation_play: 'animationPlay',
      asset_apply_texture: 'assetApplyTexture',
      generate_model_native: 'generateModelNative',
      import_external_asset: 'importExternalAsset',
      design_lint: 'designLint',
      design_review: 'designReview',
      apply_theme: 'applyTheme',
      diagnose_scripts: 'diagnoseScripts',
      apply_recipe: 'applyRecipe',
    };
    for (const tool of TOOL_DEFINITIONS) {
      if (STUDIO_AGNOSTIC_TOOLS.has(tool.name)) continue;
      const methodName = methodNameOf[tool.name];
      if (!methodName) {
        offenders.push(`${tool.name} (no method-name mapping; add to test)`);
        continue;
      }
      const fn = (proto as Record<string, unknown>)[methodName];
      if (typeof fn !== 'function') {
        offenders.push(`${tool.name} (no method named ${methodName})`);
        continue;
      }
      if (!fn.toString().includes('instance_id')) {
        offenders.push(`${tool.name} (${methodName} signature missing instance_id)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('get_scene_analysis schema exposes mode, target, topN, raw, and instance_id', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'get_scene_analysis');
    expect(tool).toBeTruthy();
    const props = (tool!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(props).sort()).toEqual(['instance_id', 'mode', 'raw', 'target', 'topN'].sort());
    expect((props.mode as { enum?: string[] }).enum).toEqual([
      'all',
      'instance_composition',
      'script_memory',
      'unparented_instances',
      'triangle_composition',
      'animation_memory',
      'audio_memory',
    ]);
  });

  test('breakpoints schema exposes lifecycle actions and log fields', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'breakpoints');
    expect(tool).toBeTruthy();
    const schema = tool!.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    const props = schema.properties ?? {};
    expect(Object.keys(props).sort()).toEqual([
      'action',
      'clear_all',
      'condition',
      'continue_execution',
      'enabled',
      'instance_id',
      'line',
      'log_message',
      'script_path',
      'target',
    ].sort());
    expect((props.action as { enum?: string[] }).enum).toEqual(['set', 'remove', 'clear', 'list']);
    expect(schema.required).toEqual(['action']);
    expect(tool!.description).toContain('filtered by "Breakpoint"');
    expect(tool!.description).toContain('breakpoint-related failures');
    expect(tool!.description).toContain('ScriptDebuggerService.OnStopped handler');
    expect(tool!.description).toContain('Minimal OnStopped reference');
    expect(tool!.description).toContain('sds.OnStopped=function(info)');
    expect(tool!.description).toContain('Minimal flow');
    expect(tool!.description).toContain('clear_all=true');
    expect(tool!.description).toContain('MCP-managed breakpoints persist minimal script_path/line recovery data per place and target');
    expect(tool!.description).toContain('tool-created edit/server/client breakpoints');
    expect((props.clear_all as { description?: string }).description).toContain('MCP-managed breakpoints');
    expect((props.continue_execution as { description?: string }).description).toContain('Enum.DebuggerResumeType.Resume');
  });

  test('capture_script_profiler schema exposes focused optimization primitive', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'capture_script_profiler');
    expect(tool).toBeTruthy();
    const schema = tool!.inputSchema as { properties?: Record<string, unknown> };
    const props = schema.properties ?? {};
    expect(Object.keys(props).sort()).toEqual([
      'duration_ms',
      'filter',
      'frequency',
      'include_native',
      'include_plugin',
      'instance_id',
      'max_functions',
      'min_total_us',
      'output_path',
      'target',
    ].sort());
    expect(tool!.category).toBe('read');
    expect(tool!.description).toContain('Minimal flow');
    expect(tool!.description).toContain('debug.profilebegin');
    expect(tool!.description).toContain('microseconds');
    expect(tool!.description).toContain('total_us');
    expect(tool!.description).toContain('function_index');
    expect(tool!.description).toContain('do not sum rows');
    expect(tool!.description).toContain('runtime script path');
    expect(tool!.description).toContain('applied');
    expect(tool!.description).toContain('omitted.filtered_out');
    expect(tool!.description).toContain('does not expose long-lived profiler sessions');
    expect((props.target as { description?: string }).description).toContain('server');
    expect((props.target as { description?: string }).description).toContain('client-N');
    expect((props.target as { pattern?: string }).pattern).toBe('^(server|client-[0-9]+)$');
    expect((props.duration_ms as { default?: number; minimum?: number; maximum?: number }).default).toBe(1000);
    expect((props.duration_ms as { default?: number; minimum?: number; maximum?: number }).minimum).toBe(100);
    expect((props.duration_ms as { default?: number; minimum?: number; maximum?: number }).maximum).toBe(15000);
    expect((props.frequency as { default?: number; minimum?: number; maximum?: number }).default).toBe(1000);
    expect((props.frequency as { default?: number; minimum?: number; maximum?: number }).minimum).toBe(1);
    expect((props.frequency as { default?: number; minimum?: number; maximum?: number }).maximum).toBe(10000);
    expect((props.max_functions as { default?: number; minimum?: number; maximum?: number }).default).toBe(20);
    expect((props.max_functions as { default?: number; minimum?: number; maximum?: number }).minimum).toBe(1);
    expect((props.max_functions as { default?: number; minimum?: number; maximum?: number }).maximum).toBe(100);
    expect((props.min_total_us as { default?: number; minimum?: number }).default).toBe(0);
    expect((props.min_total_us as { default?: number; minimum?: number }).minimum).toBe(0);
    expect((props.min_total_us as { description?: string }).description).toContain('microseconds');
    expect((props.output_path as { description?: string }).description).toContain('raw Script Profiler JSON');
  });

  test('device simulator schemas expose target routing and matrix entries', () => {
    const getTool = TOOL_DEFINITIONS.find((t) => t.name === 'get_device_simulator_state');
    const setTool = TOOL_DEFINITIONS.find((t) => t.name === 'set_device_simulator');
    const matrixTool = TOOL_DEFINITIONS.find((t) => t.name === 'capture_device_matrix');
    expect(getTool).toBeTruthy();
    expect(setTool).toBeTruthy();
    expect(matrixTool).toBeTruthy();

    const getProps = (getTool!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(getProps).sort()).toEqual(['deviceId', 'includeDeviceList', 'instance_id', 'target'].sort());

    const setProps = (setTool!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(setProps).sort()).toEqual([
      'deviceId',
      'instance_id',
      'orientation',
      'pixelDensity',
      'resolution',
      'scalingMode',
      'stopSimulation',
      'target',
    ].sort());

    const matrixSchema = matrixTool!.inputSchema as {
      properties?: Record<string, { items?: unknown; maxItems?: number }>;
      required?: string[];
    };
    expect(matrixSchema.required).toEqual(['entries']);
    expect(matrixSchema.properties?.entries.items).toBeTruthy();
    expect(matrixSchema.properties?.entries.maxItems).toBe(6);
  });

  test('simulation state schemas expose inspect and reset controls', () => {
    const getTool = TOOL_DEFINITIONS.find((t) => t.name === 'get_simulation_state');
    const resetTool = TOOL_DEFINITIONS.find((t) => t.name === 'reset_simulation_state');
    expect(getTool).toBeTruthy();
    expect(resetTool).toBeTruthy();

    const getProps = (getTool!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(getProps).sort()).toEqual(['include', 'instance_id', 'target'].sort());
    expect((getProps.include as { enum?: string[] }).enum).toEqual(['network', 'deviceSimulator', 'both']);

    const resetProps = (resetTool!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect(Object.keys(resetProps).sort()).toEqual(['deviceSimulator', 'instance_id', 'network', 'target'].sort());
  });

  test('set_network_profile schema caps packet loss at Roblox engine limit', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'set_network_profile');
    expect(tool).toBeTruthy();
    const props = (tool!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    const overrides = props.overrides as { properties?: Record<string, { minimum?: number; maximum?: number }> };
    expect(overrides.properties?.InboundNetworkMinDelayMs.minimum).toBe(0);
    expect(overrides.properties?.OutboundNetworkMinDelayMs.minimum).toBe(0);
    expect(overrides.properties?.InboundNetworkJitterMs.minimum).toBe(0);
    expect(overrides.properties?.OutboundNetworkJitterMs.minimum).toBe(0);
    expect(overrides.properties?.InboundNetworkLossPercent.minimum).toBe(0);
    expect(overrides.properties?.InboundNetworkLossPercent.maximum).toBe(0.5);
    expect(overrides.properties?.OutboundNetworkLossPercent.minimum).toBe(0);
    expect(overrides.properties?.OutboundNetworkLossPercent.maximum).toBe(0.5);
  });
});
