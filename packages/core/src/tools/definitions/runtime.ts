import type { ToolDefinition } from '../definitions.js';

export const RUNTIME_TOOL_DEFINITIONS: ToolDefinition[] = [
  // === Playtest ===
  {
    name: 'start_playtest',
    category: 'write',
    description: 'Start a simple single-player Studio playtest in play or run mode, waiting until a runtime peer registers with MCP. Read print/warn/error output with get_runtime_logs, then end with stop_playtest. For multi-client testing use multiplayer_test_start instead.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['play', 'run'],
          description: 'Play mode'
        },
        numPlayers: {
          type: 'number',
          description: 'Deprecated and rejected. Use multiplayer_test_start for multi-client testing.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected Studio place id. Required only when multiple places are open.'
        }
      },
      required: ['mode']
    }
  },
  {
    name: 'stop_playtest',
    category: 'write',
    description: 'Stop playtest and wait for runtime peers to disconnect.',
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
    name: 'set_network_profile',
    category: 'write',
    description: 'Apply simulated network conditions to active playtest client peers via NetworkSettings in plugin context. Requires a running playtest and targets only client peers: pass target="client-1", "client-2", etc., or target="all-clients". Presets: great = 30ms total latency (15ms in / 15ms out), 0ms jitter, 0% packet loss; good = 100ms total latency (50ms in / 50ms out), 10ms jitter, 0% packet loss; poor = 300ms (150ms in / 150ms out), 100ms jitter, 0.5% packet loss. profile="custom" applies only the numeric overrides provided; packet loss values above Roblox\'s 0.5% engine limit are rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        profile: {
          type: 'string',
          enum: ['great', 'good', 'poor', 'custom'],
          description: 'Network condition preset. Presets set all six simulation fields; custom requires overrides.'
        },
        target: {
          type: 'string',
          description: 'Client target: "client-1" (default), "client-2", etc., or "all-clients" to apply to every connected playtest client.'
        },
        overrides: {
          type: 'object',
          additionalProperties: false,
          properties: {
            InboundNetworkMinDelayMs: {
              type: 'number',
              minimum: 0,
              description: 'Server-to-client minimum latency in milliseconds.'
            },
            OutboundNetworkMinDelayMs: {
              type: 'number',
              minimum: 0,
              description: 'Client-to-server minimum latency in milliseconds.'
            },
            InboundNetworkJitterMs: {
              type: 'number',
              minimum: 0,
              description: 'Server-to-client latency jitter in milliseconds.'
            },
            OutboundNetworkJitterMs: {
              type: 'number',
              minimum: 0,
              description: 'Client-to-server latency jitter in milliseconds.'
            },
            InboundNetworkLossPercent: {
              type: 'number',
              minimum: 0,
              maximum: 0.5,
              description: 'Server-to-client packet loss percentage. Roblox engine limit is 0.5%; larger values are rejected.'
            },
            OutboundNetworkLossPercent: {
              type: 'number',
              minimum: 0,
              maximum: 0.5,
              description: 'Client-to-server packet loss percentage. Roblox engine limit is 0.5%; larger values are rejected.'
            }
          },
          description: 'Optional exact NetworkSettings property overrides. For preset profiles, overrides replace preset fields. For custom, only these properties are applied.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected Studio place id. Required only when multiple places are open.'
        }
      },
      required: ['profile']
    }
  },
  {
    name: 'get_simulation_state',
    category: 'read',
    description: 'Inspect current NetworkSettings and/or StudioDeviceSimulatorService state for edit and connected playtest clients only. Defaults to include="both" and target="edit-and-clients"; server peers are skipped. Use before diagnosing network or device-sensitive tests, especially because normal Play can write client simulator changes back to edit and StudioTestService clients can inherit stale device simulator state.',
    inputSchema: {
      type: 'object',
      properties: {
        include: {
          type: 'string',
          enum: ['network', 'deviceSimulator', 'both'],
          description: 'Simulation state to inspect: "network", "deviceSimulator", or "both" (default both).'
        },
        target: {
          type: 'string',
          description: 'Simulation target scope: "edit-and-clients" (default), "edit", "all-clients", or a specific "client-N". Server peers are never included.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected Studio place id. Required only when multiple places are open.'
        }
      }
    }
  },
  {
    name: 'reset_simulation_state',
    category: 'write',
    description: 'Reset reachable simulation state to a clean baseline for deterministic tests. Defaults to target="edit-and-clients" and resets both network and device simulator state. Network reset sets all six simulated NetworkSettings fields to 0; device reset calls StopSimulationAsync(). Call before tests, after starting Play or multiplayer, before stopping, and again on edit after stopping.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Simulation target scope: "edit-and-clients" (default), "edit", "all-clients", or a specific "client-N". Server peers are skipped.'
        },
        network: {
          type: 'boolean',
          description: 'Reset simulated NetworkSettings fields to 0 (default true).'
        },
        deviceSimulator: {
          type: 'boolean',
          description: 'Stop Studio device simulation with StopSimulationAsync() (default true).'
        },
        instance_id: {
          type: 'string',
          description: 'Connected Studio place id. Required only when multiple places are open.'
        }
      }
    }
  },
  {
    name: 'get_device_simulator_state',
    category: 'read',
    description: 'Inspect StudioDeviceSimulatorService state and supported built-in device presets. Defaults to target="edit"; also supports a regular playtest client target such as "client-1". Server targets are not supported. When no simulated device is active, active-only fields are omitted and isSimulating=false.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Device simulator target: "edit" (default) or a regular playtest client like "client-1". Server targets are rejected.'
        },
        deviceId: {
          type: 'string',
          description: 'Optional built-in device preset ID to inspect with GetDeviceInfoAsync.'
        },
        includeDeviceList: {
          type: 'boolean',
          description: 'Include the built-in device preset list from GetDeviceListAsync (default true).'
        },
        instance_id: {
          type: 'string',
          description: 'Connected Studio place id. Required only when multiple places are open.'
        }
      }
    }
  },
  {
    name: 'set_device_simulator',
    category: 'write',
    description: 'Set or stop StudioDeviceSimulatorService using built-in device presets only. Defaults to target="edit"; supports "client-N" and "all-clients"; rejects server targets. Applies deviceId first, then orientation, resolution, pixelDensity, and scalingMode overrides.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Device simulator target: "edit" (default), "client-1", "client-2", etc., or "all-clients".'
        },
        deviceId: {
          type: 'string',
          description: 'Built-in device preset ID from get_device_simulator_state.'
        },
        orientation: {
          type: 'string',
          description: 'ScreenOrientation enum name, e.g. "LandscapeRight", "LandscapeLeft", "Portrait", or a full Enum.ScreenOrientation.* string.'
        },
        resolution: {
          type: 'object',
          additionalProperties: false,
          properties: {
            width: {
              type: 'number',
              description: 'Viewport width in pixels.'
            },
            height: {
              type: 'number',
              description: 'Viewport height in pixels.'
            }
          },
          required: ['width', 'height'],
          description: 'Optional resolution override applied after the device preset.'
        },
        pixelDensity: {
          type: 'number',
          description: 'Optional positive pixel density override applied after the device preset.'
        },
        scalingMode: {
          type: 'string',
          description: 'DeviceSimulatorScalingMode enum name, e.g. "ScaleToPhysicalSize", or a full Enum.DeviceSimulatorScalingMode.* string.'
        },
        stopSimulation: {
          type: 'boolean',
          description: 'Stop device simulation. When true, do not pass other simulator setters.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected Studio place id. Required only when multiple places are open.'
        }
      }
    }
  },
  {
    name: 'capture_device_matrix',
    category: 'write',
    description: 'Apply up to 6 ordered Studio device simulator settings, capture each viewport screenshot, and restore the previous simulator state by default when the prior state is default or a built-in preset. Custom device persistence is intentionally unsupported. Defaults to target="edit"; supports regular playtest client targets but not server or all-clients targets.',
    inputSchema: {
      type: 'object',
      properties: {
        entries: {
          type: 'array',
          maxItems: 6,
          description: 'Ordered device capture entries. Each entry may set a deviceId and optional simulator overrides before capture.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              label: {
                type: 'string',
                description: 'Optional label included in the screenshot metadata.'
              },
              deviceId: {
                type: 'string',
                description: 'Built-in device preset ID from get_device_simulator_state.'
              },
              orientation: {
                type: 'string',
                description: 'ScreenOrientation enum name or full Enum.ScreenOrientation.* string.'
              },
              resolution: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  width: {
                    type: 'number',
                    description: 'Viewport width in pixels.'
                  },
                  height: {
                    type: 'number',
                    description: 'Viewport height in pixels.'
                  }
                },
                required: ['width', 'height']
              },
              pixelDensity: {
                type: 'number',
                description: 'Optional positive pixel density override.'
              },
              scalingMode: {
                type: 'string',
                description: 'DeviceSimulatorScalingMode enum name or full Enum.DeviceSimulatorScalingMode.* string.'
              }
            }
          }
        },
        target: {
          type: 'string',
          description: 'Device simulator target: "edit" (default) or a regular playtest client such as "client-1". all-clients and server targets are rejected.'
        },
        format: {
          type: 'string',
          enum: ['jpeg', 'png'],
          description: 'Screenshot image format. "jpeg" (default) is compact; "png" is lossless but may exceed inline size limits.'
        },
        quality: {
          type: 'number',
          description: 'JPEG quality 1-100 (default 92). Ignored for png.'
        },
        settleSeconds: {
          type: 'number',
          description: 'Seconds to wait after applying each simulator entry before capturing (default 0.3).'
        },
        restoreAfter: {
          type: 'boolean',
          description: 'Restore the previous default or built-in preset simulator state after the matrix finishes (default true). Custom active devices are not preserved.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected Studio place id. Required only when multiple places are open.'
        }
      },
      required: ['entries']
    }
  },
  {
    name: 'multiplayer_test_start',
    category: 'write',
    description: 'Start a StudioTestService multiplayer test and wait for the server plus requested client peers to connect. Use this for multi-client runtime testing.',
    inputSchema: {
      type: 'object',
      properties: {
        numPlayers: {
          type: 'number',
          description: 'Number of client players to start (1-8).'
        },
        testArgs: {
          description: 'JSON-compatible table passed to StudioTestService:GetTestArgs() on server and clients.'
        },
        timeout: {
          type: 'number',
          description: 'Max seconds to wait for server + clients to register (default 30).'
        },
        instance_id: {
          type: 'string',
          description: 'Connected Studio place id. Required only when multiple places are open.'
        }
      },
      required: ['numPlayers']
    }
  },
  {
    name: 'multiplayer_test_state',
    category: 'read',
    description: 'Get the active multiplayer StudioTestService state for a place: phase, peers, players, original testArgs, result/error, and connected client roles.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to inspect. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      }
    }
  },
  {
    name: 'multiplayer_test_add_players',
    category: 'write',
    description: 'Add client players to a running StudioTestService multiplayer test and wait for the new clients to connect.',
    inputSchema: {
      type: 'object',
      properties: {
        numPlayers: {
          type: 'number',
          description: 'Number of additional client players to add (1-8).'
        },
        timeout: {
          type: 'number',
          description: 'Max seconds to wait for new clients to register (default 30).'
        },
        instance_id: {
          type: 'string',
          description: 'Connected Studio place id. Required only when multiple places are open.'
        }
      },
      required: ['numPlayers']
    }
  },
  {
    name: 'multiplayer_test_leave_client',
    category: 'write',
    description: 'Disconnect a specific client from a running StudioTestService multiplayer test, then wait for that client peer to leave.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Client target to leave: "client-1" (default), "client-2", etc.'
        },
        timeout: {
          type: 'number',
          description: 'Max seconds to wait for the client peer to disconnect (default 30).'
        },
        instance_id: {
          type: 'string',
          description: 'Connected Studio place id. Required only when multiple places are open.'
        }
      }
    }
  },
  {
    name: 'multiplayer_test_end',
    category: 'write',
    description: 'End a running StudioTestService multiplayer test with an optional return value, then wait for all runtime peers to disconnect.',
    inputSchema: {
      type: 'object',
      properties: {
        value: {
          description: 'JSON-compatible value returned to the edit-side ExecuteMultiplayerTestAsync call.'
        },
        timeout: {
          type: 'number',
          description: 'Max seconds to wait for runtime peers to disconnect (default 30).'
        },
        instance_id: {
          type: 'string',
          description: 'Connected Studio place id. Required only when multiple places are open.'
        }
      }
    }
  },
  {
    name: 'get_runtime_logs',
    category: 'read',
    description: 'Read the in-memory log buffers captured by Studio plugin peers. Each buffer captures ~64 KB of recent LogService output; runtime peers seed from LogService:GetLogHistory() at plugin load so early startup logs emitted before the plugin finishes loading can still be returned, then continue capturing LogService.MessageOut entries. Oldest entries drop when over budget. Entries include capturedBy for the plugin buffer that observed the log. In ordinary Studio play/run sessions, LogService reflects logs across edit/server/client, so script-origin peer is not reliable and entries omit peer. In StudioTestService multiplayer sessions only, peer attribution is reliable and entries also include peer. target=all (default) merges buffers and dedups same-message-and-level entries captured within 2s across different buffers.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Capture buffer to read from: "edit", "server", "client-N", or "all" (default). "all" merges buffers and dedups cross-buffer reflections within a 2s window.'
        },
        since: {
          type: 'number',
          description: 'Return only entries with seq > since. Pass back the previous response\'s nextSince (single target) or perCaptureNextSince entry (target=all) for incremental polling.'
        },
        tail: {
          type: 'number',
          description: 'Return only the last N entries after since/filter is applied.'
        },
        filter: {
          type: 'string',
          description: 'Plain substring matched against each entry\'s message (no pattern semantics; literal text). Applied after since, before tail.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected Studio place id. Required only when multiple places are open.'
        }
      }
    }
  },
  {
    name: 'capture_script_profiler',
    category: 'read',
    description: 'Capture one short ScriptProfilerService sample on a running server or client peer and return a compact CPU summary. Use this for Luau/script optimization, not render, physics, networking, or engine microprofiler lanes. Minimal flow: start or reproduce the workload, call capture_script_profiler with target="server" or a specific "client-N", inspect top_functions, patch the suspected hot path, then capture again with the same target/workload/duration_ms/frequency/filter/min_total_us to compare. top_functions is sorted by descending total_us after native/plugin/min/filter exclusions; each row includes rank plus function_index, the 1-based index into the raw Roblox Functions array. Function and node TotalDuration values follow Roblox\'s exported Script Profiler JSON format and are reported in microseconds as total_us. total_us is cumulative profiler TotalDuration during the capture; nested labels/functions can overlap, so do not sum rows as total CPU time. source is the runtime script path reported by Roblox and may need mapping back to editable source with search tools. If function names are too broad, add debug.profilebegin("Area:SpecificStep") / debug.profileend() around suspected code and pass filter="Area:" or another label prefix; matching custom labels appear in debug_labels and top_functions with their script source and no line number. The result echoes effective options in applied and omitted.filtered_out counts rows removed by filter. Keep captures short while actively triggering the behavior; duration_ms defaults to 1000 and is clamped to 100-15000. Pass output_path when you need the raw Roblox Script Profiler JSON for offline comparison or deeper analysis. This tool owns the start/stop/request profiler lifecycle for one capture and does not expose long-lived profiler sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          pattern: '^(server|client-[0-9]+)$',
          description: 'Runtime peer to profile: "server" (default) or "client-N". Use get_connected_instances to discover available runtime roles. target="edit" is invalid because ScriptProfiler captures running code.'
        },
        duration_ms: {
          type: 'number',
          default: 1000,
          minimum: 100,
          maximum: 15000,
          description: 'Sample duration in milliseconds. Defaults to 1000; clamped to 100-15000 so the Studio bridge does not hang on long captures.'
        },
        frequency: {
          type: 'number',
          default: 1000,
          minimum: 1,
          maximum: 10000,
          description: 'ScriptProfiler sampling frequency in samples per second (Hz). Defaults to 1000.'
        },
        max_functions: {
          type: 'number',
          default: 20,
          minimum: 1,
          maximum: 100,
          description: 'Maximum number of top_functions and debug_labels to return. Defaults to 20; clamped to 1-100.'
        },
        min_total_us: {
          type: 'number',
          default: 0,
          minimum: 0,
          description: 'Omit functions below this TotalDuration in microseconds after capture. Defaults to 0.'
        },
        filter: {
          type: 'string',
          description: 'Optional case-insensitive substring matched against function name and source before top_functions are returned. Useful for focusing on one module or debug.profilebegin label prefix.'
        },
        include_native: {
          type: 'boolean',
          description: 'Include native Roblox frames in top_functions. Defaults to false to keep optimization output focused on game Luau and debug labels.'
        },
        include_plugin: {
          type: 'boolean',
          description: 'Include plugin frames in top_functions. Defaults to false because the MCP capture implementation can otherwise add noise.'
        },
        output_path: {
          type: 'string',
          description: 'Optional local path where the MCP server writes the raw Script Profiler JSON. The tool result then includes output_path instead of inlining the raw JSON.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected Studio place id. Required only when multiple places are open.'
        }
      }
    }
  },
  {
    name: 'breakpoints',
    category: 'write',
    description: 'Manage Studio debugger breakpoints through ScriptDebuggerService. Use this when the user asks to debug with Studio breakpoints. Prefer log breakpoints for agent debugging: pass log_message and let continue_execution default to true, reproduce the issue, then read get_runtime_logs filtered by "Breakpoint". Minimal flow: set a log breakpoint, run or trigger the behavior, call get_runtime_logs with filter="Breakpoint", then call action="clear" to remove MCP-managed breakpoints. Generated breakpoint logs are prefixed with "Breakpoint" plus script_path:line; Studio breakpoint errors also start with "Breakpoint", so this filter captures both successful breakpoint logs and breakpoint-related failures. Set breakpoints on target="edit" before starting a playtest when possible; for an already-running playtest target the runtime DataModel directly, such as "server" or "client-1". Do not set continue_execution=false unless the target DataModel already has a ScriptDebuggerService.OnStopped handler that returns Enum.DebuggerResumeType.Resume for breakpoint/non-exception stops; otherwise the playtest can get stuck and MCP can lose the server/client peers. Minimal OnStopped reference: local sds=game:GetService("ScriptDebuggerService"); sds.OnStopped=function(info) if info.Reason ~= Enum.ScriptStoppedReason.Exception then return Enum.DebuggerResumeType.Resume end print("EXCEPTION:", info.ExceptionText); return Enum.DebuggerResumeType.Resume end. MCP-managed breakpoints persist minimal script_path/line recovery data per place and target so action="list" and action="clear" can find tool-created edit/server/client breakpoints after MCP/plugin reloads. action="clear" removes only breakpoints created through this MCP tool by default; pass clear_all=true only when you intentionally want to clear every Studio breakpoint in the targeted DataModel, including user-created breakpoints. This tool only manages breakpoint lifecycle; it does not pause, resume, step, inspect variables, or install OnStopped callbacks. Requires Studio Debugger Luau API beta enabled.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['set', 'remove', 'clear', 'list'],
          description: 'Breakpoint action to run. set/remove require script_path and line. clear removes MCP-managed breakpoints by default. list returns breakpoints created through this MCP tool in the targeted DataModel.'
        },
        clear_all: {
          type: 'boolean',
          description: 'Only applies to action="clear". Omit or set false to remove only MCP-managed breakpoints tracked by this tool. Set true to call ScriptDebuggerService:ClearBreakpoints() and clear every Studio breakpoint in the targeted DataModel, including user-created breakpoints.'
        },
        script_path: {
          type: 'string',
          description: 'Path to a LuaSourceContainer, for example game.ServerScriptService.Main. Required for set/remove.'
        },
        line: {
          type: 'number',
          description: '1-based line number for set/remove.'
        },
        enabled: {
          type: 'boolean',
          description: 'Whether the breakpoint is enabled when set. Defaults to true.'
        },
        condition: {
          type: 'string',
          description: 'Optional Luau condition expression for set.'
        },
        log_message: {
          type: 'string',
          description: 'Optional Studio breakpoint log expression list for set, such as "\'health\', health". Literal text must be quoted as a Luau string. The tool prefixes this with "Breakpoint" and script_path:line. After reproducing, read get_runtime_logs with filter="Breakpoint" so breakpoint logs and Studio breakpoint errors are both visible.'
        },
        continue_execution: {
          type: 'boolean',
          description: 'Whether the breakpoint should log and continue without pausing. Defaults to true when log_message is provided; otherwise false. Only set false when you have first installed a ScriptDebuggerService.OnStopped handler on the same target that resumes breakpoint/non-exception stops with Enum.DebuggerResumeType.Resume; without that handler the playtest can get stuck and MCP can lose server/client peers.'
        },
        target: {
          type: 'string',
          description: 'Peer to target: "edit" (default), "server", or "client-N". Set edit breakpoints before playtests; target server/client-N for running play DataModels.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected Studio place id. Required only when multiple places are open.'
        }
      },
      required: ['action']
    }
  },

  // === Multi-Instance ===
  {
    name: 'get_connected_instances',
    category: 'read',
    description: 'List all connected plugin instances with their roles. Use during multi-client playtest to discover server and client instances for targeted commands.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },

  // === Undo/Redo ===
  {
    name: 'undo',
    category: 'write',
    description: 'Undo the last change in Roblox Studio. Uses ChangeHistoryService to reverse the most recent operation.',
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
    name: 'redo',
    category: 'write',
    description: 'Redo the last undone change in Roblox Studio. Uses ChangeHistoryService to reapply the most recently undone operation.',
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
];
