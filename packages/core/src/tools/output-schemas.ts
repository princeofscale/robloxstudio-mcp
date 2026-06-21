import type { JsonSchema, ToolDefinition } from './definitions.js';

const jsonValue: JsonSchema = {
  anyOf: [
    { type: 'string' },
    { type: 'number' },
    { type: 'boolean' },
    { type: 'null' },
    { type: 'array', items: {} },
    { type: 'object', additionalProperties: true },
  ],
};

const stringArray: JsonSchema = { type: 'array', items: { type: 'string' } };

const catalogEntry: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    domain: { type: 'string' },
    mode: { type: 'string', enum: ['read', 'write'] },
    whenToUse: { type: 'string' },
    requiredArgs: stringArray,
  },
  required: ['name', 'domain', 'mode', 'whenToUse', 'requiredArgs'],
};

const mutationOperation: JsonSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    op: { type: 'string', enum: ['set_property', 'set_attribute', 'add_tag', 'remove_tag'] },
    target: { type: 'string' },
    property: { type: 'string' },
    name: { type: 'string' },
    tag: { type: 'string' },
    value: jsonValue,
  },
  required: ['op', 'target'],
};

const mutationResult: JsonSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    op: { type: 'string' },
    target: { type: 'string' },
    ok: { type: 'boolean' },
    error: { type: 'string' },
  },
  required: ['op', 'target', 'ok'],
};

export const OUTPUT_SCHEMAS: Record<string, JsonSchema> = {
  tool_catalog_search: {
    type: 'object',
    additionalProperties: true,
    properties: {
      query: { type: 'string' },
      count: { type: 'number' },
      matches: { type: 'array', items: catalogEntry },
      recommendedToolsets: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            domain: { type: 'string' },
            recommendedTools: stringArray,
            load: {
              type: 'object',
              additionalProperties: false,
              properties: {
                tool: { type: 'string', enum: ['load_toolset'] },
                args: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    toolsets: stringArray,
                  },
                  required: ['toolsets'],
                },
              },
              required: ['tool', 'args'],
            },
          },
          required: ['domain', 'recommendedTools', 'load'],
        },
      },
      client_hint: { type: 'string' },
    },
    required: ['query', 'count', 'matches', 'recommendedToolsets', 'client_hint'],
  },
  load_toolset: {
    type: 'object',
    additionalProperties: false,
    properties: {
      loaded: stringArray,
      tools: stringArray,
      count: { type: 'number' },
    },
    required: ['loaded', 'tools', 'count'],
  },
  get_world_snapshot: {
    type: 'object',
    additionalProperties: true,
    properties: {
      root: { type: 'string' },
      level: { type: 'string', enum: ['overview', 'standard'] },
      place: { type: 'object', additionalProperties: true },
      counts: { type: 'object', additionalProperties: true },
      topClasses: { type: 'array', items: { type: 'object', additionalProperties: true } },
      roots: { type: 'array', items: { type: 'object', additionalProperties: true } },
      environment: { type: 'object', additionalProperties: true },
      error: { type: 'string' },
    },
  },
  get_node_batch: {
    type: 'object',
    additionalProperties: true,
    properties: {
      nodes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            path: { type: 'string' },
            name: { type: 'string' },
            className: { type: 'string' },
            props: { type: 'object', additionalProperties: true },
            childCount: { type: 'number' },
            error: { type: 'string' },
          },
          required: ['path'],
        },
      },
      count: { type: 'number' },
    },
    required: ['nodes', 'count'],
  },
  get_changes_since: {
    type: 'object',
    additionalProperties: true,
    properties: {
      snapshotId: { type: 'string' },
      baseline: { type: 'boolean' },
      path: { type: 'string' },
      added: { type: 'array', items: { type: 'object', additionalProperties: true } },
      removed: { type: 'array', items: { type: 'object', additionalProperties: true } },
      changed: { type: 'array', items: { type: 'object', additionalProperties: true } },
      count: { type: 'number' },
      truncated: { type: 'boolean' },
      error: { type: 'string' },
    },
  },
  scene_search: {
    type: 'object',
    additionalProperties: true,
    properties: {
      query: { type: 'string' },
      total: { type: 'number' },
      returned: { type: 'number' },
      results: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            path: { type: 'string' },
            name: { type: 'string' },
            className: { type: 'string' },
            score: { type: 'number' },
            matched: stringArray,
          },
          required: ['path', 'name', 'className', 'score', 'matched'],
        },
      },
      error: { type: 'string' },
    },
  },
  asset_preflight_insert: {
    type: 'object',
    additionalProperties: true,
    properties: {
      assetId: { type: 'number' },
      insertabilityVerdict: { type: 'string', enum: ['yes', 'no'] },
      hasScripts: { type: 'boolean' },
      scriptCount: { type: 'number' },
      rootCount: { type: 'number' },
      descendantCount: { type: 'number' },
      roots: { type: 'array', items: { type: 'object', additionalProperties: true } },
      error: { type: 'string' },
      code: { type: 'string' },
      hint: { type: 'string' },
    },
    required: ['assetId', 'insertabilityVerdict'],
  },
  playtest_sample_state: {
    type: 'object',
    additionalProperties: true,
    properties: {
      runtime: { type: 'object', additionalProperties: true },
      players: { type: 'array', items: { type: 'object', additionalProperties: true } },
      playerCount: { type: 'number' },
      worldValues: { type: 'array', items: { type: 'object', additionalProperties: true } },
      activeAudio: { type: 'array', items: { type: 'object', additionalProperties: true } },
      activeAudioCount: { type: 'number' },
    },
  },
  run_gameplay_assertions: {
    type: 'object',
    additionalProperties: true,
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            name: { type: 'string' },
            passed: { type: 'boolean' },
            value: { type: 'string' },
            error: { type: 'string' },
          },
          required: ['name', 'passed'],
        },
      },
      summary: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'number' },
          passed: { type: 'number' },
          failed: { type: 'number' },
        },
        required: ['total', 'passed', 'failed'],
      },
      allPassed: { type: 'boolean' },
    },
    required: ['results', 'summary', 'allPassed'],
  },
  apply_mutation_plan: {
    type: 'object',
    additionalProperties: true,
    properties: {
      applied: { type: 'boolean' },
      dryRun: { type: 'boolean' },
      results: { type: 'array', items: mutationResult },
      rollback: { type: 'array', items: mutationOperation },
      summary: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'number' },
          succeeded: { type: 'number' },
          failed: { type: 'number' },
        },
        required: ['total', 'succeeded', 'failed'],
      },
    },
    required: ['applied', 'dryRun', 'results', 'rollback', 'summary'],
  },
  list_recipes: {
    type: 'object',
    additionalProperties: false,
    properties: {
      recipes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            description: { type: 'string' },
            params: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string' },
                  type: { type: 'string', enum: ['string', 'number', 'boolean'] },
                  required: { type: 'boolean' },
                  description: { type: 'string' },
                },
                required: ['name', 'type', 'description'],
              },
            },
          },
          required: ['id', 'description', 'params'],
        },
      },
    },
    required: ['recipes'],
  },
  apply_recipe: {
    type: 'object',
    additionalProperties: true,
    properties: {
      recipe: { type: 'string' },
      created: { type: 'string' },
      playing: { type: 'boolean' },
      error: { type: 'string' },
    },
  },
};

export const CONTRACTED_OUTPUT_TOOL_NAMES = Object.keys(OUTPUT_SCHEMAS).sort();

export function getOutputSchema(toolName: string): JsonSchema | undefined {
  return OUTPUT_SCHEMAS[toolName];
}

export function withOutputSchemas(definitions: ToolDefinition[]): ToolDefinition[] {
  return definitions.map((definition) => {
    const outputSchema = getOutputSchema(definition.name);
    return outputSchema ? { ...definition, outputSchema } : definition;
  });
}
