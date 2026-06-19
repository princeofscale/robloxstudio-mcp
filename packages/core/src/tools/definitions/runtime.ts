import type { ToolDefinition } from '../definitions.js';

export const RUNTIME_TOOL_DEFINITIONS: ToolDefinition[] = [
  // === Playtest ===
  {
    name: 'start_playtest',
    category: 'write',
    description: 'Start a simple single-player Studio playtest in play or run mode, waiting until a runtime peer registers with MCP. Captures print/warn/error via LogService. Poll with get_playtest_output, end with stop_playtest. For multi-client testing use multiplayer_test_start instead.',
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
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['mode']
    }
  },
  {
    name: 'stop_playtest',
    category: 'write',
    description: 'Stop playtest and return all captured output.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      }
    }
  },
  {
    name: 'get_playtest_output',
    category: 'read',
    description: 'Poll output buffer without stopping. Returns isRunning and captured messages.',
    inputSchema: {
      type: 'object',
      properties: {
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
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
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
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
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
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
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
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
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
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
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
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
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
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
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
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
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
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
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
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      }
    }
  },
  {
    name: 'get_runtime_logs',
    category: 'read',
    description: 'Read the in-memory log buffers captured by Studio plugin peers. Each buffer captures ~64 KB of recent LogService.MessageOut entries; oldest entries drop when over budget. Entries include capturedBy for the plugin buffer that observed the log. In ordinary Studio play/run sessions, LogService reflects logs across edit/server/client, so script-origin peer is not reliable and entries omit peer. In StudioTestService multiplayer sessions only, peer attribution is reliable and entries also include peer. target=all (default) merges buffers and dedups same-message-and-level entries captured within 2s across different buffers.',
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
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      }
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
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
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
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      }
    }
  },
];
