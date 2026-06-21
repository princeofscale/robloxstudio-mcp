import { BROWSING_TOOL_DEFINITIONS } from './definitions/browsing.js';
import { MUTATION_TOOL_DEFINITIONS } from './definitions/mutation.js';
import { SCRIPTING_TOOL_DEFINITIONS } from './definitions/scripting.js';
import { RUNTIME_TOOL_DEFINITIONS } from './definitions/runtime.js';
import { BUILD_TOOL_DEFINITIONS } from './definitions/builds.js';
import { ASSET_TOOL_DEFINITIONS } from './definitions/assets.js';
import { SCENE_TOOL_DEFINITIONS } from './definitions/scene.js';
import { GENERATED_TOOL_DEFINITIONS } from './definitions/generated.js';
import { META_TOOL_DEFINITIONS } from './definitions/meta.js';

export type ToolCategory = 'read' | 'write';
export type JsonSchema = Record<string, unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  category: ToolCategory;
  inputSchema: object;
  outputSchema?: JsonSchema;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  ...BROWSING_TOOL_DEFINITIONS,
  ...MUTATION_TOOL_DEFINITIONS,
  ...SCRIPTING_TOOL_DEFINITIONS,
  ...RUNTIME_TOOL_DEFINITIONS,
  ...BUILD_TOOL_DEFINITIONS,
  ...ASSET_TOOL_DEFINITIONS,
  ...SCENE_TOOL_DEFINITIONS,
  ...GENERATED_TOOL_DEFINITIONS,
  ...META_TOOL_DEFINITIONS,
];

export const getReadOnlyTools = () => TOOL_DEFINITIONS.filter(t => t.category === 'read');
export const getAllTools = () => [...TOOL_DEFINITIONS];
