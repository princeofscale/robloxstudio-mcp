import type { JsonSchema, ToolDefinition } from './definitions.js';

export interface McpToolShape {
  name: string;
  description: string;
  inputSchema: object;
  outputSchema?: JsonSchema;
}

export function toolDefinitionToMcpTool(tool: ToolDefinition): McpToolShape {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
  };
}
