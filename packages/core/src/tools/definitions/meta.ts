import type { ToolDefinition } from '../definitions.js';

// Meta / discovery tools. These operate on the server's own tool catalog, not on
// a Studio place, so they are Studio-agnostic. tool_catalog_search lets an agent
// find the right tool for a task without paying for every tool's full schema.
export const META_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'tool_catalog_search',
    category: 'read',
    description:
      'Find the right tool for a task without loading every tool schema. Returns a compact, ranked list of matching tools (name, domain, read/write, when to use, required args). Use this first when you are unsure which tool to call, then call the tool it points to.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Task or capability you need, e.g. "play a sound", "find a tree model", "read script source".',
        },
        domains: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'core', 'scene', 'mutation', 'scripts', 'runtime',
              'assets', 'ui', 'environment', 'terrain', 'build', 'media', 'sync', 'safety',
            ],
          },
          description: 'Optional: restrict results to these domains.',
        },
        readOnly: { type: 'boolean', description: 'Optional: only return read tools.' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Max results (default 8).' },
      },
      required: ['query'],
    },
  },
];
