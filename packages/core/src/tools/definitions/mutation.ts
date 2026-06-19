import type { ToolDefinition } from '../definitions.js';

export const MUTATION_TOOL_DEFINITIONS: ToolDefinition[] = [
  // === Property Write ===
  {
    name: 'set_property',
    category: 'write',
    description: 'Set a property on an instance',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Instance path (dot notation)'
        },
        propertyName: {
          type: 'string',
          description: 'Property name'
        },
        propertyValue: {
          description: 'Value to set (string, number, boolean, or object for Vector3/Color3/UDim2)'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['instancePath', 'propertyName', 'propertyValue']
    }
  },
  {
    name: 'mass_set_property',
    category: 'write',
    description: 'Set a property on multiple instances',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Instance paths'
        },
        propertyName: {
          type: 'string',
          description: 'Property name'
        },
        propertyValue: {
          description: 'Value to set (string, number, boolean, or object for Vector3/Color3/UDim2)'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['paths', 'propertyName', 'propertyValue']
    }
  },
  {
    name: 'mass_get_property',
    category: 'read',
    description: 'Get a property from multiple instances',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Instance paths'
        },
        propertyName: {
          type: 'string',
          description: 'Property name'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['paths', 'propertyName']
    }
  },
  {
    name: 'set_properties',
    category: 'write',
    description: 'Set multiple properties on a single instance in one call.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Instance path'
        },
        properties: {
          type: 'object',
          description: 'Map of property name to value'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['instancePath', 'properties']
    }
  },

  // === Object Creation/Deletion ===
  {
    name: 'create_object',
    category: 'write',
    description: 'Create a new instance. Optionally set properties on creation.',
    inputSchema: {
      type: 'object',
      properties: {
        className: {
          type: 'string',
          description: 'Roblox class name'
        },
        parent: {
          type: 'string',
          description: 'Parent instance path'
        },
        name: {
          type: 'string',
          description: 'Optional name'
        },
        properties: {
          type: 'object',
          description: 'Properties to set on creation'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['className', 'parent']
    }
  },
  {
    name: 'mass_create_objects',
    category: 'write',
    description: 'Create multiple instances. Each can have optional properties.',
    inputSchema: {
      type: 'object',
      properties: {
        objects: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              className: {
                type: 'string',
                description: 'Roblox class name'
              },
              parent: {
                type: 'string',
                description: 'Parent instance path'
              },
              name: {
                type: 'string',
                description: 'Optional name'
              },
              properties: {
                type: 'object',
                description: 'Properties to set on creation'
              }
            },
            required: ['className', 'parent']
          },
          description: 'Objects to create'
        },
        dryRun: {
          type: 'boolean',
          description: 'Preview the bulk creation without creating anything (default false).'
        },
        confirm: {
          type: 'boolean',
          description: 'Approve a large bulk creation the safety layer would otherwise gate (default false).'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['objects']
    }
  },
  {
    name: 'delete_object',
    category: 'write',
    description: 'Delete an instance. Deleting a protected service/root (e.g. Workspace, ServerScriptService) requires confirm:true. Use dryRun:true to preview.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Instance path (dot notation)'
        },
        dryRun: {
          type: 'boolean',
          description: 'Preview the deletion without removing anything (default false).'
        },
        confirm: {
          type: 'boolean',
          description: 'Approve a deletion the safety layer would otherwise gate, such as a protected service/root (default false).'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['instancePath']
    }
  },

  // === Duplication ===
  {
    name: 'smart_duplicate',
    category: 'write',
    description: 'Duplicate with naming, positioning, and property variations',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Instance path (dot notation)'
        },
        count: {
          type: 'number',
          description: 'Number of duplicates'
        },
        options: {
          type: 'object',
          properties: {
            namePattern: {
              type: 'string',
              description: 'Name pattern ({n} placeholder)'
            },
            positionOffset: {
              type: 'array',
              items: { type: 'number' },
              description: 'X, Y, Z offset per duplicate'
            },
            rotationOffset: {
              type: 'array',
              items: { type: 'number' },
              description: 'X, Y, Z rotation offset'
            },
            scaleOffset: {
              type: 'array',
              items: { type: 'number' },
              description: 'X, Y, Z scale multiplier'
            },
            propertyVariations: {
              type: 'object',
              description: 'Property name to array of values'
            },
            targetParents: {
              type: 'array',
              items: { type: 'string' },
              description: 'Different parent per duplicate'
            }
          }
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['instancePath', 'count']
    }
  },
  {
    name: 'mass_duplicate',
    category: 'write',
    description: 'Batch smart_duplicate operations',
    inputSchema: {
      type: 'object',
      properties: {
        duplications: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              instancePath: {
                type: 'string',
                description: 'Instance path (dot notation)'
              },
              count: {
                type: 'number',
                description: 'Number of duplicates'
              },
              options: {
                type: 'object',
                properties: {
                  namePattern: {
                    type: 'string',
                    description: 'Name pattern ({n} placeholder)'
                  },
                  positionOffset: {
                    type: 'array',
                    items: { type: 'number' },
                    description: 'X, Y, Z offset per duplicate'
                  },
                  rotationOffset: {
                    type: 'array',
                    items: { type: 'number' },
                    description: 'X, Y, Z rotation offset'
                  },
                  scaleOffset: {
                    type: 'array',
                    items: { type: 'number' },
                    description: 'X, Y, Z scale multiplier'
                  },
                  propertyVariations: {
                    type: 'object',
                    description: 'Property name to array of values'
                  },
                  targetParents: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Different parent per duplicate'
                  }
                }
              }
            },
            required: ['instancePath', 'count']
          },
          description: 'Duplication operations'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['duplications']
    }
  },

  // === Calculated/Relative Properties ===
];
