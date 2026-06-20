import type { ToolDefinition } from '../definitions.js';

export const ASSET_TOOL_DEFINITIONS: ToolDefinition[] = [
  // === Asset Tools ===
  {
    name: 'search_assets',
    category: 'read',
    description: 'Search the Creator Store (Roblox marketplace) for assets by type and keywords. Requires ROBLOX_OPEN_CLOUD_API_KEY env var (no cookie auth for this endpoint).',
    inputSchema: {
      type: 'object',
      properties: {
        assetType: {
          type: 'string',
          enum: ['Audio', 'Model', 'Decal', 'Plugin', 'MeshPart', 'Video', 'FontFamily'],
          description: 'Type of asset to search for'
        },
        query: {
          type: 'string',
          description: 'Search keywords'
        },
        maxResults: {
          type: 'number',
          description: 'Max results to return (default: 25)'
        },
        sortBy: {
          type: 'string',
          enum: ['Relevance', 'Trending', 'Top', 'AudioDuration', 'CreateTime', 'UpdatedTime', 'Ratings'],
          description: 'Sort order (default: Relevance)'
        },
        verifiedCreatorsOnly: {
          type: 'boolean',
          description: 'Only show assets from verified creators (default: false)'
        }
      },
      required: ['assetType']
    }
  },
  {
    name: 'get_asset_details',
    category: 'read',
    description: 'Get detailed marketplace metadata for a specific asset. Uses ROBLOX_OPEN_CLOUD_API_KEY or falls back to ROBLOSECURITY cookie (own assets only).',
    inputSchema: {
      type: 'object',
      properties: {
        assetId: {
          type: 'number',
          description: 'The Roblox asset ID'
        }
      },
      required: ['assetId']
    }
  },
  {
    name: 'get_asset_thumbnail',
    category: 'read',
    description: 'Get the thumbnail image for an asset as base64 PNG, suitable for vision LLMs. Thumbnails API is public but asset validation uses ROBLOX_OPEN_CLOUD_API_KEY.',
    inputSchema: {
      type: 'object',
      properties: {
        assetId: {
          type: 'number',
          description: 'The Roblox asset ID'
        },
        size: {
          type: 'string',
          enum: ['150x150', '420x420', '768x432'],
          description: 'Thumbnail size (default: 420x420)'
        }
      },
      required: ['assetId']
    }
  },
  {
    name: 'insert_asset',
    category: 'write',
    description: 'Insert a Roblox asset into Studio by loading it via AssetService and parenting it to a target location. Optionally set position.',
    inputSchema: {
      type: 'object',
      properties: {
        assetId: {
          type: 'number',
          description: 'The Roblox asset ID to insert'
        },
        parentPath: {
          type: 'string',
          description: 'Parent instance path (default: game.Workspace)'
        },
        position: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            z: { type: 'number' }
          },
          description: 'Optional world position to place the asset'
        },
        instance_id: {
          type: 'string',
          description: 'Connected Studio place id. Required only when multiple places are open.'
        }
      },
      required: ['assetId']
    }
  },
  {
    name: 'preview_asset',
    category: 'read',
    description: 'Preview a Roblox asset without permanently inserting it. Loads the asset, builds a hierarchy tree with properties and summary stats, then destroys it. Useful for inspecting asset contents before insertion.',
    inputSchema: {
      type: 'object',
      properties: {
        assetId: {
          type: 'number',
          description: 'The Roblox asset ID to preview'
        },
        includeProperties: {
          type: 'boolean',
          description: 'Include detailed properties for each instance (default: true)'
        },
        maxDepth: {
          type: 'number',
          description: 'Max hierarchy traversal depth (default: 10)'
        },
        instance_id: {
          type: 'string',
          description: 'Connected Studio place id. Required only when multiple places are open.'
        }
      },
      required: ['assetId']
    }
  },
  {
    name: 'upload_asset',
    category: 'write',
    description: 'Upload any supported asset type to Roblox: Audio (mp3/ogg/wav/flac), Decal (png/jpg/bmp/tga), Model (fbx/gltf/glb/rbxm/rbxmx), Animation (rbxm/rbxmx), or Video (mp4/mov). Decal supports ROBLOSECURITY cookie auth or ROBLOX_OPEN_CLOUD_API_KEY. All other types require Open Cloud API key with asset:write scope + creator ID. Audio: max 7 min, 100 uploads/month (ID-verified). Video: max 5 min, requires 13+ ID-verified.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Absolute path to the file on disk'
        },
        assetType: {
          type: 'string',
          enum: ['Audio', 'Decal', 'Model', 'Animation', 'Video'],
          description: 'Type of asset to upload. Must match the file format.'
        },
        displayName: {
          type: 'string',
          description: 'Display name for the asset (max 50 characters)'
        },
        description: {
          type: 'string',
          description: 'Description for the asset (default: empty string)'
        },
        userId: {
          type: 'string',
          description: 'Roblox user ID for the asset creator. Overrides ROBLOX_CREATOR_USER_ID env var.'
        },
        groupId: {
          type: 'string',
          description: 'Roblox group ID for the asset creator. Overrides ROBLOX_CREATOR_GROUP_ID env var. Takes precedence over userId if both provided.'
        }
      },
      required: ['filePath', 'assetType', 'displayName']
    }
  },
  {
    name: 'capture_screenshot',
    category: 'read',
    description: 'Capture the Roblox Studio viewport at native resolution and return it as an image, plus a text line stating the exact pixel dimensions. Works in Edit mode and regular playtests (auto-detects a running client and captures the live play viewport). StudioTestService multiplayer client screenshots are currently blocked by Roblox temporary-texture process scoping; the tool returns a clear error in that case. The returned image is never downscaled, so its pixel grid is exactly the coordinate space simulate_mouse_input uses — read click positions straight off this image. For reading fine text/UI, use format="png" (lossless) or a higher quality; enlarging the Studio window raises resolution. Requires EditableImage API enabled (Game Settings > Security > "Allow Mesh / Image APIs") and the window to be visible.',
    inputSchema: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['jpeg', 'png'],
          description: 'Image format. "jpeg" (default) is compact and crisp at high quality. "png" is lossless — best for reading dense text/UI, but larger (a busy 3D scene may be big).'
        },
        quality: {
          type: 'number',
          description: 'JPEG quality 1-100 (default 92). Higher = sharper text, larger size. Ignored for png.'
        },
        instance_id: {
          type: 'string',
          description: 'Connected Studio place id. Required only when multiple places are open.'
        }
      },
    }
  },
];
