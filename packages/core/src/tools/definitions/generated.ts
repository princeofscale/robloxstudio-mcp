import type { ToolDefinition } from '../definitions.js';
import { INSTANCE_ID_PROP, UDIM2_PROP, RGB_PROP, VEC3_PROP, GUI_OBJECT_PROPS } from './shared.js';

export const GENERATED_TOOL_DEFINITIONS: ToolDefinition[] = [
  // === UI builder tools ===
  {
    name: 'ui_create_screen_gui',
    category: 'write',
    description: 'Create a ScreenGui container (defaults to StarterGui). Returns the new instance path. Build elements inside it with ui_create_frame/text/image tools.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name for the ScreenGui.' },
        parentPath: { type: 'string', description: 'Parent path (default "StarterGui").' },
        ignoreGuiInset: { type: 'boolean', description: 'Ignore the top-bar inset.' },
        resetOnSpawn: { type: 'boolean', description: 'Recreate the GUI each spawn (default Roblox behavior).' },
        displayOrder: { type: 'number', description: 'Render order among ScreenGuis.' },
        instance_id: INSTANCE_ID_PROP,
      },
      required: ['name'],
    },
  },
  {
    name: 'ui_create_frame',
    category: 'write',
    description: 'Create a Frame inside a GUI container. Size/Position use UDim2 arrays [scaleX, offsetX, scaleY, offsetY].',
    inputSchema: { type: 'object', properties: GUI_OBJECT_PROPS, required: ['parentPath'] },
  },
  {
    name: 'ui_create_text_label',
    category: 'write',
    description: 'Create a TextLabel. Supports text, font, TextScaled, and colors.',
    inputSchema: { type: 'object', properties: GUI_OBJECT_PROPS, required: ['parentPath'] },
  },
  {
    name: 'ui_create_text_button',
    category: 'write',
    description: 'Create a TextButton. Supports text, font, TextScaled, and colors.',
    inputSchema: { type: 'object', properties: GUI_OBJECT_PROPS, required: ['parentPath'] },
  },
  {
    name: 'ui_create_image_label',
    category: 'write',
    description: 'Create an ImageLabel. Set image to an "rbxassetid://..." string.',
    inputSchema: { type: 'object', properties: GUI_OBJECT_PROPS, required: ['parentPath'] },
  },
  {
    name: 'ui_create_image_button',
    category: 'write',
    description: 'Create an ImageButton. Set image to an "rbxassetid://..." string.',
    inputSchema: { type: 'object', properties: GUI_OBJECT_PROPS, required: ['parentPath'] },
  },
  {
    name: 'ui_apply_layout',
    category: 'write',
    description: 'Add a UIListLayout or UIGridLayout to a GUI container so its children arrange automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        targetPath: { type: 'string', description: 'Container to add the layout to.' },
        layout: { type: 'string', enum: ['list', 'grid'], description: 'Layout type.' },
        fillDirection: { type: 'string', description: 'List only: "Vertical" or "Horizontal".' },
        padding: { type: 'number', description: 'Pixel padding between items.' },
        cellSize: UDIM2_PROP,
        horizontalAlignment: { type: 'string', description: 'Enum.HorizontalAlignment member.' },
        verticalAlignment: { type: 'string', description: 'Enum.VerticalAlignment member.' },
        sortOrder: { type: 'string', description: 'Enum.SortOrder member (default LayoutOrder).' },
        instance_id: INSTANCE_ID_PROP,
      },
      required: ['targetPath', 'layout'],
    },
  },
  {
    name: 'ui_make_mobile_friendly',
    category: 'write',
    description: 'Apply responsive safeguards (UIScale + TextScaled) to every GuiObject under the target so the UI reflows on small screens.',
    inputSchema: {
      type: 'object',
      properties: {
        targetPath: { type: 'string', description: 'GUI container/path to make mobile-friendly.' },
        instance_id: INSTANCE_ID_PROP,
      },
      required: ['targetPath'],
    },
  },

  // === Environment / lighting tools ===
  {
    name: 'environment_set_time_of_day',
    category: 'write',
    description: 'Set Lighting time. Pass a number (0-24 ClockTime) or an "HH:MM:SS" string.',
    inputSchema: {
      type: 'object',
      properties: {
        time: { description: 'Number 0-24 (ClockTime) or "HH:MM:SS" string.' },
        instance_id: INSTANCE_ID_PROP,
      },
      required: ['time'],
    },
  },
  {
    name: 'environment_set_lighting_preset',
    category: 'write',
    description: 'Apply a named lighting preset: sunny, sunset, night, horror, cyberpunk, obby, simulator, realistic. Set withPostFx for a polished look (Future lighting + idempotent Bloom/ColorCorrection/SunRays).',
    inputSchema: {
      type: 'object',
      properties: {
        preset: { type: 'string', enum: ['sunny', 'sunset', 'night', 'horror', 'cyberpunk', 'obby', 'simulator', 'realistic'], description: 'Preset name.' },
        withPostFx: { type: 'boolean', description: 'Also enable Future lighting + add named, idempotent Bloom/ColorCorrection/SunRays effects (default false).' },
        instance_id: INSTANCE_ID_PROP,
      },
      required: ['preset'],
    },
  },
  {
    name: 'environment_set_atmosphere',
    category: 'write',
    description: 'Create or update the Lighting Atmosphere (density, color, decay, glare, haze).',
    inputSchema: {
      type: 'object',
      properties: {
        density: { type: 'number', description: 'Atmosphere density 0-1.' },
        offset: { type: 'number', description: 'Atmosphere offset.' },
        color: RGB_PROP,
        decay: RGB_PROP,
        glare: { type: 'number', description: 'Sun glare 0-10.' },
        haze: { type: 'number', description: 'Haze 0-10.' },
        instance_id: INSTANCE_ID_PROP,
      },
    },
  },
  {
    name: 'environment_set_sky',
    category: 'write',
    description: 'Create or update the Lighting Sky (sun/moon textures, star count, skybox faces).',
    inputSchema: {
      type: 'object',
      properties: {
        sunTextureId: { type: 'string', description: 'Sun texture asset id.' },
        moonTextureId: { type: 'string', description: 'Moon texture asset id.' },
        starCount: { type: 'number', description: 'Number of stars.' },
        skyboxFaces: { type: 'string', description: 'A single asset id applied to all six skybox faces.' },
        celestialBodiesShown: { type: 'boolean', description: 'Show sun/moon/stars.' },
        instance_id: INSTANCE_ID_PROP,
      },
    },
  },
  {
    name: 'environment_create_day_night_cycle_script',
    category: 'write',
    description: 'Generate a Script in ServerScriptService that continuously advances Lighting.ClockTime. Replaces an existing one of the same name.',
    inputSchema: {
      type: 'object',
      properties: {
        minutesPerDay: { type: 'number', description: 'Real minutes per in-game day (default 10).' },
        scriptName: { type: 'string', description: 'Script name (default "DayNightCycle").' },
        instance_id: INSTANCE_ID_PROP,
      },
    },
  },

  // === Terrain / world tools ===
  {
    name: 'terrain_generate_baseplate',
    category: 'write',
    description: 'Fill a flat terrain slab. Volume is capped by the safety layer; use dryRun to preview.',
    inputSchema: {
      type: 'object',
      properties: {
        size: VEC3_PROP,
        position: VEC3_PROP,
        material: { type: 'string', description: 'Enum.Material member name (default "Grass").' },
        dryRun: { type: 'boolean', description: 'Preview without filling.' },
        confirm: { type: 'boolean', description: 'Approve a gated fill.' },
        instance_id: INSTANCE_ID_PROP,
      },
      required: ['size'],
    },
  },
  {
    name: 'terrain_generate_island',
    category: 'write',
    description: 'Fill a ball of land at a center point, optionally surrounded by water.',
    inputSchema: {
      type: 'object',
      properties: {
        center: VEC3_PROP,
        radius: { type: 'number', description: 'Island radius in studs.' },
        material: { type: 'string', description: 'Land material (default "Sand").' },
        waterMaterial: { type: 'string', description: 'Optional surrounding water material.' },
        waterRadius: { type: 'number', description: 'Optional water disk radius.' },
        dryRun: { type: 'boolean', description: 'Preview without filling.' },
        confirm: { type: 'boolean', description: 'Approve a gated fill.' },
        instance_id: INSTANCE_ID_PROP,
      },
      required: ['center', 'radius'],
    },
  },
  {
    name: 'terrain_generate_mountains',
    category: 'write',
    description: 'Generate noise-driven mountain terrain across a region. Volume (extent x maxHeight) is capped by the safety layer.',
    inputSchema: {
      type: 'object',
      properties: {
        center: VEC3_PROP,
        extent: { type: 'array', items: { type: 'number' }, description: 'Region footprint as [x, z] studs.' },
        maxHeight: { type: 'number', description: 'Maximum peak height in studs.' },
        material: { type: 'string', description: 'Material (default "Rock").' },
        resolution: { type: 'number', description: 'Column size in studs (default 16, min 4).' },
        seed: { type: 'number', description: 'Noise seed.' },
        frequency: { type: 'number', description: 'Noise frequency divisor (default 100).' },
        dryRun: { type: 'boolean', description: 'Preview without filling.' },
        confirm: { type: 'boolean', description: 'Approve a gated fill.' },
        instance_id: INSTANCE_ID_PROP,
      },
      required: ['center', 'extent', 'maxHeight'],
    },
  },
  {
    name: 'terrain_generate_water',
    category: 'write',
    description: 'Fill a block of Water material (e.g. an ocean or lake).',
    inputSchema: {
      type: 'object',
      properties: {
        size: VEC3_PROP,
        position: VEC3_PROP,
        dryRun: { type: 'boolean', description: 'Preview without filling.' },
        confirm: { type: 'boolean', description: 'Approve a gated fill.' },
        instance_id: INSTANCE_ID_PROP,
      },
      required: ['size'],
    },
  },
  {
    name: 'terrain_paint_material',
    category: 'write',
    description: 'Fill a region with a material, or replace one material with another inside the region (set replaceMaterial).',
    inputSchema: {
      type: 'object',
      properties: {
        min: VEC3_PROP,
        max: VEC3_PROP,
        material: { type: 'string', description: 'Target Enum.Material member.' },
        replaceMaterial: { type: 'string', description: 'If set, only replaces this source material.' },
        dryRun: { type: 'boolean', description: 'Preview without painting.' },
        confirm: { type: 'boolean', description: 'Approve a gated operation.' },
        instance_id: INSTANCE_ID_PROP,
      },
      required: ['min', 'max', 'material'],
    },
  },
  {
    name: 'terrain_clear_region',
    category: 'write',
    description: 'Clear (fill with Air) a terrain region. Irreversible — requires confirm:true. Use dryRun to preview.',
    inputSchema: {
      type: 'object',
      properties: {
        min: VEC3_PROP,
        max: VEC3_PROP,
        dryRun: { type: 'boolean', description: 'Preview without clearing.' },
        confirm: { type: 'boolean', description: 'Required to actually clear the region.' },
        instance_id: INSTANCE_ID_PROP,
      },
      required: ['min', 'max'],
    },
  },

  // === Game templates ===
  {
    name: 'template_create_obby_game',
    category: 'write',
    description: 'Scaffold a complete obby: spawn, numbered checkpoints, kill bricks, a finish, leaderstats + checkpoint server logic, and a timer HUD. Idempotent.',
    inputSchema: {
      type: 'object',
      properties: {
        checkpoints: { type: 'number', description: 'Number of checkpoints beyond the start (default 5).' },
        instance_id: INSTANCE_ID_PROP,
      },
    },
  },
  {
    name: 'template_create_simulator_game',
    category: 'write',
    description: 'Scaffold a simulator: currency leaderstat, a click button HUD + RemoteEvent, a shop folder, and a placeholder data ModuleScript. Idempotent.',
    inputSchema: {
      type: 'object',
      properties: {
        currencyName: { type: 'string', description: 'Currency name (default "Coins").' },
        instance_id: INSTANCE_ID_PROP,
      },
    },
  },
  {
    name: 'template_create_tycoon_game',
    category: 'write',
    description: 'Scaffold a tycoon: a plot with a base, a purchase button (ProximityPrompt + touch), a Cash leaderstat, and a basic buy/unlock flow. Idempotent.',
    inputSchema: {
      type: 'object',
      properties: {
        startingCash: { type: 'number', description: 'Starting Cash per player (default 0).' },
        buttonPrice: { type: 'number', description: 'Price of the first button (default 50).' },
        instance_id: INSTANCE_ID_PROP,
      },
    },
  },
  {
    name: 'template_create_round_game',
    category: 'write',
    description: 'Scaffold a round-based game: a lobby with spawn, an arena with teleport points, and a server round loop (intermission → teleport in → round → teleport out). Idempotent.',
    inputSchema: {
      type: 'object',
      properties: {
        roundSeconds: { type: 'number', description: 'Round length in seconds (default 90).' },
        intermissionSeconds: { type: 'number', description: 'Intermission length in seconds (default 15).' },
        teleportPoints: { type: 'number', description: 'Number of arena teleport points (default 4).' },
        instance_id: INSTANCE_ID_PROP,
      },
    },
  },

  // === Local sync ===
  {
    name: 'sync_pull',
    category: 'read',
    description: 'Pull every Script/LocalScript/ModuleScript from Studio into local files (.server.lua/.client.lua/.module.lua) and write a sync manifest. Does not modify Studio.',
    inputSchema: {
      type: 'object',
      properties: {
        syncDir: { type: 'string', description: 'Target directory (default ./roblox-src or $ROBLOX_SYNC_DIR).' },
        instance_id: INSTANCE_ID_PROP,
      },
    },
  },
  {
    name: 'sync_status',
    category: 'read',
    description: 'Compare local files against Studio using the sync manifest. Reports local-only changes, studio-only changes, and conflicts (both sides changed). Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        syncDir: { type: 'string', description: 'Sync directory (default ./roblox-src or $ROBLOX_SYNC_DIR).' },
        instance_id: INSTANCE_ID_PROP,
      },
    },
  },
  {
    name: 'sync_push',
    category: 'write',
    description: 'Push locally-changed scripts back into Studio. Skips files that also changed in Studio (conflicts) instead of overwriting; use dryRun to preview. Resolve conflicts manually or sync_pull to take Studio.',
    inputSchema: {
      type: 'object',
      properties: {
        syncDir: { type: 'string', description: 'Sync directory (default ./roblox-src or $ROBLOX_SYNC_DIR).' },
        dryRun: { type: 'boolean', description: 'Preview which files would be pushed without writing to Studio.' },
        confirm: { type: 'boolean', description: 'Reserved for future gated pushes.' },
        instance_id: INSTANCE_ID_PROP,
      },
    },
  },

  // === Free marketplace (no Open Cloud key) ===
  {
    name: 'marketplace_search',
    category: 'read',
    description: 'Search Roblox\'s public marketplace/toolbox for insertable assets (models, decals, audio, meshes) — no Open Cloud key required. Returns asset ids + names to use with insert_asset.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Search text, e.g. "low poly tree".' },
        category: { type: 'string', description: 'Friendly name (Model, Decal, Audio, Mesh, Plugin, Video) or a raw toolbox category id. Default Model.' },
        limit: { type: 'number', description: 'Max results 1-50 (default 10).' },
        sortType: { type: 'string', description: 'Sort, e.g. "Relevance" (default).' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'marketplace_search_and_insert',
    category: 'write',
    description: 'Search the public marketplace and insert the top match into the place in one step (key-free, via InsertService). Returns the inserted asset and alternative matches.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Search text for the asset to insert.' },
        category: { type: 'string', description: 'Friendly name or toolbox category id. Default Model.' },
        parentPath: { type: 'string', description: 'Where to insert (default "game.Workspace").' },
        position: {
          type: 'object',
          description: 'Optional world position { x, y, z }.',
          properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
        },
        instance_id: INSTANCE_ID_PROP,
      },
      required: ['keyword'],
    },
  },

  // === Media (audio / animation / texture) ===
  {
    name: 'audio_create_sound',
    category: 'write',
    description: 'Create a Sound under a parent with a SoundId (number or rbxassetid://). Configure volume, looping, playback speed, and optionally play it.',
    inputSchema: {
      type: 'object',
      properties: {
        parentPath: { type: 'string', description: 'Where to create the Sound (e.g. "Workspace" or a Part path).' },
        soundId: { description: 'Audio asset id (number) or full rbxassetid:// URI.' },
        name: { type: 'string', description: 'Name for the Sound.' },
        volume: { type: 'number', description: 'Volume 0-10 (default Roblox value).' },
        looped: { type: 'boolean', description: 'Loop the sound.' },
        playbackSpeed: { type: 'number', description: 'Playback speed multiplier.' },
        playOnCreate: { type: 'boolean', description: 'Call :Play() immediately.' },
        instance_id: INSTANCE_ID_PROP,
      },
      required: ['parentPath', 'soundId'],
    },
  },
  {
    name: 'audio_play_sound',
    category: 'write',
    description: 'Play an existing Sound instance by path.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the Sound instance.' },
        instance_id: INSTANCE_ID_PROP,
      },
      required: ['path'],
    },
  },
  {
    name: 'animation_create',
    category: 'write',
    description: 'Create an Animation instance with an AnimationId (number or rbxassetid://) under a parent — e.g. inside a Humanoid, tool, or ReplicatedStorage.',
    inputSchema: {
      type: 'object',
      properties: {
        parentPath: { type: 'string', description: 'Where to create the Animation.' },
        animationId: { description: 'Animation asset id (number) or rbxassetid:// URI.' },
        name: { type: 'string', description: 'Name for the Animation (default "Animation").' },
        instance_id: INSTANCE_ID_PROP,
      },
      required: ['parentPath', 'animationId'],
    },
  },
  {
    name: 'animation_play',
    category: 'write',
    description: 'Load and play an animation on a rig (finds/creates an Animator under its Humanoid or AnimationController). Best observed during a playtest.',
    inputSchema: {
      type: 'object',
      properties: {
        rigPath: { type: 'string', description: 'Path to the rig model (with a Humanoid or AnimationController).' },
        animationId: { description: 'Animation asset id (number) or rbxassetid:// URI.' },
        looped: { type: 'boolean', description: 'Loop the track.' },
        instance_id: INSTANCE_ID_PROP,
      },
      required: ['rigPath', 'animationId'],
    },
  },
  {
    name: 'asset_apply_texture',
    category: 'write',
    description: 'Apply an image/texture asset to a target, choosing the right property by class (ImageLabel→Image, Decal/Texture→Texture, MeshPart→TextureID, SurfaceAppearance→ColorMap). Override with property.',
    inputSchema: {
      type: 'object',
      properties: {
        targetPath: { type: 'string', description: 'Path to the instance to texture.' },
        assetId: { description: 'Image asset id (number) or rbxassetid:// URI.' },
        property: { type: 'string', description: 'Force a specific property instead of inferring from class.' },
        instance_id: INSTANCE_ID_PROP,
      },
      required: ['targetPath', 'assetId'],
    },
  },

  // === AI image generation (Pollinations) ===
  {
    name: 'image_generate',
    category: 'write',
    description: 'Generate an image from a text prompt via Pollinations (default model zimage; any model from enter.pollinations.ai/#models). Saves a local file and returns its path. Requires POLLINATIONS_API_KEY. To use it in Roblox, upload it (image_generate_and_upload or upload_asset) then asset_apply_texture.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Text description of the image to generate.' },
        model: { type: 'string', description: 'Pollinations model (default "zimage").' },
        width: { type: 'number', description: 'Width px 16-2048 (default 1024).' },
        height: { type: 'number', description: 'Height px 16-2048 (default 1024).' },
        seed: { type: 'number', description: 'Seed for reproducible results (default 0).' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'image_generate_and_upload',
    category: 'write',
    description: 'Generate an image (Pollinations) and upload it to Roblox in one step, returning the new assetId to use with asset_apply_texture. Requires POLLINATIONS_API_KEY and Roblox upload auth (ROBLOX_OPEN_CLOUD_API_KEY with asset:write, or ROBLOSECURITY for Decals).',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Text description of the image to generate.' },
        model: { type: 'string', description: 'Pollinations model (default "zimage").' },
        width: { type: 'number', description: 'Width px 16-2048 (default 1024).' },
        height: { type: 'number', description: 'Height px 16-2048 (default 1024).' },
        seed: { type: 'number', description: 'Seed (default 0).' },
        assetType: { type: 'string', description: 'Roblox asset type to upload as (default "Decal").' },
        displayName: { type: 'string', description: 'Asset display name (default from prompt).' },
      },
      required: ['prompt'],
    },
  },

  // === Diagnostics ===
  {
    name: 'diagnose_scripts',
    category: 'read',
    description: 'Capture the Studio output log and return a structured report of errors and warnings, with each error mapped to its script path and line where possible. Use to drive "fix all script errors".',
    inputSchema: {
      type: 'object',
      properties: {
        maxEntries: { type: 'number', description: 'How many recent log entries to scan (default 200).' },
        instance_id: INSTANCE_ID_PROP,
      },
    },
  },
];
