import type { ToolDefinition } from '../definitions.js';

export const SCENE_TOOL_DEFINITIONS: ToolDefinition[] = [
  // === Input Simulation ===
  {
    name: 'simulate_mouse_input',
    category: 'write',
    description: 'Simulate a mouse click in the running game via UserInputService:CreateVirtualInput. Use during a playtest to click UI buttons, interact with objects, or aim. Fires real UserInputService input and activates GUI buttons. Coordinates are viewport pixels matching capture_screenshot (top-left is 0,0) — take a screenshot first to find positions. Auto-targets the running client; only works during a playtest. Note: only click/mouseDown/mouseUp are supported (the API has no mouse-move or scroll).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['click', 'mouseDown', 'mouseUp'],
          description: 'Mouse action. "click" does mouseDown + short delay + mouseUp.'
        },
        x: {
          type: 'number',
          description: 'Viewport pixel X coordinate (as seen in capture_screenshot)'
        },
        y: {
          type: 'number',
          description: 'Viewport pixel Y coordinate (as seen in capture_screenshot)'
        },
        button: {
          type: 'string',
          enum: ['Left', 'Right', 'Middle'],
          description: 'Mouse button (default: Left)'
        },
        target: {
          type: 'string',
          description: 'Instance target. Defaults to the running playtest client (client-1) when present, else "edit". Override with "server", "client-2", etc.'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['action', 'x', 'y']
    }
  },
  {
    name: 'simulate_keyboard_input',
    category: 'write',
    description: 'Simulate keyboard input in the running game via UserInputService:CreateVirtualInput. Use during a playtest for character movement (W/A/S/D walks at full WalkSpeed with player controls intact), jumping (Space), interactions (E), or any key-driven action. Drives the real input pipeline so game scripts and control modules respond. For sustained movement use action="press" to hold and "release" to let go. Pass "text" instead of keyCode to type a string into the focused TextBox. Auto-targets the running client; only works during a playtest.',
    inputSchema: {
      type: 'object',
      properties: {
        keyCode: {
          type: 'string',
          description: 'Enum.KeyCode name: "W", "A", "S", "D", "Space", "E", "F", "LeftShift", "LeftControl", "Return", "Tab", "Escape", "One", "Two", etc. Omit if using "text".'
        },
        action: {
          type: 'string',
          enum: ['press', 'release', 'tap'],
          description: '"tap" (default) = press + wait + release. "press" = key down only. "release" = key up only.'
        },
        duration: {
          type: 'number',
          description: 'Hold duration in seconds for "tap" action (default: 0.1). Use longer values for sustained input like walking.'
        },
        text: {
          type: 'string',
          description: 'Type this string into the currently focused TextBox (uses SendTextInput). When provided, keyCode/action are ignored.'
        },
        target: {
          type: 'string',
          description: 'Instance target. Defaults to the running playtest client (client-1) when present, else "edit". Override with "server", "client-2", etc.'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      }
    }
  },

  // === Character Navigation ===
  {
    name: 'character_navigation',
    category: 'write',
    description: 'Move the player character to a target position or instance during playtest. Uses PathfindingService for automatic navigation around obstacles, falling back to direct movement. Requires an active playtest in "play" mode. Does NOT simulate player input - moves the character directly.',
    inputSchema: {
      type: 'object',
      properties: {
        position: {
          type: 'array',
          items: { type: 'number' },
          description: 'Target world position [x, y, z]. Either this or instancePath is required.'
        },
        instancePath: {
          type: 'string',
          description: 'Instance to navigate to (dot notation). The character walks to its Position. Either this or position is required.'
        },
        waitForCompletion: {
          type: 'boolean',
          description: 'Wait for the character to arrive before returning (default: true)'
        },
        timeout: {
          type: 'number',
          description: 'Max seconds to wait for navigation to complete (default: 25)'
        },
        target: {
          type: 'string',
          description: 'Instance target: "edit" (default), "server", "client-1", "client-2", etc.'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      }
    }
  },

  // === Instance Operations ===
  {
    name: 'clone_object',
    category: 'write',
    description: 'Clone an instance to a new parent location. Creates a deep copy of the instance and all its descendants.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Path of the instance to clone'
        },
        targetParentPath: {
          type: 'string',
          description: 'Path of the parent to place the clone under'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['instancePath', 'targetParentPath']
    }
  },

  // === Descendants & Comparison ===
  {
    name: 'get_descendants',
    category: 'read',
    description: 'Get all descendants of an instance recursively with depth info. More efficient than repeated get_instance_children calls.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Root instance path'
        },
        maxDepth: {
          type: 'number',
          description: 'Maximum recursion depth (default: 10)'
        },
        classFilter: {
          type: 'string',
          description: 'Only include instances of this class (uses IsA, so "BasePart" matches Part, MeshPart, etc.)'
        },
        limit: { type: 'number', description: 'Max descendants to return (token-saving; adds a pagination block with total/hasMore).' },
        offset: { type: 'number', description: 'Descendant offset for paging (default 0).' },
        fields: { type: 'array', items: { type: 'string' }, description: 'Keep only these fields per descendant (e.g. ["name","className","path"]) to cut tokens.' },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['instancePath']
    }
  },
  {
    name: 'get_scene_summary',
    category: 'read',
    description: 'Token-lean scene overview: counts descendants by ClassName under a path and returns totals + the top-N classes, instead of dumping the whole tree. Use before get_descendants to understand a scene cheaply.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: { type: 'string', description: 'Root path to summarize (default game.Workspace).' },
        topN: { type: 'number', description: 'How many of the most common classes to list (default 20).' },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      }
    }
  },
  {
    name: 'compare_instances',
    category: 'read',
    description: 'Diff two instances by comparing their properties. Useful for debugging why a duplicate behaves differently.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePathA: {
          type: 'string',
          description: 'First instance path'
        },
        instancePathB: {
          type: 'string',
          description: 'Second instance path'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['instancePathA', 'instancePathB']
    }
  },

  // === Output & Diagnostics ===
  {
    name: 'get_output_log',
    category: 'read',
    description: 'Get the Studio output log history. Works in both edit and play mode.',
    inputSchema: {
      type: 'object',
      properties: {
        maxEntries: {
          type: 'number',
          description: 'Maximum number of log entries to return (default: 100)'
        },
        messageType: {
          type: 'string',
          description: 'Filter by message type (e.g. "Enum.MessageType.MessageOutput", "Enum.MessageType.MessageWarning", "Enum.MessageType.MessageError")'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      }
    }
  },

  // === Bulk Attributes ===
  {
    name: 'bulk_set_attributes',
    category: 'write',
    description: 'Set multiple attributes on an instance in a single call. More efficient than repeated set_attribute calls.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Instance path'
        },
        attributes: {
          type: 'object',
          description: 'Map of attribute names to values. Supports Vector3, Color3, UDim2 via _type convention.'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['instancePath', 'attributes']
    }
  },

  // === Per-peer memory breakdown ===
  {
    name: 'get_memory_breakdown',
    category: 'read',
    description: 'Read per-category memory usage by iterating Enum.DeveloperMemoryTag and calling Stats:GetMemoryUsageMbForTag per item (workaround for Stats:GetMemoryUsageMbAllCategories being gated by Capabilities: InternalTest and not callable from plugin context), plus Stats:GetTotalMemoryUsageMb for the rollup. target="all" (default) returns { peer: { total_mb, categories, timestamp } } for every connected peer except edit-proxy; single-peer targets return that peer\'s object directly. Optional tags whitelist filters to only those DeveloperMemoryTag entries; unknown tags come back with value 0 and are listed in unknown_tags so cross-version drift doesn\'t error. timestamp is Unix milliseconds (DateTime.now().UnixTimestampMillis). Per-peer MemoryTrackingEnabled=false surfaces as { error } on that peer only.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Peer to read from: "edit", "server", "client-N", or "all" (default).'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional DeveloperMemoryTag whitelist. Unknown tag names return 0 + unknown_tags list.'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      }
    }
  },
  {
    name: 'get_scene_analysis',
    category: 'read',
    description: 'Read Roblox SceneAnalysisService data for attribution-focused performance analysis. Complements get_memory_breakdown: returns compact top-N entries for instance composition, script memory, unparented instances, triangle composition, animation memory, and audio memory. Requires the Studio Scene Analysis beta feature; if disabled, returns scene_analysis_not_enabled with betaFeatureRequired=true. target="all" (default) returns per-peer data; single-peer targets return that peer directly. raw=true includes the full nested Scene Analysis tree.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['all', 'instance_composition', 'script_memory', 'unparented_instances', 'triangle_composition', 'animation_memory', 'audio_memory'],
          description: 'Scene analysis mode to read. Defaults to "all".'
        },
        target: {
          type: 'string',
          description: 'Peer to read from: "edit", "server", "client-N", or "all" (default).'
        },
        topN: {
          type: 'number',
          minimum: 1,
          maximum: 100,
          description: 'Number of flattened top entries to include per mode. Defaults to 10; plugin clamps to 1-100.'
        },
        raw: {
          type: 'boolean',
          description: 'Include the full nested SceneAnalysisService tree in each mode result. Defaults to false.'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      }
    }
  },

  // === SerializationService round-trip ===
  {
    name: 'export_rbxm',
    category: 'read',
    description: 'Serialize one or more instances to a .rbxm file on disk via SerializationService:SerializeInstancesAsync (engine v668+, PluginSecurity). Throws if any path resolves to nil, a service, or a non-creatable instance.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'DataModel paths to serialize (e.g. ["Workspace.TestRig", "ServerStorage.Templates.NPC"])'
        },
        output_path: {
          type: 'string',
          description: 'Absolute filesystem path where the .rbxm should be written'
        },
        target: {
          type: 'string',
          enum: ['edit', 'server'],
          description: 'Which DataModel to read from (default: "edit"). "server" serializes live runtime state during a playtest.'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['instance_paths', 'output_path']
    }
  },
  {
    name: 'import_rbxm',
    category: 'write',
    description: 'Deserialize a .rbxm via SerializationService:DeserializeInstancesAsync (engine v668+, PluginSecurity) and parent the resulting instances under parent_path. All-or-nothing parenting: if any single instance fails to parent, every already-parented sibling is unparented and the call errors. Wrapped in ChangeHistoryService for edit target so one Ctrl+Z reverses the whole import.',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'object',
          description: 'Exactly one of { path }, { url }, or { base64 }. path = read from local disk; url = http(s) only, fetched by the MCP server process, capped at 50 MiB; base64 = raw bytes inline.',
          properties: {
            path: { type: 'string' },
            url: { type: 'string' },
            base64: { type: 'string' }
          },
          oneOf: [
            { required: ['path'] },
            { required: ['url'] },
            { required: ['base64'] }
          ]
        },
        parent_path: {
          type: 'string',
          description: 'DataModel path of the Instance to parent imported instances under (e.g. "ServerStorage.Imported")'
        },
        target: {
          type: 'string',
          enum: ['edit', 'server'],
          description: 'Which DataModel to import into (default: "edit"). "server" parents into the live play-server DM.'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['source', 'parent_path']
    }
  },

  // === Find and Replace ===
  {
    name: 'find_and_replace_in_scripts',
    category: 'write',
    description: 'Find and replace text across all scripts in the game. Supports literal and Lua pattern matching. Use dryRun to preview changes before applying. Pairs with grep_scripts for search-only operations.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Text or Lua pattern to find'
        },
        replacement: {
          type: 'string',
          description: 'Replacement text. When usePattern is true, supports Lua captures (%1, %2, etc.).'
        },
        caseSensitive: {
          type: 'boolean',
          description: 'Case-sensitive matching (default: false). Must be true when usePattern is true.'
        },
        usePattern: {
          type: 'boolean',
          description: 'Use Lua pattern matching instead of literal (default: false). Requires caseSensitive: true.'
        },
        path: {
          type: 'string',
          description: 'Limit scope to a subtree (e.g. "game.ServerScriptService")'
        },
        classFilter: {
          type: 'string',
          enum: ['Script', 'LocalScript', 'ModuleScript'],
          description: 'Only search scripts of this class type'
        },
        dryRun: {
          type: 'boolean',
          description: 'Preview changes without applying them (default: false)'
        },
        maxReplacements: {
          type: 'number',
          description: 'Safety limit on total replacements (default: 1000)'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['pattern', 'replacement']
    }
  },

  // === Safety / audit ===
  {
    name: 'get_operation_history',
    category: 'read',
    description: 'List recent destructive/bulk operations recorded by the safety layer (deletes, bulk creates, script overwrites, Luau runs, restores), most recent first.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of entries to return (default 50).'
        }
      }
    }
  },
  {
    name: 'list_script_backups',
    category: 'read',
    description: 'List script sources the safety layer backed up before set_script_source overwrote them. Restore any of them with restore_script_backup.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'restore_script_backup',
    category: 'write',
    description: 'Restore a script to the source captured before the most recent set_script_source overwrite. Use list_script_backups to see available paths.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Script instance path to restore (must have a backup).'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['instancePath']
    }
  },
];
