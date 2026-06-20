import type { ToolDefinition } from '../definitions.js';

export const BROWSING_TOOL_DEFINITIONS: ToolDefinition[] = [
  // === File & Instance Browsing ===
  {
    name: 'get_file_tree',
    category: 'read',
    description: 'Get instance hierarchy tree from Studio',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Root path (default: game root)'
        },
        instance_id: {
          type: 'string',
          description: 'Connected Studio place id. Required only when multiple places are open.'
        }
      }
    }
  },
  {
    name: 'search_files',
    category: 'read',
    description: 'Search instances by name, class, or script content',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Name, class, or code pattern'
        },
        searchType: {
          type: 'string',
          enum: ['name', 'type', 'content'],
          description: 'Search mode (default: name)'
        },
        instance_id: {
          type: 'string',
          description: 'Connected Studio place id. Required only when multiple places are open.'
        }
      },
      required: ['query']
    }
  },

  // === Place & Service Info ===
  {
    name: 'get_place_info',
    category: 'read',
    description: 'Get place ID, name, and game settings',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: {
          type: 'string',
          description: 'Connected Studio place id. Required only when multiple places are open.'
        }
      }
    }
  },
  {
    name: 'get_services',
    category: 'read',
    description: 'Get available services and their children',
    inputSchema: {
      type: 'object',
      properties: {
        serviceName: {
          type: 'string',
          description: 'Specific service name'
        },
        instance_id: {
          type: 'string',
          description: 'Connected Studio place id. Required only when multiple places are open.'
        }
      }
    }
  },
  {
    name: 'search_objects',
    category: 'read',
    description: 'Find instances by name, class, or properties',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query'
        },
        searchType: {
          type: 'string',
          enum: ['name', 'class', 'property'],
          description: 'Search mode (default: name)'
        },
        propertyName: {
          type: 'string',
          description: 'Property name when searchType is "property"'
        },
        limit: { type: 'number', description: 'Max results to return (token-saving; adds a pagination block).' },
        offset: { type: 'number', description: 'Result offset for paging (default 0).' },
        fields: { type: 'array', items: { type: 'string' }, description: 'Keep only these fields per result (e.g. ["name","className"]) to cut tokens.' },
        instance_id: {
          type: 'string',
          description: 'Connected Studio place id. Required only when multiple places are open.'
        }
      },
      required: ['query']
    }
  },

  // === Instance Inspection ===
  {
    name: 'get_instance_properties',
    category: 'read',
    description: 'Get all properties of an instance',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Instance path (dot notation)'
        },
        excludeSource: {
          type: 'boolean',
          description: 'For scripts, return SourceLength/LineCount instead of full source. Defaults to true (token-saving); pass false to include Source, or use get_script_source.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected Studio place id. Required only when multiple places are open.'
        }
      },
      required: ['instancePath']
    }
  },
  {
    name: 'get_instance_children',
    category: 'read',
    description: 'Get children and their class types',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Instance path (dot notation)'
        },
        instance_id: {
          type: 'string',
          description: 'Connected Studio place id. Required only when multiple places are open.'
        }
      },
      required: ['instancePath']
    }
  },
  {
    name: 'search_by_property',
    category: 'read',
    description: 'Find objects with specific property values',
    inputSchema: {
      type: 'object',
      properties: {
        propertyName: {
          type: 'string',
          description: 'Property name'
        },
        propertyValue: {
          type: 'string',
          description: 'Value to match'
        },
        instance_id: {
          type: 'string',
          description: 'Connected Studio place id. Required only when multiple places are open.'
        }
      },
      required: ['propertyName', 'propertyValue']
    }
  },
  {
    name: 'get_class_info',
    category: 'read',
    description: 'Get properties/methods for a class',
    inputSchema: {
      type: 'object',
      properties: {
        className: {
          type: 'string',
          description: 'Roblox class name'
        },
        instance_id: {
          type: 'string',
          description: 'Connected Studio place id. Required only when multiple places are open.'
        }
      },
      required: ['className']
    }
  },

  // === Project Structure ===
  {
    name: 'get_project_structure',
    category: 'read',
    description: 'Get full game hierarchy tree. Increase maxDepth (default 3) for deeper traversal.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Root path (default: workspace root)'
        },
        maxDepth: {
          type: 'number',
          description: 'Max traversal depth (default: 3)'
        },
        scriptsOnly: {
          type: 'boolean',
          description: 'Show only scripts (default: false)'
        },
        instance_id: {
          type: 'string',
          description: 'Connected Studio place id. Required only when multiple places are open.'
        }
      }
    }
  },
];
