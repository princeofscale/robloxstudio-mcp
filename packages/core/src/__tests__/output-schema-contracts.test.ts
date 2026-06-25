import { OUTPUT_SCHEMAS } from '../tools/output-schemas.js';

type JsonSchema = Record<string, unknown>;

interface ValidationIssue {
  path: string;
  message: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function typeMatches(expected: unknown, value: unknown): boolean {
  const options = Array.isArray(expected) ? expected : [expected];
  return options.some((type) => {
    if (type === 'null') return value === null;
    if (type === 'array') return Array.isArray(value);
    if (type === 'object') return isObject(value);
    return typeof value === type;
  });
}

function validate(schema: unknown, value: unknown, path = '$'): ValidationIssue[] {
  if (!schema || typeof schema !== 'object') return [];
  const s = schema as JsonSchema;

  if (Array.isArray(s.anyOf)) {
    const passes = s.anyOf.some((entry) => validate(entry, value, path).length === 0);
    return passes ? [] : [{ path, message: 'did not match anyOf' }];
  }

  const issues: ValidationIssue[] = [];
  if ('type' in s && !typeMatches(s.type, value)) {
    issues.push({ path, message: `expected ${JSON.stringify(s.type)}, got ${Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value}` });
    return issues;
  }

  if (Array.isArray(s.enum) && !s.enum.includes(value)) {
    issues.push({ path, message: `expected one of ${JSON.stringify(s.enum)}, got ${JSON.stringify(value)}` });
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      issues.push(...validate(s.items, value[i], `${path}[${i}]`));
    }
    return issues;
  }

  if (isObject(value)) {
    const required = Array.isArray(s.required) ? s.required.map(String) : [];
    for (const key of required) {
      if (!(key in value)) issues.push({ path, message: `missing required property ${key}` });
    }

    const properties = isObject(s.properties) ? s.properties as Record<string, unknown> : {};
    for (const [key, child] of Object.entries(properties)) {
      if (key in value) issues.push(...validate(child, value[key], `${path}.${key}`));
    }

    if (s.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) issues.push({ path: `${path}.${key}`, message: 'unexpected additional property' });
      }
    }
  }

  return issues;
}

const samples: Record<string, unknown> = {
  tool_catalog_search: {
    query: 'find ui button',
    count: 1,
    matches: [{
      name: 'ui_create_text_button',
      domain: 'ui',
      mode: 'write',
      whenToUse: 'Create a text button',
      requiredArgs: ['parentPath', 'name'],
    }],
    recommendedToolsets: [{
      domain: 'ui',
      recommendedTools: ['ui_create_text_button'],
      load: { tool: 'load_toolset', args: { toolsets: ['ui'] } },
    }],
    client_hint: 'If a tool you need is not in your current tool list, call load_toolset with the recommended domain(s) first.',
  },
  load_toolset: {
    loaded: ['ui'],
    tools: ['tool_catalog_search', 'load_toolset', 'ui_create_frame'],
    count: 3,
  },
  get_world_snapshot: {
    root: 'game',
    level: 'overview',
    place: { placeId: 123, name: 'Place' },
    counts: { totalDescendants: 4, distinctClasses: 2, tagged: 1 },
    topClasses: [{ className: 'Part', count: 2 }],
    roots: [{ name: 'Workspace', className: 'Workspace', path: 'Workspace', childCount: 2 }],
    environment: { clockTime: 14, hasSky: true },
  },
  get_node_batch: {
    nodes: [{
      path: 'game.Workspace.Part',
      name: 'Part',
      className: 'Part',
      props: { Anchored: true, Position: [1, 2, 3] },
      childCount: 0,
    }],
    count: 1,
  },
  get_changes_since: {
    snapshotId: 'snap_1',
    baseline: true,
    count: 8,
    truncated: false,
    path: 'game',
  },
  scene_search: {
    query: 'door system',
    total: 1,
    returned: 1,
    results: [{
      path: 'Workspace.Door',
      name: 'Door',
      className: 'Model',
      score: 12,
      matched: ['door'],
    }],
  },
  asset_preflight_insert: {
    assetId: 123,
    insertabilityVerdict: 'yes',
    hasScripts: false,
    scriptCount: 0,
    rootCount: 1,
    descendantCount: 2,
    roots: [{ name: 'Tree', className: 'Model' }],
  },
  playtest_sample_state: {
    runtime: { isRunning: true, isServer: true, isClient: false, isStudio: true },
    players: [{ name: 'Player1', userId: 1, position: [0, 5, 0], health: 100 }],
    playerCount: 1,
    worldValues: [{ path: 'Workspace.RoundState', class: 'StringValue', value: 'Lobby' }],
    activeAudio: [{ path: 'SoundService.Music', soundId: 'rbxassetid://1', looped: true, volume: 0.4 }],
    activeAudioCount: 1,
  },
  run_gameplay_assertions: {
    results: [{ name: 'Boss exists', passed: true, value: 'true' }],
    summary: { total: 1, passed: 1, failed: 0 },
    allPassed: true,
  },
  apply_mutation_plan: {
    applied: false,
    dryRun: true,
    results: [{ op: 'set_property', target: 'Workspace.Part', ok: true, property: 'Anchored', before: false, wouldSet: true }],
    rollback: [{ op: 'set_property', target: 'Workspace.Part', property: 'Anchored', value: false }],
    summary: { total: 1, succeeded: 0, failed: 0 },
  },
  list_recipes: {
    recipes: [{
      id: 'proximity_door',
      description: 'A door part with a ProximityPrompt that toggles open/closed.',
      params: [{ name: 'name', type: 'string', description: 'Door name.' }],
    }],
  },
  apply_recipe: {
    recipe: 'proximity_door',
    created: 'Workspace.Door',
  },
  run_playtest_episode: {
    episodeId: 'ep_abc',
    episodeUri: 'roblox://playtest/episode/ep_abc',
    mode: 'play',
    verdict: 'fail',
    durationS: 3,
    runtimeReady: true,
    assertions: { allPassed: false, results: [{ name: 'door_opens', passed: false }] },
    logs: { errorCount: 1, warningCount: 0, errors: [{ message: 'boom' }], warnings: [] },
    stopped: true,
    hint: 'Runtime errors were logged.',
  },
  summarize_episode: {
    episodeId: 'ep_abc',
    verdict: 'pass',
    mode: 'play',
    errorCount: 0,
    warningCount: 0,
    failedAssertions: [],
    topErrors: [],
    implicatedScripts: [],
    comparison: { comparedTo: 'ep_old', fixed: true, errorCountDelta: -1, newErrors: [], resolvedErrors: ['boom'], assertionTransitions: [] },
    suggestion: 'Episode is clean.',
  },
  propose_next_action: {
    episodeId: 'ep_abc',
    action: 'fix_assertion',
    done: false,
    tool: null,
    rationale: 'Assertion failed.',
    focus: ['door_opens'],
  },
};

describe('output schema contracts', () => {
  it('has one representative sample for every published output schema', () => {
    expect(Object.keys(samples).sort()).toEqual(Object.keys(OUTPUT_SCHEMAS).sort());
  });

  it.each(Object.keys(samples).sort())('%s sample matches its advertised outputSchema', (toolName) => {
    const issues = validate(OUTPUT_SCHEMAS[toolName], samples[toolName]);
    expect(issues).toEqual([]);
  });
});
