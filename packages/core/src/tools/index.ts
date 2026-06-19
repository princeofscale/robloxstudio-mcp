import { StudioHttpClient } from './studio-client.js';
import { BridgeService, RoutingFailure } from '../bridge-service.js';
import { SafetyManager, OperationKind } from '../safety/safety-manager.js';
import {
  buildScreenGuiLuau,
  buildGuiObjectLuau,
  buildApplyLayoutLuau,
  buildMobileFriendlyLuau,
  GuiObjectClass,
  ScreenGuiOptions,
  GuiObjectOptions,
  LayoutOptions,
} from '../builders/ui-builders.js';
import {
  buildSetTimeOfDayLuau,
  buildLightingPresetLuau,
  buildAtmosphereLuau,
  buildSkyLuau,
  buildDayNightCycleScriptLuau,
  AtmospherePreset,
  SkyOptions,
  DayNightCycleOptions,
} from '../builders/environment-builders.js';
import {
  buildBaseplateLuau,
  buildIslandLuau,
  buildMountainsLuau,
  buildWaterLuau,
  buildPaintMaterialLuau,
  buildClearRegionLuau,
  boxVolume,
  regionVolume,
  BaseplateOptions,
  IslandOptions,
  MountainsOptions,
  WaterOptions,
  PaintMaterialOptions,
  ClearRegionOptions,
} from '../builders/terrain-builders.js';
import {
  buildObbyTemplateLuau,
  buildSimulatorTemplateLuau,
  buildTycoonTemplateLuau,
  buildRoundTemplateLuau,
  ObbyTemplateOptions,
  SimulatorTemplateOptions,
  TycoonTemplateOptions,
  RoundTemplateOptions,
} from '../builders/template-builders.js';
import { SyncManager, ScriptClassName } from '../sync/sync-manager.js';
import { buildDumpScriptsLuau } from '../sync/sync-luau.js';
import { MarketplaceClient } from '../marketplace-client.js';
import { interpretInsertResponse } from '../assets.js';
import { typedError, responseErrorCode } from '../errors.js';
import { compactText } from '../compact.js';
import {
  buildCreateSoundLuau,
  buildPlaySoundLuau,
  buildCreateAnimationLuau,
  buildPlayAnimationLuau,
  buildApplyTextureLuau,
  CreateSoundOptions,
  CreateAnimationOptions,
  PlayAnimationOptions,
  ApplyTextureOptions,
} from '../builders/media-builders.js';
import { parseLogErrors, formatDiagnostics } from '../diagnostics.js';
import { PollinationsClient, DEFAULT_IMAGE_MODEL, ImageGenOptions } from '../image-client.js';
import { runBuildExecutor } from './build-executor.js';
import { OpenCloudClient } from '../opencloud-client.js';
import { RobloxCookieClient } from '../roblox-cookie-client.js';
import { rgbaToJpeg } from '../jpeg-encoder.js';
import { rgbaToPng } from '../png-encoder.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type RawImageCaptureResponse = {
  success?: boolean;
  error?: string;
  width?: number;
  height?: number;
  data?: string;
  instancePath?: string;
  instanceName?: string;
  cameraPreset?: string;
};

type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

type EncodedViewportCapture = {
  success: true;
  width: number;
  height: number;
  format: 'jpeg' | 'png';
  quality?: number;
  note: string;
  data: string;
  mimeType: string;
  message: string;
} | {
  success: false;
  error: string;
};

type DeviceSimulatorSettings = {
  deviceId?: string;
  orientation?: string;
  resolution?: { width: number; height: number };
  pixelDensity?: number;
  scalingMode?: string;
};

type DeviceSimulatorMatrixEntry = DeviceSimulatorSettings & {
  label?: string;
};

type SimulationInclude = 'network' | 'deviceSimulator' | 'both';

// Per-call safety controls threaded into destructive/bulk tools. Both are
// optional and additive: omitting them preserves the original behavior for any
// non-gated operation, while gated ones (protected deletes, large bulk changes,
// dangerous Luau) stay blocked until `confirm: true` is supplied.
type SafetyOptions = {
  /** Preview the operation without mutating anything. */
  dryRun?: boolean;
  /** Explicitly approve an operation the safety layer would otherwise gate. */
  confirm?: boolean;
};

const MAX_INLINE_IMAGE_BYTES = 6_000_000;
const MAX_DEVICE_MATRIX_ENTRIES = 6;
const MAX_NETWORK_PACKET_LOSS_PERCENT = 0.5;

// Encodes the raw RGBA capture into the requested image format.
// - 'png': lossless — sharpest text/UI, but a busy 3D scene can be large.
// - 'jpeg': default; quality 92 with 4:4:4 chroma (no subsampling) keeps text
//   crisp at ~1/3 the size. The image rides back inline as an MCP tool result,
//   so JPEG is the safe default for staying under client result-size caps.
function encodeImageFromRgbaResponse(
  response: RawImageCaptureResponse,
  format: 'jpeg' | 'png',
  quality: number,
): { buffer: Buffer; mimeType: string } {
  if (!response.data || response.width === undefined || response.height === undefined) {
    throw new Error('Render response missing data, width, or height');
  }
  const rgbaBuffer = Buffer.from(response.data, 'base64');
  if (format === 'png') {
    return { buffer: rgbaToPng(rgbaBuffer, response.width, response.height), mimeType: 'image/png' };
  }
  return {
    buffer: rgbaToJpeg(rgbaBuffer, response.width, response.height, quality),
    mimeType: 'image/jpeg',
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const NETWORK_PROFILE_KEYS = [
  'InboundNetworkMinDelayMs',
  'OutboundNetworkMinDelayMs',
  'InboundNetworkJitterMs',
  'OutboundNetworkJitterMs',
  'InboundNetworkLossPercent',
  'OutboundNetworkLossPercent',
] as const;

type NetworkProfileKey = typeof NETWORK_PROFILE_KEYS[number];
type NetworkProfileValues = Partial<Record<NetworkProfileKey, number>>;

const NETWORK_PROFILES: Record<'great' | 'good' | 'poor', Record<NetworkProfileKey, number>> = {
  great: {
    InboundNetworkMinDelayMs: 15,
    OutboundNetworkMinDelayMs: 15,
    InboundNetworkJitterMs: 0,
    OutboundNetworkJitterMs: 0,
    InboundNetworkLossPercent: 0,
    OutboundNetworkLossPercent: 0,
  },
  good: {
    InboundNetworkMinDelayMs: 50,
    OutboundNetworkMinDelayMs: 50,
    InboundNetworkJitterMs: 10,
    OutboundNetworkJitterMs: 10,
    InboundNetworkLossPercent: 0,
    OutboundNetworkLossPercent: 0,
  },
  poor: {
    InboundNetworkMinDelayMs: 150,
    OutboundNetworkMinDelayMs: 150,
    InboundNetworkJitterMs: 100,
    OutboundNetworkJitterMs: 100,
    InboundNetworkLossPercent: 0.5,
    OutboundNetworkLossPercent: 0.5,
  },
};

const ZERO_NETWORK_PROFILE: Record<NetworkProfileKey, number> = {
  InboundNetworkMinDelayMs: 0,
  OutboundNetworkMinDelayMs: 0,
  InboundNetworkJitterMs: 0,
  OutboundNetworkJitterMs: 0,
  InboundNetworkLossPercent: 0,
  OutboundNetworkLossPercent: 0,
};

const SIMULATION_PERSISTENCE_NOTES = [
  'Normal Play client changes can write back to edit state.',
  'Multiplayer clients inherit baseline at startup but are isolated afterward.',
  'StudioTestService client device simulator state may appear stale on fresh clients, so reset after client startup is required.',
];

function normalizeNetworkProfile(profile: string, overrides?: Record<string, unknown>): NetworkProfileValues {
  if (!['great', 'good', 'poor', 'custom'].includes(profile)) {
    throw new Error('profile must be "great", "good", "poor", or "custom"');
  }

  const values: NetworkProfileValues = profile === 'custom'
    ? {}
    : { ...NETWORK_PROFILES[profile as 'great' | 'good' | 'poor'] };

  if (overrides !== undefined) {
    if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) {
      throw new Error('overrides must be an object when provided');
    }
    const allowed = new Set<string>(NETWORK_PROFILE_KEYS);
    for (const [key, value] of Object.entries(overrides)) {
      if (!allowed.has(key)) {
        throw new Error(`Unsupported network override "${key}". Allowed: ${NETWORK_PROFILE_KEYS.join(', ')}`);
      }
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`Network override "${key}" must be a finite number`);
      }
      if (value < 0) {
        throw new Error(`Network override "${key}" must be greater than or equal to 0`);
      }
      if ((key === 'InboundNetworkLossPercent' || key === 'OutboundNetworkLossPercent') && value > MAX_NETWORK_PACKET_LOSS_PERCENT) {
        throw new Error(`Network override "${key}" cannot exceed ${MAX_NETWORK_PACKET_LOSS_PERCENT}; Roblox engine limits packet loss simulation to 0.5%.`);
      }
      values[key as NetworkProfileKey] = value;
    }
  }

  if (Object.keys(values).length === 0) {
    throw new Error('custom profile requires at least one override');
  }

  return values;
}

function buildNetworkProfileLuau(profile: string, values: NetworkProfileValues): string {
  const valuesJson = JSON.stringify(values);
  const keysJson = JSON.stringify(NETWORK_PROFILE_KEYS);
  return `
local HttpService = game:GetService("HttpService")
local ns = settings():GetService("NetworkSettings")
local keys = HttpService:JSONDecode(${JSON.stringify(keysJson)})
local desired = HttpService:JSONDecode(${JSON.stringify(valuesJson)})
local before = {}
for _, key in ipairs(keys) do
\tbefore[key] = ns[key]
end
for key, value in pairs(desired) do
\tns[key] = value
end
local after = {}
for _, key in ipairs(keys) do
\tafter[key] = ns[key]
end
return HttpService:JSONEncode({
\tprofile = ${JSON.stringify(profile)},
\tapplied = desired,
\tbefore = before,
\tafter = after,
})
`.trim();
}

function buildNetworkStateLuau(operation: 'get' | 'reset'): string {
  const keysJson = JSON.stringify(NETWORK_PROFILE_KEYS);
  const resetJson = JSON.stringify(ZERO_NETWORK_PROFILE);
  return `
local HttpService = game:GetService("HttpService")
local ns = settings():GetService("NetworkSettings")
local operation = ${JSON.stringify(operation)}
local keys = HttpService:JSONDecode(${JSON.stringify(keysJson)})
local resetValues = HttpService:JSONDecode(${JSON.stringify(resetJson)})

local function readState()
\tlocal state = {}
\tfor _, key in ipairs(keys) do
\t\tstate[key] = ns[key]
\tend
\treturn state
end

if operation == "get" then
\treturn HttpService:JSONEncode({
\t\tsuccess = true,
\t\tstate = readState(),
\t})
end

if operation == "reset" then
\tlocal before = readState()
\tfor key, value in pairs(resetValues) do
\t\tns[key] = value
\tend
\treturn HttpService:JSONEncode({
\t\tsuccess = true,
\t\tapplied = resetValues,
\t\tbefore = before,
\t\tafter = readState(),
\t})
end

error("Unsupported network simulation operation: " .. tostring(operation), 0)
`.trim();
}

function normalizeDeviceSimulatorResolution(value: unknown): { width: number; height: number } | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('resolution must be an object with positive integer width and height');
  }
  const resolution = value as { width?: unknown; height?: unknown };
  const width = resolution.width;
  const height = resolution.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || (width as number) <= 0 || (height as number) <= 0) {
    throw new Error('resolution.width and resolution.height must be positive integers');
  }
  return { width: width as number, height: height as number };
}

function normalizeDeviceSimulatorSettings(input: {
  deviceId?: unknown;
  orientation?: unknown;
  resolution?: unknown;
  pixelDensity?: unknown;
  scalingMode?: unknown;
}): DeviceSimulatorSettings {
  const settings: DeviceSimulatorSettings = {};

  if (input.deviceId !== undefined) {
    if (typeof input.deviceId !== 'string' || input.deviceId.trim() === '') {
      throw new Error('deviceId must be a non-empty string');
    }
    settings.deviceId = input.deviceId;
  }

  if (input.orientation !== undefined) {
    if (typeof input.orientation !== 'string' || input.orientation.trim() === '') {
      throw new Error('orientation must be a non-empty string');
    }
    settings.orientation = input.orientation;
  }

  const resolution = normalizeDeviceSimulatorResolution(input.resolution);
  if (resolution !== undefined) settings.resolution = resolution;

  if (input.pixelDensity !== undefined) {
    if (typeof input.pixelDensity !== 'number' || !Number.isFinite(input.pixelDensity) || input.pixelDensity <= 0) {
      throw new Error('pixelDensity must be a positive finite number');
    }
    settings.pixelDensity = input.pixelDensity;
  }

  if (input.scalingMode !== undefined) {
    if (typeof input.scalingMode !== 'string' || input.scalingMode.trim() === '') {
      throw new Error('scalingMode must be a non-empty string');
    }
    settings.scalingMode = input.scalingMode;
  }

  return settings;
}

function hasDeviceSimulatorSettings(settings: DeviceSimulatorSettings): boolean {
  return settings.deviceId !== undefined ||
    settings.orientation !== undefined ||
    settings.resolution !== undefined ||
    settings.pixelDensity !== undefined ||
    settings.scalingMode !== undefined;
}

function buildDeviceSimulatorLuau(operation: 'get' | 'set', options: Record<string, unknown>): string {
  const payload = JSON.stringify({ operation, ...options });
  return `
local HttpService = game:GetService("HttpService")
local simulator = game:GetService("StudioDeviceSimulatorService")
local opts = HttpService:JSONDecode(${JSON.stringify(payload)})

local function plain(value)
\tlocal valueType = typeof(value)
\tif valueType == "Vector2" then
\t\treturn { x = value.X, y = value.Y, width = value.X, height = value.Y }
\tend
\tif valueType == "EnumItem" then
\t\treturn value.Name
\tend
\tif type(value) == "table" then
\t\tlocal out = {}
\t\tfor k, v in pairs(value) do
\t\t\tout[tostring(k)] = plain(v)
\t\tend
\t\treturn out
\tend
\treturn value
end

local function getDeviceInfo(deviceId)
\tlocal ok, info = pcall(function()
\t\treturn simulator:GetDeviceInfoAsync(deviceId)
\tend)
\tif ok then
\t\treturn plain(info), nil
\tend
\treturn nil, tostring(info)
end

local function normalizeDeviceList(rawList)
\tlocal devices = {}
\tlocal ids = {}
\tfor _, entry in ipairs(rawList) do
\t\tlocal item
\t\tlocal id
\t\tif type(entry) == "table" then
\t\t\titem = plain(entry)
\t\t\tid = item.DeviceId or item.deviceId or item.Id or item.id or item[1]
\t\telse
\t\t\tid = tostring(entry)
\t\t\titem = { DeviceId = id }
\t\tend
\t\tif id ~= nil then
\t\t\tid = tostring(id)
\t\t\tlocal info = getDeviceInfo(id)
\t\t\tif type(info) == "table" then
\t\t\t\titem = info
\t\t\t\tif item.DeviceId == nil then item.DeviceId = id end
\t\t\tend
\t\t\tif item.IsCustom ~= true then
\t\t\t\tids[id] = true
\t\t\t\ttable.insert(devices, item)
\t\t\tend
\t\tend
\tend
\treturn devices, ids
end

local function getDeviceList()
\tlocal rawList = simulator:GetDeviceListAsync()
\treturn normalizeDeviceList(rawList)
end

local function assertBuiltInDeviceExists(deviceId)
\tlocal _, ids = getDeviceList()
\tif ids[deviceId] then return end
\tlocal available = {}
\tfor id in pairs(ids) do table.insert(available, id) end
\ttable.sort(available)
\terror('deviceId "' .. tostring(deviceId) .. '" is not an available built-in device. Use get_device_simulator_state to list supported device IDs. Available: ' .. table.concat(available, ", "), 0)
end

local function enumByName(enumType, raw, label)
\tlocal name = tostring(raw)
\tname = string.match(name, "([^%.]+)$") or name
\tlocal available = {}
\tfor _, item in ipairs(enumType:GetEnumItems()) do
\t\ttable.insert(available, item.Name)
\t\tif item.Name == name then
\t\t\treturn item, item.Name
\t\tend
\tend
\terror(label .. ' "' .. tostring(raw) .. '" is not valid. Available: ' .. table.concat(available, ", "), 0)
end

local function tryActiveGetter(state, key, fn)
\tlocal ok, value = pcall(fn)
\tif ok then
\t\tstate[key] = plain(value)
\telse
\t\tstate.unavailable = state.unavailable or {}
\t\tstate.unavailable[key] = tostring(value)
\tend
end

local function readState(includeDeviceList, requestedDeviceId)
\tlocal activeDeviceId = tostring(simulator:GetDeviceAsync())
\tlocal state = {
\t\tactiveDeviceId = activeDeviceId,
\t\tisSimulating = activeDeviceId ~= "default",
\t}

\tif includeDeviceList then
\t\tlocal devices = getDeviceList()
\t\tstate.devices = devices
\tend

\tif requestedDeviceId ~= nil then
\t\tassertBuiltInDeviceExists(requestedDeviceId)
\t\tstate.deviceInfo = plain(simulator:GetDeviceInfoAsync(requestedDeviceId))
\tend

\tif state.isSimulating then
\t\ttryActiveGetter(state, "resolution", function() return simulator:GetResolutionAsync() end)
\t\ttryActiveGetter(state, "pixelDensity", function() return simulator:GetPixelDensityAsync() end)
\t\ttryActiveGetter(state, "orientation", function() return simulator:GetOrientationAsync() end)
\t\ttryActiveGetter(state, "scalingMode", function() return simulator:GetScalingModeAsync() end)
\tend

\treturn state
end

local function applySettings(settings)
\tlocal applied = {}
\tif settings.deviceId ~= nil then
\t\tassertBuiltInDeviceExists(settings.deviceId)
\t\tsimulator:SetDeviceAsync(settings.deviceId)
\t\tapplied.deviceId = settings.deviceId
\tend
\tif settings.orientation ~= nil then
\t\tlocal item, name = enumByName(Enum.ScreenOrientation, settings.orientation, "orientation")
\t\tsimulator:SetOrientationAsync(item)
\t\tapplied.orientation = name
\tend
\tif settings.resolution ~= nil then
\t\tsimulator:SetResolutionAsync(settings.resolution.width, settings.resolution.height)
\t\tapplied.resolution = { width = settings.resolution.width, height = settings.resolution.height }
\tend
\tif settings.pixelDensity ~= nil then
\t\tsimulator:SetPixelDensityAsync(settings.pixelDensity)
\t\tapplied.pixelDensity = settings.pixelDensity
\tend
\tif settings.scalingMode ~= nil then
\t\tlocal item, name = enumByName(Enum.DeviceSimulatorScalingMode, settings.scalingMode, "scalingMode")
\t\tsimulator:SetScalingModeAsync(item)
\t\tapplied.scalingMode = name
\tend
\treturn applied
end

if opts.operation == "get" then
\treturn readState(opts.includeDeviceList ~= false, opts.deviceId)
end

if opts.operation == "set" then
\tlocal before = readState(false, nil)
\tlocal applied
\tif opts.stopSimulation == true then
\t\tsimulator:StopSimulationAsync()
\t\tapplied = { stopSimulation = true }
\telse
\t\tapplied = applySettings(opts.settings or {})
\tend
\treturn {
\t\tsuccess = true,
\t\tapplied = applied,
\t\tbefore = before,
\t\tafter = readState(false, nil),
\t}
end

error("Unsupported device simulator operation: " .. tostring(opts.operation), 0)
`.trim();
}

export class RobloxStudioTools {
  private client: StudioHttpClient;
  private bridge: BridgeService;
  private openCloudClient: OpenCloudClient;
  private cookieClient: RobloxCookieClient;
  private safety: SafetyManager;
  private sync: SyncManager;
  private marketplace: MarketplaceClient;
  private imageClient: PollinationsClient;

  constructor(bridge: BridgeService) {
    this.client = new StudioHttpClient(bridge);
    this.bridge = bridge;
    this.openCloudClient = new OpenCloudClient();
    this.cookieClient = new RobloxCookieClient();
    this.safety = new SafetyManager();
    this.sync = new SyncManager();
    this.marketplace = new MarketplaceClient();
    this.imageClient = new PollinationsClient();
  }

  // === Safety layer ===
  // A single guard every destructive/bulk tool consults before touching the
  // bridge. It returns a ready-to-send MCP result when an operation must be
  // gated (confirmation), blocked (hard limit), or previewed (dry-run); it
  // returns null when the operation is cleared to proceed. Keeping the policy
  // here means each tool opts in with one line and shares identical behavior.

  private _safetyGate(
    kind: OperationKind,
    detail: string,
    input: { path?: string; count?: number; scriptSize?: number; code?: string },
    options?: SafetyOptions,
  ): { content: ToolContent[] } | null {
    const assessment = this.safety.assess({
      kind,
      ...input,
      dryRun: options?.dryRun,
      confirmed: options?.confirm,
    });
    if (assessment.dryRun || !assessment.allowed) {
      return this._formatSafety(kind, detail, assessment);
    }
    return null;
  }

  private _formatSafety(
    kind: OperationKind,
    detail: string,
    assessment: ReturnType<SafetyManager['assess']>,
  ): { content: ToolContent[] } {
    const lines: string[] = [];
    if (assessment.dryRun) {
      lines.push(`Dry-run preview for ${kind}: ${detail}. No changes were made.`);
    } else if (assessment.blocked) {
      lines.push(`Operation blocked: ${kind} — ${detail}.`);
    } else {
      lines.push(`Confirmation required for ${kind}: ${detail}.`);
    }
    if (assessment.reasons.length) lines.push('Reasons:\n- ' + assessment.reasons.join('\n- '));
    if (assessment.warnings.length) lines.push('Warnings:\n- ' + assessment.warnings.join('\n- '));
    if (!assessment.dryRun && assessment.requiresConfirmation && !assessment.blocked) {
      lines.push('To proceed, re-run this tool with confirm: true.');
    }
    return { content: [{ type: 'text', text: lines.join('\n\n') }] };
  }

  async getOperationHistory(limit?: number) {
    const entries = this.safety.getHistory().slice(0, limit ?? 50);
    const header = `Operation history (${entries.length} entries):`;
    const body = entries.length === 0
      ? 'No operations recorded yet.'
      : entries
          .map((e) => `- [${new Date(e.timestamp).toISOString()}] ${e.kind}: ${e.summary}`)
          .join('\n');
    return { content: [{ type: 'text', text: `${header}\n${body}` }] as ToolContent[] };
  }

  async listScriptBackups() {
    const backups = this.safety.listBackups();
    const header = `Script backups (${backups.length}):`;
    const body = backups.length === 0
      ? 'No script backups captured yet.'
      : backups
          .map((b) => `- ${b.path} (backed up ${new Date(b.timestamp).toISOString()}, ${b.source.length} chars${b.previous !== undefined ? ', 1 prior version available' : ''})`)
          .join('\n');
    return { content: [{ type: 'text', text: `${header}\n${body}` }] as ToolContent[] };
  }

  async restoreScriptBackup(instancePath: string, instance_id?: string) {
    const backup = this.safety.getBackup(instancePath);
    if (!backup) {
      return { content: [{ type: 'text', text: `No backup found for "${instancePath}". Use list_script_backups to see what is available.` }] as ToolContent[] };
    }
    const response = await this._callSingle('/api/set-script-source', { instancePath, source: backup.source }, undefined, instance_id);
    this.safety.recordOperation({ kind: 'restore_script', summary: `restored ${instancePath} (${backup.source.length} chars)` });
    return { content: [{ type: 'text', text: JSON.stringify({ restored: instancePath, bytes: backup.source.length, response }) }] as ToolContent[] };
  }

  // === Generated-Luau builders (UI / environment / terrain) ===
  // These tools compose typed parameters into Luau that runs in the plugin's
  // edit context. Centralizing execution here means the safety layer, history,
  // and instance routing all apply uniformly without touching the plugin.

  private async _runGeneratedLuau(code: string, instance_id?: string) {
    const response = await this._callSingle('/api/execute-luau', { code }, 'edit', instance_id);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] as ToolContent[] };
  }

  // --- UI builder tools ---

  async uiCreateScreenGui(options: ScreenGuiOptions, instance_id?: string) {
    if (!options?.name) throw new Error('name is required for ui_create_screen_gui');
    const result = await this._runGeneratedLuau(buildScreenGuiLuau(options), instance_id);
    this.safety.recordOperation({ kind: 'ui_create', summary: `ScreenGui ${options.name}` });
    return result;
  }

  private async _uiCreate(className: GuiObjectClass, options: GuiObjectOptions, instance_id?: string) {
    if (!options?.parentPath) throw new Error(`parentPath is required for ui_create_${className.toLowerCase()}`);
    const result = await this._runGeneratedLuau(buildGuiObjectLuau(className, options), instance_id);
    this.safety.recordOperation({ kind: 'ui_create', summary: `${className} under ${options.parentPath}` });
    return result;
  }

  async uiCreateFrame(options: GuiObjectOptions, instance_id?: string) { return this._uiCreate('Frame', options, instance_id); }
  async uiCreateTextLabel(options: GuiObjectOptions, instance_id?: string) { return this._uiCreate('TextLabel', options, instance_id); }
  async uiCreateTextButton(options: GuiObjectOptions, instance_id?: string) { return this._uiCreate('TextButton', options, instance_id); }
  async uiCreateImageLabel(options: GuiObjectOptions, instance_id?: string) { return this._uiCreate('ImageLabel', options, instance_id); }
  async uiCreateImageButton(options: GuiObjectOptions, instance_id?: string) { return this._uiCreate('ImageButton', options, instance_id); }

  async uiApplyLayout(options: LayoutOptions & { targetPath: string }, instance_id?: string) {
    if (!options?.targetPath) throw new Error('targetPath is required for ui_apply_layout');
    return this._runGeneratedLuau(buildApplyLayoutLuau(options.targetPath, options), instance_id);
  }

  async uiMakeMobileFriendly(targetPath: string, instance_id?: string) {
    if (!targetPath) throw new Error('targetPath is required for ui_make_mobile_friendly');
    return this._runGeneratedLuau(buildMobileFriendlyLuau(targetPath), instance_id);
  }

  // --- Environment tools ---

  async environmentSetTimeOfDay(time: number | string, instance_id?: string) {
    if (time === undefined || time === null) throw new Error('time is required for environment_set_time_of_day');
    return this._runGeneratedLuau(buildSetTimeOfDayLuau(time), instance_id);
  }

  async environmentSetLightingPreset(preset: string, withPostFx?: boolean, instance_id?: string) {
    // buildLightingPresetLuau throws on an unknown preset; surface that as a
    // clean tool result instead of a transport error.
    let code: string;
    try {
      code = buildLightingPresetLuau(preset, withPostFx ?? false);
    } catch (error) {
      return { content: [{ type: 'text', text: errorMessage(error) }] as ToolContent[] };
    }
    const result = await this._runGeneratedLuau(code, instance_id);
    this.safety.recordOperation({ kind: 'environment', summary: `lighting preset ${preset}${withPostFx ? ' +postFx' : ''}` });
    return result;
  }

  async environmentSetAtmosphere(options: AtmospherePreset, instance_id?: string) {
    return this._runGeneratedLuau(buildAtmosphereLuau(options ?? {}), instance_id);
  }

  async environmentSetSky(options: SkyOptions, instance_id?: string) {
    return this._runGeneratedLuau(buildSkyLuau(options ?? {}), instance_id);
  }

  async environmentCreateDayNightCycleScript(options: DayNightCycleOptions, instance_id?: string) {
    const result = await this._runGeneratedLuau(buildDayNightCycleScriptLuau(options ?? {}), instance_id);
    this.safety.recordOperation({ kind: 'environment', summary: `day-night cycle script (${options?.minutesPerDay ?? 10} min/day)` });
    return result;
  }

  // --- Terrain tools ---

  private _terrainGate(volume: number, detail: string, options?: SafetyOptions): { content: ToolContent[] } | null {
    return this._safetyGate('terrain_fill', `${detail} (~${Math.round(volume)} studs³)`, { count: volume }, options);
  }

  async terrainGenerateBaseplate(options: BaseplateOptions & SafetyOptions, instance_id?: string) {
    if (!options?.size) throw new Error('size is required for terrain_generate_baseplate');
    const gated = this._terrainGate(boxVolume(options.size), 'baseplate', options);
    if (gated) return gated;
    const result = await this._runGeneratedLuau(buildBaseplateLuau(options), instance_id);
    this.safety.recordOperation({ kind: 'terrain', summary: `baseplate ${options.size.join('x')}` });
    return result;
  }

  async terrainGenerateIsland(options: IslandOptions & SafetyOptions, instance_id?: string) {
    if (!options?.radius) throw new Error('radius is required for terrain_generate_island');
    const volume = (4 / 3) * Math.PI * Math.pow(options.radius, 3);
    const gated = this._terrainGate(volume, 'island', options);
    if (gated) return gated;
    const result = await this._runGeneratedLuau(buildIslandLuau(options), instance_id);
    this.safety.recordOperation({ kind: 'terrain', summary: `island r=${options.radius}` });
    return result;
  }

  async terrainGenerateMountains(options: MountainsOptions & SafetyOptions, instance_id?: string) {
    if (!options?.extent || options.maxHeight === undefined) throw new Error('extent and maxHeight are required for terrain_generate_mountains');
    const volume = Math.abs(options.extent[0]) * Math.abs(options.extent[1]) * Math.abs(options.maxHeight);
    const gated = this._terrainGate(volume, 'mountains', options);
    if (gated) return gated;
    const result = await this._runGeneratedLuau(buildMountainsLuau(options), instance_id);
    this.safety.recordOperation({ kind: 'terrain', summary: `mountains ${options.extent.join('x')}` });
    return result;
  }

  async terrainGenerateWater(options: WaterOptions & SafetyOptions, instance_id?: string) {
    if (!options?.size) throw new Error('size is required for terrain_generate_water');
    const gated = this._terrainGate(boxVolume(options.size), 'water', options);
    if (gated) return gated;
    const result = await this._runGeneratedLuau(buildWaterLuau(options), instance_id);
    this.safety.recordOperation({ kind: 'terrain', summary: `water ${options.size.join('x')}` });
    return result;
  }

  async terrainPaintMaterial(options: PaintMaterialOptions & SafetyOptions, instance_id?: string) {
    if (!options?.min || !options?.max || !options?.material) throw new Error('min, max, and material are required for terrain_paint_material');
    const gated = this._terrainGate(regionVolume(options.min, options.max), `paint ${options.material}`, options);
    if (gated) return gated;
    const result = await this._runGeneratedLuau(buildPaintMaterialLuau(options), instance_id);
    this.safety.recordOperation({ kind: 'terrain', summary: `paint ${options.material}` });
    return result;
  }

  async terrainClearRegion(options: ClearRegionOptions & SafetyOptions, instance_id?: string) {
    if (!options?.min || !options?.max) throw new Error('min and max are required for terrain_clear_region');
    const gated = this._safetyGate('terrain_clear', `clear region (~${Math.round(regionVolume(options.min, options.max))} studs³)`, { count: regionVolume(options.min, options.max) }, options);
    if (gated) return gated;
    const result = await this._runGeneratedLuau(buildClearRegionLuau(options), instance_id);
    this.safety.recordOperation({ kind: 'terrain', summary: `cleared region` });
    return result;
  }

  // --- Game-template tools ---
  // Each scaffolds a complete starter game (geometry, services, leaderstats,
  // gameplay scripts). Generation is idempotent, so re-running refreshes the
  // template in place rather than duplicating it.

  async templateCreateObbyGame(options: ObbyTemplateOptions, instance_id?: string) {
    const result = await this._runGeneratedLuau(buildObbyTemplateLuau(options ?? {}), instance_id);
    this.safety.recordOperation({ kind: 'template', summary: `obby game (${options?.checkpoints ?? 5} checkpoints)` });
    return result;
  }

  async templateCreateSimulatorGame(options: SimulatorTemplateOptions, instance_id?: string) {
    const result = await this._runGeneratedLuau(buildSimulatorTemplateLuau(options ?? {}), instance_id);
    this.safety.recordOperation({ kind: 'template', summary: `simulator game (${options?.currencyName ?? 'Coins'})` });
    return result;
  }

  async templateCreateTycoonGame(options: TycoonTemplateOptions, instance_id?: string) {
    const result = await this._runGeneratedLuau(buildTycoonTemplateLuau(options ?? {}), instance_id);
    this.safety.recordOperation({ kind: 'template', summary: `tycoon game` });
    return result;
  }

  async templateCreateRoundGame(options: RoundTemplateOptions, instance_id?: string) {
    const result = await this._runGeneratedLuau(buildRoundTemplateLuau(options ?? {}), instance_id);
    this.safety.recordOperation({ kind: 'template', summary: `round game (${options?.roundSeconds ?? 90}s)` });
    return result;
  }

  // === Local sync (Studio <-> files) ===
  // Scripts mirror to suffixed Lua files (.server/.client/.module.lua) under a
  // sync directory. A manifest (.robloxsync.json) records the source captured at
  // the last sync so push/status can do three-way conflict detection rather than
  // clobbering. SyncManager owns the (tested) path/conflict logic; this layer
  // owns filesystem and Studio I/O.

  private _syncManifestPath(dir: string): string {
    return path.join(dir, '.robloxsync.json');
  }

  private _readManifest(dir: string): Record<string, string> {
    try {
      const raw = fs.readFileSync(this._syncManifestPath(dir), 'utf8');
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed.paths === 'object' ? parsed.paths : {};
    } catch {
      return {};
    }
  }

  private _writeManifest(dir: string, paths: Record<string, string>): void {
    const payload = { version: 1, updatedAt: new Date().toISOString(), paths };
    fs.writeFileSync(this._syncManifestPath(dir), JSON.stringify(payload, null, 2));
  }

  private async _dumpStudioScripts(instance_id?: string): Promise<Array<{ path: string; className: ScriptClassName; source: string }>> {
    const response = await this._callSingle('/api/execute-luau', { code: buildDumpScriptsLuau() }, 'edit', instance_id);
    const raw = typeof response?.returnValue === 'string' ? response.returnValue : undefined;
    if (!raw) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Could not parse script dump from Studio: ${raw.slice(0, 200)}`);
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is { path: string; className: ScriptClassName; source: string } =>
      !!e && typeof e.path === 'string' && typeof e.className === 'string' && typeof e.source === 'string'
      && (e.className === 'Script' || e.className === 'LocalScript' || e.className === 'ModuleScript'));
  }

  private _walkLocalScripts(dir: string): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (current: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        const rel = path.relative(dir, full).split(path.sep).join('/');
        if (entry.isDirectory()) {
          walk(full);
        } else if (this.sync.classNameForFile(entry.name) && !this.sync.isIgnored(rel)) {
          out.set(rel, fs.readFileSync(full, 'utf8'));
        }
      }
    };
    walk(dir);
    return out;
  }

  private _resolveSyncDir(syncDir?: string): string {
    return path.resolve(syncDir ?? process.env.ROBLOX_SYNC_DIR ?? path.join(process.cwd(), 'roblox-src'));
  }

  async syncPull(syncDir?: string, instance_id?: string) {
    const dir = this._resolveSyncDir(syncDir);
    const scripts = await this._dumpStudioScripts(instance_id);
    fs.mkdirSync(dir, { recursive: true });
    const manifest: Record<string, string> = {};
    let written = 0;
    let skipped = 0;
    for (const script of scripts) {
      const rel = this.sync.instancePathToFilePath(script.path, script.className);
      if (this.sync.isIgnored(rel)) { skipped++; continue; }
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, script.source);
      manifest[rel] = script.source;
      written++;
    }
    this._writeManifest(dir, manifest);
    this.safety.recordOperation({ kind: 'sync_pull', summary: `pulled ${written} scripts to ${dir}` });
    return { content: [{ type: 'text', text: JSON.stringify({ pulled: written, skipped, dir }) }] as ToolContent[] };
  }

  async syncStatus(syncDir?: string, instance_id?: string) {
    const dir = this._resolveSyncDir(syncDir);
    const studio = new Map(
      (await this._dumpStudioScripts(instance_id)).map((s) => [this.sync.instancePathToFilePath(s.path, s.className), s.source] as const),
    );
    const local = this._walkLocalScripts(dir);
    const base = this._readManifest(dir);
    const rels = new Set<string>([...studio.keys(), ...local.keys(), ...Object.keys(base)]);
    const groups: Record<string, string[]> = { local: [], studio: [], both: [], none: [] };
    for (const rel of rels) {
      if (this.sync.isIgnored(rel)) continue;
      const kind = this.sync.detectConflict({ local: local.get(rel), base: base[rel], studio: studio.get(rel) });
      groups[kind].push(rel);
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          dir,
          localOnlyChanges: groups.local,
          studioOnlyChanges: groups.studio,
          conflicts: groups.both,
          inSync: groups.none.length,
        }, null, 2),
      }] as ToolContent[],
    };
  }

  async syncPush(syncDir?: string, instance_id?: string, options?: SafetyOptions) {
    const dir = this._resolveSyncDir(syncDir);
    const studio = new Map(
      (await this._dumpStudioScripts(instance_id)).map((s) => [this.sync.instancePathToFilePath(s.path, s.className), { source: s.source, path: s.path }] as const),
    );
    const local = this._walkLocalScripts(dir);
    const base = this._readManifest(dir);
    const pushed: string[] = [];
    const conflicts: string[] = [];
    const wouldPush: string[] = [];

    for (const [rel, content] of local) {
      if (this.sync.isIgnored(rel)) continue;
      const studioEntry = studio.get(rel);
      const kind = this.sync.detectConflict({ local: content, base: base[rel], studio: studioEntry?.source });
      if (kind === 'none' || kind === 'studio') continue; // nothing local to push, or studio is authoritative
      if (kind === 'both') { conflicts.push(rel); continue; }
      // kind === 'local' — safe to push
      const mapped = this.sync.filePathToInstancePath(rel);
      if (!mapped) continue;
      if (options?.dryRun) { wouldPush.push(rel); continue; }
      await this._callSingle('/api/set-script-source', { instancePath: mapped.instancePath, source: content }, undefined, instance_id);
      base[rel] = content;
      pushed.push(rel);
    }

    if (!options?.dryRun && pushed.length > 0) {
      this._writeManifest(dir, base);
      this.safety.recordOperation({ kind: 'sync_push', summary: `pushed ${pushed.length} scripts from ${dir}` });
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          dir,
          dryRun: options?.dryRun === true,
          pushed: options?.dryRun ? wouldPush : pushed,
          conflictsSkipped: conflicts,
          hint: conflicts.length > 0 ? 'Conflicts changed on both sides; resolve manually then re-run, or sync_pull to take Studio.' : undefined,
        }, null, 2),
      }] as ToolContent[],
    };
  }

  // Resolve (instance_id, target-role) → concrete (instanceId, role) and
  // dispatch a single request. Throws RoutingFailure if the resolution is
  // ambiguous, missing, or asks for fanout on a non-fanout-capable tool —
  // the MCP transport layer surfaces it as a structured error result so
  // the LLM can recover via the embedded data.instances list.
  private async _callSingle(
    endpoint: string,
    data: any,
    target: string | undefined,
    instance_id: string | undefined,
  ): Promise<any> {
    // Pass target through as-is so resolveTarget can tell "caller didn't
    // specify" (target=undefined → multiple_instances_connected) apart
    // from "caller picked edit explicitly" (target='edit' → ambiguous_target).
    // Tools that intrinsically need a specific role pass it as a string
    // literal here; tools without a target arg pass undefined.
    const r = this.bridge.resolveTarget({ instance_id, target });
    if (!r.ok) throw new RoutingFailure(r.error);
    if (r.mode !== 'single') {
      throw new RoutingFailure({
        code: 'target_role_not_present_on_instance',
        message: 'This tool does not support target=all. Pick a specific role or omit target.',
        data: {
          instances: this.bridge.getPublicInstances(),
          count: this.bridge.getInstances().length,
        },
      });
    }
    return this.client.request(endpoint, data, r.targetInstanceId, r.targetRole);
  }

  // Resolves which connected place a tool should target and whether a playtest
  // CLIENT peer is present on it. Used by capture/input to auto-route to the
  // running client (where the live viewport + input pipeline are) without the
  // caller having to pass target. Throws RoutingFailure with the standard
  // instance list if the place is ambiguous (multiple connected, no instance_id).
  private _resolveRuntime(instance_id?: string): { instanceId: string; clientRole?: string } {
    const r = this.bridge.resolveTarget({ instance_id, target: undefined });
    if (!r.ok) throw new RoutingFailure(r.error);
    // resolveTarget(target=undefined) prefers the edit role and always returns
    // a single target, so targetInstanceId is the resolved place.
    const resolvedId = (r as { targetInstanceId: string }).targetInstanceId;
    const equivalentIds = new Set(this.bridge.getEquivalentInstanceIds(resolvedId));
    const instances = this.bridge
      .getInstances()
      .filter((i) => equivalentIds.has(i.instanceId));
    // Prefer client-1 when several clients are connected (multi-client playtest).
    const client = instances
      .filter((inst) => inst.role.startsWith('client'))
      .sort((a, b) => a.role.localeCompare(b.role))[0];
    return { instanceId: client?.instanceId ?? resolvedId, clientRole: client?.role };
  }

  private _resolveInstanceIdOnly(instance_id?: string): string {
    const instances = this.bridge.getInstances();
    const publicList = this.bridge.getPublicInstances();
    const errorData = { instances: publicList, count: publicList.length };

    if (instance_id !== undefined) {
      const resolvedInstanceId = this.bridge.resolveInstanceId(instance_id);
      if (!instances.some((i) => i.instanceId === resolvedInstanceId)) {
        throw new RoutingFailure({
          code: 'unrecognized_instance_id',
          message: `instance_id "${instance_id}" is not connected. Pass one from data.instances.`,
          data: errorData,
        });
      }
      return resolvedInstanceId;
    }

    const distinct = Array.from(new Set(instances.map((i) => i.instanceId)));
    if (distinct.length === 0) {
      throw new RoutingFailure({
        code: 'unrecognized_instance_id',
        message: 'No Studio plugin is connected.',
        data: errorData,
      });
    }
    if (distinct.length > 1) {
      throw new RoutingFailure({
        code: 'multiple_instances_connected',
        message: 'Multiple Studio places are connected. Pass instance_id to disambiguate.',
        data: errorData,
      });
    }
    return distinct[0];
  }

  private _resolveSingleTarget(target: string, instance_id?: string): { instanceId: string; role: string } {
    const resolved = this.bridge.resolveTarget({ instance_id, target });
    if (!resolved.ok) throw new RoutingFailure(resolved.error);
    if (resolved.mode !== 'single') {
      throw new RoutingFailure({
        code: 'target_role_not_present_on_instance',
        message: 'Pick a specific target role for this tool.',
        data: {
          instances: this.bridge.getPublicInstances(),
          count: this.bridge.getInstances().length,
        },
      });
    }
    return { instanceId: resolved.targetInstanceId, role: resolved.targetRole };
  }

  private _rolesForInstance(instanceId: string): string[] {
    return this.bridge.getInstances()
      .filter((i) => i.instanceId === instanceId)
      .map((i) => i.role);
  }

  private _rolesForEquivalentInstances(instanceId: string): string[] {
    const instanceIds = new Set(this.bridge.getEquivalentInstanceIds(instanceId));
    return this.bridge.getInstances()
      .filter((i) => instanceIds.has(i.instanceId))
      .map((i) => i.role);
  }

  private _clientRolesForInstance(instanceId: string): string[] {
    return this._rolesForInstance(instanceId)
      .filter((role) => /^client-\d+$/.test(role))
      .sort((a, b) => Number(a.slice('client-'.length)) - Number(b.slice('client-'.length)));
  }

  private _runtimeTargetsForEquivalentInstances(instanceId: string): { instanceId: string; role: string }[] {
    const instanceIds = new Set(this.bridge.getEquivalentInstanceIds(instanceId));
    return this.bridge.getInstances()
      .filter((i) => instanceIds.has(i.instanceId) && (i.role === 'server' || /^client-\d+$/.test(i.role)))
      .map((i) => ({ instanceId: i.instanceId, role: i.role }));
  }

  private _resolveDeviceSimulatorSingleTarget(
    target: string | undefined,
    instance_id: string | undefined,
    toolName: string,
  ): { instanceId: string; role: string; selectedTarget: string } {
    const selectedTarget = target ?? 'edit';
    if (selectedTarget === 'server' || selectedTarget === 'all' || selectedTarget === 'all-clients' || selectedTarget === 'edit-proxy') {
      throw new Error(`${toolName} target must be "edit" or "client-N" (got: ${selectedTarget})`);
    }
    if (selectedTarget !== 'edit' && !/^client-\d+$/.test(selectedTarget)) {
      throw new Error(`${toolName} target must be "edit" or "client-N" (got: ${selectedTarget})`);
    }
    const resolved = this._resolveSingleTarget(selectedTarget, instance_id);
    return { ...resolved, selectedTarget };
  }

  private _resolveDeviceSimulatorSetTargets(
    target: string | undefined,
    instance_id: string | undefined,
  ): { instanceId: string; selectedTarget: string; roles: string[] } {
    const selectedTarget = target ?? 'edit';
    if (selectedTarget === 'all-clients') {
      const instanceId = this._resolveInstanceIdOnly(instance_id);
      const roles = this._clientRolesForInstance(instanceId);
      if (roles.length === 0) {
        throw new RoutingFailure({
          code: 'target_role_not_present_on_instance',
          message: `instance "${instanceId}" has no connected playtest client roles. Start a playtest first.`,
          data: {
            instances: this.bridge.getPublicInstances(),
            count: this.bridge.getInstances().length,
          },
        });
      }
      return { instanceId, selectedTarget, roles };
    }

    const resolved = this._resolveDeviceSimulatorSingleTarget(selectedTarget, instance_id, 'set_device_simulator');
    return { instanceId: resolved.instanceId, selectedTarget, roles: [resolved.role] };
  }

  private _normalizeSimulationInclude(include: string | undefined): SimulationInclude {
    const selectedInclude = include ?? 'both';
    if (selectedInclude !== 'network' && selectedInclude !== 'deviceSimulator' && selectedInclude !== 'both') {
      throw new Error(`get_simulation_state include must be "network", "deviceSimulator", or "both" (got: ${selectedInclude})`);
    }
    return selectedInclude;
  }

  private _resolveSimulationTargets(
    target: string | undefined,
    instance_id: string | undefined,
    toolName: string,
  ): { instanceId: string; selectedTarget: string; roles: string[]; warnings: string[] } {
    const selectedTarget = target ?? 'edit-and-clients';
    if (selectedTarget === 'server' || selectedTarget === 'all' || selectedTarget === 'edit-proxy') {
      throw new Error(`${toolName} target must be "edit", "client-N", "all-clients", or "edit-and-clients" (got: ${selectedTarget})`);
    }

    const instanceId = this._resolveInstanceIdOnly(instance_id);
    const connectedRoles = this._rolesForInstance(instanceId);
    const clientRoles = this._clientRolesForInstance(instanceId);
    const warnings: string[] = [];
    let roles: string[];

    if (selectedTarget === 'edit') {
      if (!connectedRoles.includes('edit')) {
        throw new RoutingFailure({
          code: 'target_role_not_present_on_instance',
          message: `instance "${instanceId}" has no role "edit". Available roles: ${connectedRoles.join(', ') || 'none'}.`,
          data: {
            instances: this.bridge.getPublicInstances(),
            count: this.bridge.getInstances().length,
          },
        });
      }
      roles = ['edit'];
    } else if (selectedTarget === 'all-clients') {
      roles = clientRoles;
      if (roles.length === 0) {
        warnings.push(`No connected playtest client roles found for instance "${instanceId}".`);
      }
    } else if (selectedTarget === 'edit-and-clients') {
      roles = [];
      if (connectedRoles.includes('edit')) {
        roles.push('edit');
      } else {
        warnings.push(`No edit role found for instance "${instanceId}".`);
      }
      roles.push(...clientRoles);
    } else if (/^client-\d+$/.test(selectedTarget)) {
      if (!clientRoles.includes(selectedTarget)) {
        throw new RoutingFailure({
          code: 'target_role_not_present_on_instance',
          message: `instance "${instanceId}" has no role "${selectedTarget}". Available client roles: ${clientRoles.join(', ') || 'none'}.`,
          data: {
            instances: this.bridge.getPublicInstances(),
            count: this.bridge.getInstances().length,
          },
        });
      }
      roles = [selectedTarget];
    } else {
      throw new Error(`${toolName} target must be "edit", "client-N", "all-clients", or "edit-and-clients" (got: ${selectedTarget})`);
    }

    return { instanceId, selectedTarget, roles, warnings };
  }

  private _parseExecuteLuauJsonResponse(response: unknown, toolName: string): unknown {
    const r = response as { success?: boolean; error?: string; message?: string; returnValue?: unknown };
    if (r?.success === false) {
      throw new Error(r.error || r.message || `${toolName} Luau execution failed`);
    }
    if (typeof r?.returnValue !== 'string') {
      return response;
    }
    if (r.returnValue === '') {
      return {};
    }
    try {
      return JSON.parse(r.returnValue);
    } catch {
      throw new Error(`${toolName} returned non-JSON data: ${r.returnValue}`);
    }
  }

  private async _executeNetworkStateOperation(
    instanceId: string,
    role: string,
    operation: 'get' | 'reset',
  ): Promise<unknown> {
    const code = buildNetworkStateLuau(operation);
    const response = await this.client.request('/api/execute-luau', { code }, instanceId, role);
    return this._parseExecuteLuauJsonResponse(response, `network simulation ${operation}`);
  }

  private async _executeDeviceSimulatorOperation(
    instanceId: string,
    role: string,
    operation: 'get' | 'set',
    options: Record<string, unknown>,
  ): Promise<unknown> {
    const code = buildDeviceSimulatorLuau(operation, options);
    const response = await this.client.request('/api/execute-luau', { code }, instanceId, role);
    return this._parseExecuteLuauJsonResponse(response, `device simulator ${operation}`);
  }

  private _settingsFromDeviceSimulatorState(state: unknown): DeviceSimulatorSettings | { stopSimulation: true } {
    const s = state as {
      isSimulating?: boolean;
      activeDeviceId?: unknown;
      orientation?: unknown;
      resolution?: unknown;
      pixelDensity?: unknown;
      scalingMode?: unknown;
    };
    if (!s || s.isSimulating !== true || typeof s.activeDeviceId !== 'string' || s.activeDeviceId === 'default') {
      return { stopSimulation: true };
    }
    return normalizeDeviceSimulatorSettings({
      deviceId: s.activeDeviceId,
      orientation: s.orientation,
      resolution: s.resolution,
      pixelDensity: s.pixelDensity,
      scalingMode: s.scalingMode,
    });
  }

  private _deviceSimulatorStateWithoutDeviceList(state: unknown): unknown {
    if (typeof state !== 'object' || state === null || Array.isArray(state)) {
      return state;
    }
    const { devices: _devices, ...rest } = state as Record<string, unknown>;
    return rest;
  }

  private _assertCanRestoreDeviceSimulatorState(state: unknown): void {
    const s = state as {
      isSimulating?: boolean;
      activeDeviceId?: unknown;
      devices?: unknown;
    };
    if (!s || s.isSimulating !== true || typeof s.activeDeviceId !== 'string' || s.activeDeviceId === 'default') {
      return;
    }
    const devices = Array.isArray(s.devices) ? s.devices : [];
    const isBuiltIn = devices.some((entry) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false;
      const device = entry as { DeviceId?: unknown; deviceId?: unknown; Id?: unknown; id?: unknown; IsCustom?: unknown };
      const id = device.DeviceId ?? device.deviceId ?? device.Id ?? device.id;
      return id === s.activeDeviceId && device.IsCustom !== true;
    });
    if (!isBuiltIn) {
      throw new Error(
        `capture_device_matrix cannot safely restore active custom device "${s.activeDeviceId}". ` +
        'Switch the simulator to default or a built-in preset first, or pass restoreAfter=false only if you intentionally accept changing the simulator state.',
      );
    }
  }

  private async _waitForRuntimeRoles(
    instanceId: string,
    opts: { server?: boolean; clientCount?: number; absentRole?: string; noRuntime?: boolean },
    timeoutSec = 30,
    equivalentInstances = false,
  ): Promise<{ ok: boolean; roles: string[]; timedOut: boolean }> {
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      const roles = equivalentInstances ? this._rolesForEquivalentInstances(instanceId) : this._rolesForInstance(instanceId);
      const clientRoles = equivalentInstances
        ? roles.filter((role) => /^client-\d+$/.test(role))
        : this._clientRolesForInstance(instanceId);
      const hasServer = !opts.server || roles.includes('server');
      const hasClients = opts.clientCount === undefined || clientRoles.length >= opts.clientCount;
      const absent = opts.absentRole === undefined || !roles.includes(opts.absentRole);
      const runtimeAbsent = !opts.noRuntime || !roles.some((role) => role === 'server' || /^client-\d+$/.test(role));
      if (hasServer && hasClients && absent && runtimeAbsent) {
        return { ok: true, roles, timedOut: false };
      }
      await sleep(250);
    }
    return {
      ok: false,
      roles: equivalentInstances ? this._rolesForEquivalentInstances(instanceId) : this._rolesForInstance(instanceId),
      timedOut: true,
    };
  }

  private async _waitForExactClientCount(
    instanceId: string,
    expectedClientCount: number,
    timeoutSec = 30,
    stableMs = 3000,
  ): Promise<{ ok: boolean; roles: string[]; timedOut: boolean; extraClients: boolean; clientCount: number }> {
    const deadline = Date.now() + timeoutSec * 1000;
    let exactSince: number | undefined;

    while (Date.now() < deadline) {
      const roles = this._rolesForInstance(instanceId);
      const clientCount = this._clientRolesForInstance(instanceId).length;
      if (clientCount > expectedClientCount) {
        return { ok: false, roles, timedOut: false, extraClients: true, clientCount };
      }
      if (roles.includes('server') && clientCount === expectedClientCount) {
        exactSince ??= Date.now();
        if (Date.now() - exactSince >= stableMs) {
          return { ok: true, roles, timedOut: false, extraClients: false, clientCount };
        }
      } else {
        exactSince = undefined;
      }
      await sleep(250);
    }

    const roles = this._rolesForInstance(instanceId);
    const clientCount = this._clientRolesForInstance(instanceId).length;
    return { ok: false, roles, timedOut: true, extraClients: clientCount > expectedClientCount, clientCount };
  }

  private async _waitForRuntimeRolesFresh(
    instanceId: string,
    connectedAfter: number,
    requiredRoles: string[],
    timeoutSec = 60,
    equivalentInstances = false,
  ): Promise<{ ok: boolean; roles: string[]; timedOut: boolean }> {
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      const instanceIds = equivalentInstances ? new Set(this.bridge.getEquivalentInstanceIds(instanceId)) : new Set([instanceId]);
      const instances = this.bridge.getInstances().filter((i) => instanceIds.has(i.instanceId));
      const roles = instances.map((i) => i.role);
      const freshRoles = new Set(
        instances
          .filter((i) => i.connectedAt >= connectedAfter)
          .map((i) => i.role),
      );
      if (requiredRoles.every((role) => freshRoles.has(role))) {
        return { ok: true, roles, timedOut: false };
      }
      await sleep(250);
    }
    return {
      ok: false,
      roles: equivalentInstances ? this._rolesForEquivalentInstances(instanceId) : this._rolesForInstance(instanceId),
      timedOut: true,
    };
  }


  async getFileTree(path: string = '', instance_id?: string) {
    const response = await this._callSingle('/api/file-tree', { path }, undefined, instance_id);
    return compactText(response);
  }

  async searchFiles(query: string, searchType: string = 'name', instance_id?: string) {
    const response = await this._callSingle('/api/search-files', { query, searchType }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }


  async getPlaceInfo(instance_id?: string) {
    const response = await this._callSingle('/api/place-info', {}, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async getServices(serviceName?: string, instance_id?: string) {
    const response = await this._callSingle('/api/services', { serviceName }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async searchObjects(query: string, searchType: string = 'name', propertyName?: string, instance_id?: string) {
    const response = await this._callSingle('/api/search-objects', {
      query,
      searchType,
      propertyName
    }, undefined, instance_id);
    return compactText(response);
  }


  async getInstanceProperties(instancePath: string, excludeSource?: boolean, instance_id?: string) {
    if (!instancePath) {
      throw new Error('Instance path is required for get_instance_properties');
    }
    const response = await this._callSingle('/api/instance-properties', { instancePath, excludeSource }, undefined, instance_id);
    return compactText(response);
  }

  async getInstanceChildren(instancePath: string, instance_id?: string) {
    if (!instancePath) {
      throw new Error('Instance path is required for get_instance_children');
    }
    // The plugin's file watcher debounces ~500ms behind edits, so a path that was
    // just created can briefly read back as NOT_FOUND (bug B3/B5). Retry once after
    // a short delay before surfacing the failure.
    let response = await this._callSingle('/api/instance-children', { instancePath }, undefined, instance_id);
    if (responseErrorCode(response) === 'NOT_FOUND') {
      await sleep(450);
      response = await this._callSingle('/api/instance-children', { instancePath }, undefined, instance_id);
    }
    return compactText(response);
  }

  async searchByProperty(propertyName: string, propertyValue: string, instance_id?: string) {
    if (!propertyName || !propertyValue) {
      throw new Error('Property name and value are required for search_by_property');
    }
    const response = await this._callSingle('/api/search-by-property', {
      propertyName,
      propertyValue
    }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async getClassInfo(className: string, instance_id?: string) {
    if (!className) {
      throw new Error('Class name is required for get_class_info');
    }
    const response = await this._callSingle('/api/class-info', { className }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }


  async getProjectStructure(path?: string, maxDepth?: number, scriptsOnly?: boolean, instance_id?: string) {
    const response = await this._callSingle('/api/project-structure', {
      path,
      maxDepth,
      scriptsOnly
    }, undefined, instance_id);
    return compactText(response);
  }



  async setProperty(instancePath: string, propertyName: string, propertyValue: any, instance_id?: string) {
    if (!instancePath || !propertyName) {
      throw new Error('Instance path and property name are required for set_property');
    }
    const response = await this._callSingle('/api/set-property', {
      instancePath,
      propertyName,
      propertyValue
    }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async setProperties(instancePath: string, properties: Record<string, any>, instance_id?: string) {
    if (!instancePath || !properties) {
      throw new Error('instancePath and properties are required for set_properties');
    }
    const response = await this._callSingle('/api/set-properties', { instancePath, properties }, undefined, instance_id);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }

  async massSetProperty(paths: string[], propertyName: string, propertyValue: any, instance_id?: string) {
    if (!paths || paths.length === 0 || !propertyName) {
      throw new Error('Paths array and property name are required for mass_set_property');
    }
    const response = await this._callSingle('/api/mass-set-property', {
      paths,
      propertyName,
      propertyValue
    }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async massGetProperty(paths: string[], propertyName: string, instance_id?: string) {
    if (!paths || paths.length === 0 || !propertyName) {
      throw new Error('Paths array and property name are required for mass_get_property');
    }
    const response = await this._callSingle('/api/mass-get-property', {
      paths,
      propertyName
    }, undefined, instance_id);
    return compactText(response);
  }


  async createObject(className: string, parent: string, name?: string, properties?: Record<string, any>, instance_id?: string) {
    if (!className || !parent) {
      throw new Error('Class name and parent are required for create_object');
    }
    const response = await this._callSingle('/api/create-object', {
      className,
      parent,
      name,
      properties
    }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async massCreateObjects(objects: Array<{className: string, parent: string, name?: string, properties?: Record<string, any>}>, instance_id?: string, options?: SafetyOptions) {
    if (!objects || objects.length === 0) {
      throw new Error('Objects array is required for mass_create_objects');
    }
    const gated = this._safetyGate('bulk_create', `create ${objects.length} objects`, { count: objects.length }, options);
    if (gated) return gated;
    const response = await this._callSingle('/api/mass-create-objects', { objects }, undefined, instance_id);
    this.safety.recordOperation({ kind: 'bulk_create', summary: `created ${objects.length} objects` });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async deleteObject(instancePath: string, instance_id?: string, options?: SafetyOptions) {
    if (!instancePath) {
      throw new Error('Instance path is required for delete_object');
    }
    const gated = this._safetyGate('delete', `delete ${instancePath}`, { path: instancePath }, options);
    if (gated) return gated;
    const response = await this._callSingle('/api/delete-object', { instancePath }, undefined, instance_id);
    this.safety.recordOperation({ kind: 'delete', summary: `deleted ${instancePath}` });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }


  async smartDuplicate(
    instancePath: string,
    count: number,
    options?: {
      namePattern?: string;
      positionOffset?: [number, number, number];
      rotationOffset?: [number, number, number];
      scaleOffset?: [number, number, number];
      propertyVariations?: Record<string, any[]>;
      targetParents?: string[];
    },
    instance_id?: string
  ) {
    if (!instancePath || count < 1) {
      throw new Error('Instance path and count > 0 are required for smart_duplicate');
    }
    const response = await this._callSingle('/api/smart-duplicate', {
      instancePath,
      count,
      options
    }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async massDuplicate(
    duplications: Array<{
      instancePath: string;
      count: number;
      options?: {
        namePattern?: string;
        positionOffset?: [number, number, number];
        rotationOffset?: [number, number, number];
        scaleOffset?: [number, number, number];
        propertyVariations?: Record<string, any[]>;
        targetParents?: string[];
      }
    }>,
    instance_id?: string
  ) {
    if (!duplications || duplications.length === 0) {
      throw new Error('Duplications array is required for mass_duplicate');
    }
    const response = await this._callSingle('/api/mass-duplicate', { duplications }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }




  async getScriptSource(instancePath: string, startLine?: number, endLine?: number, instance_id?: string) {
    if (!instancePath) {
      throw new Error('Instance path is required for get_script_source');
    }
    const response = await this._callSingle('/api/get-script-source', { instancePath, startLine, endLine }, undefined, instance_id);

    if (response.error) {
      return { content: [{ type: 'text', text: `Error: ${response.error}` }] };
    }

    const scriptTypeInfo: Record<string, string> = {
      'Script': 'Server Script, runs on the server only',
      'LocalScript': 'Local Script, runs on the client',
      'ModuleScript': 'Module Script, shared library loaded via require()',
    };

    const serviceInfo: Record<string, string> = {
      'Workspace': 'Workspace, 3D world replicated to all clients',
      'ServerScriptService': 'ServerScriptService, server only',
      'ServerStorage': 'ServerStorage, server only storage',
      'StarterGui': 'StarterGui, UI templates copied to each player',
      'StarterPlayerScripts': 'StarterPlayerScripts, client scripts',
      'StarterCharacterScripts': 'StarterCharacterScripts, character scripts',
      'ReplicatedStorage': 'ReplicatedStorage, shared server and client',
      'ReplicatedFirst': 'ReplicatedFirst, first to load on client',
    };

    const pathStr = (response.instancePath as string) || instancePath;
    const pathSegments = pathStr.split('.');
    const topService =
      typeof response.topService === 'string' && response.topService.length > 0
        ? response.topService
        : pathSegments[0] === 'game' ? (pathSegments[1] ?? 'game') : pathSegments[0];
    const typeNote = scriptTypeInfo[response.className as string] || (response.className as string);
    const serviceNote = serviceInfo[topService] || topService;

    const headerLines: string[] = [
      `Path:     ${pathStr}`,
      `Type:     ${typeNote}`,
      `Location: ${serviceNote}`,
      `Lines:    ${response.lineCount} total${
        response.isPartial ? ` (showing ${response.startLine}-${response.endLine})` : ''
      }`,
    ];

    if (response.enabled === false) {
      headerLines.push(`Status:   DISABLED`);
    }

    if (response.truncated) {
      headerLines.push(`Note:     Truncated to first 1000 lines, use startLine/endLine to read more`);
    }

    const header = headerLines.join('\n');
    const code = (response.numberedSource || response.source) as string;

    return {
      content: [{
        type: 'text',
        text: `${header}\n\n${code}`,
      }]
    };
  }

  async setScriptSource(instancePath: string, source: string, instance_id?: string, options?: SafetyOptions) {
    if (!instancePath || typeof source !== 'string') {
      throw new Error('Instance path and source code string are required for set_script_source');
    }
    const gated = this._safetyGate('set_script_source', `overwrite ${instancePath} (${source.length} chars)`, { scriptSize: source.length }, options);
    if (gated) return gated;

    // Back up the current source before overwriting so the change is reversible
    // via restore_script_backup. A failed backup fetch must not block the write,
    // but we surface it as a warning so the caller knows undo is unavailable.
    let backupWarning = '';
    try {
      const current = await this._callSingle('/api/get-script-source', { instancePath }, undefined, instance_id);
      if (typeof current?.source === 'string') {
        this.safety.backupScript(instancePath, current.source);
      }
    } catch (error) {
      backupWarning = ` (warning: could not back up previous source: ${errorMessage(error)})`;
    }

    const response = await this._callSingle('/api/set-script-source', { instancePath, source }, undefined, instance_id);
    this.safety.recordOperation({ kind: 'set_script_source', summary: `overwrote ${instancePath} (${source.length} chars)` });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response) + backupWarning
        }
      ]
    };
  }


  async editScriptLines(instancePath: string, oldString: string, newString: string, startLine?: number, instance_id?: string) {
    if (!instancePath || typeof oldString !== 'string' || typeof newString !== 'string') {
      throw new Error('Instance path, old_string, and new_string are required for edit_script_lines');
    }
    const payload: Record<string, unknown> = { instancePath, old_string: oldString, new_string: newString };
    if (startLine !== undefined) payload.startLine = startLine;
    const response = await this._callSingle('/api/edit-script-lines', payload, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async insertScriptLines(instancePath: string, afterLine: number, newContent: string, instance_id?: string) {
    if (!instancePath || typeof newContent !== 'string') {
      throw new Error('Instance path and newContent are required for insert_script_lines');
    }
    const response = await this._callSingle('/api/insert-script-lines', { instancePath, afterLine: afterLine || 0, newContent }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async deleteScriptLines(instancePath: string, startLine: number, endLine: number, instance_id?: string) {
    if (!instancePath || !startLine || !endLine) {
      throw new Error('Instance path, startLine, and endLine are required for delete_script_lines');
    }
    const response = await this._callSingle('/api/delete-script-lines', { instancePath, startLine, endLine }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }


  async grepScripts(
    pattern: string,
    options?: {
      caseSensitive?: boolean;
      usePattern?: boolean;
      contextLines?: number;
      maxResults?: number;
      maxResultsPerScript?: number;
      filesOnly?: boolean;
      path?: string;
      classFilter?: string;
    },
    instance_id?: string
  ) {
    if (!pattern) {
      throw new Error('Pattern is required for grep_scripts');
    }
    const response = await this._callSingle('/api/grep-scripts', {
      pattern,
      ...options
    }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async setAttribute(instancePath: string, attributeName: string, attributeValue: any, valueType?: string, instance_id?: string) {
    if (!instancePath || !attributeName) {
      throw new Error('Instance path and attribute name are required for set_attribute');
    }
    const response = await this._callSingle('/api/set-attribute', { instancePath, attributeName, attributeValue, valueType }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async getAttributes(instancePath: string, instance_id?: string) {
    if (!instancePath) {
      throw new Error('Instance path is required for get_attributes');
    }
    const response = await this._callSingle('/api/get-attributes', { instancePath }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async deleteAttribute(instancePath: string, attributeName: string, instance_id?: string) {
    if (!instancePath || !attributeName) {
      throw new Error('Instance path and attribute name are required for delete_attribute');
    }
    const response = await this._callSingle('/api/delete-attribute', { instancePath, attributeName }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }


  async getTags(instancePath: string, instance_id?: string) {
    if (!instancePath) {
      throw new Error('Instance path is required for get_tags');
    }
    const response = await this._callSingle('/api/get-tags', { instancePath }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async addTag(instancePath: string, tagName: string, instance_id?: string) {
    if (!instancePath || !tagName) {
      throw new Error('Instance path and tag name are required for add_tag');
    }
    const response = await this._callSingle('/api/add-tag', { instancePath, tagName }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async removeTag(instancePath: string, tagName: string, instance_id?: string) {
    if (!instancePath || !tagName) {
      throw new Error('Instance path and tag name are required for remove_tag');
    }
    const response = await this._callSingle('/api/remove-tag', { instancePath, tagName }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async getTagged(tagName: string, instance_id?: string) {
    if (!tagName) {
      throw new Error('Tag name is required for get_tagged');
    }
    const response = await this._callSingle('/api/get-tagged', { tagName }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async getSelection(instance_id?: string) {
    const response = await this._callSingle('/api/get-selection', {}, undefined, instance_id);
    return compactText(response);
  }

  async executeLuau(code: string, target?: string, instance_id?: string, options?: SafetyOptions) {
    if (!code) {
      throw new Error('Code is required for execute_luau');
    }
    const gated = this._safetyGate('execute_luau', 'run Luau in Studio', { code }, options);
    if (gated) return gated;
    const response = await this._callSingle('/api/execute-luau', { code }, target || 'edit', instance_id);
    this.safety.recordOperation({ kind: 'execute_luau', summary: `ran Luau (${code.length} chars)` });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async evalServerRuntime(code: string, instance_id?: string) {
    if (!code) {
      throw new Error('Code is required for eval_server_runtime');
    }
    const response = await this._callSingle('/api/eval-runtime', { code }, 'server', instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async evalClientRuntime(code: string, target?: string, instance_id?: string) {
    if (!code) {
      throw new Error('Code is required for eval_client_runtime');
    }
    const clientTarget = target || 'client-1';
    if (!clientTarget.startsWith('client-')) {
      throw new Error(`eval_client_runtime requires target=client-N (got: ${clientTarget})`);
    }
    const response = await this._callSingle('/api/eval-runtime', { code }, clientTarget, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async setNetworkProfile(profile: string, target?: string, overrides?: Record<string, unknown>, instance_id?: string) {
    const values = normalizeNetworkProfile(profile, overrides);
    const instanceId = this._resolveInstanceIdOnly(instance_id);
    const clientRoles = this._clientRolesForInstance(instanceId);
    const selectedTarget = target ?? 'client-1';

    let targetRoles: string[];
    if (selectedTarget === 'all-clients') {
      targetRoles = clientRoles;
    } else if (/^client-\d+$/.test(selectedTarget)) {
      if (!clientRoles.includes(selectedTarget)) {
        throw new RoutingFailure({
          code: 'target_role_not_present_on_instance',
          message: `instance "${instanceId}" has no role "${selectedTarget}". Available client roles: ${clientRoles.join(', ') || 'none'}.`,
          data: {
            instances: this.bridge.getPublicInstances(),
            count: this.bridge.getInstances().length,
          },
        });
      }
      targetRoles = [selectedTarget];
    } else {
      throw new Error(`set_network_profile target must be "client-N" or "all-clients" (got: ${selectedTarget})`);
    }

    if (targetRoles.length === 0) {
      throw new RoutingFailure({
        code: 'target_role_not_present_on_instance',
        message: `instance "${instanceId}" has no connected playtest client roles. Start a playtest first.`,
        data: {
          instances: this.bridge.getPublicInstances(),
          count: this.bridge.getInstances().length,
        },
      });
    }

    const code = buildNetworkProfileLuau(profile, values);
    const responses = await Promise.allSettled(
      targetRoles.map(async (role) => {
        const response = await this.client.request('/api/execute-luau', { code }, instanceId, role);
        const result = this._parseExecuteLuauJsonResponse(response, 'set_network_profile');
        return { role, result };
      }),
    );

    const body: Record<string, unknown> = {
      profile,
      target: selectedTarget,
      applied: values,
      targets: {},
    };
    const targetResults = body.targets as Record<string, unknown>;
    const failures: string[] = [];
    for (let i = 0; i < responses.length; i++) {
      const role = targetRoles[i];
      const response = responses[i];
      if (response.status === 'fulfilled') {
        targetResults[role] = response.value.result;
      } else {
        const message = errorMessage(response.reason);
        targetResults[role] = { error: message };
        failures.push(`${role}: ${message}`);
      }
    }

    if (failures.length > 0) {
      throw new Error(`set_network_profile failed for ${failures.join('; ')}. Partial result: ${JSON.stringify(body)}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(body),
        },
      ],
    };
  }

  async getSimulationState(include?: string, target?: string, instance_id?: string) {
    const selectedInclude = this._normalizeSimulationInclude(include);
    const includeNetwork = selectedInclude === 'network' || selectedInclude === 'both';
    const includeDeviceSimulator = selectedInclude === 'deviceSimulator' || selectedInclude === 'both';
    const resolved = this._resolveSimulationTargets(target, instance_id, 'get_simulation_state');

    const roleEntries = await Promise.all(resolved.roles.map(async (role) => {
      const state: Record<string, unknown> = {};
      const errors: Record<string, string> = {};

      if (includeNetwork) {
        try {
          state.network = await this._executeNetworkStateOperation(resolved.instanceId, role, 'get');
        } catch (error) {
          errors.network = errorMessage(error);
        }
      }

      if (includeDeviceSimulator) {
        try {
          state.deviceSimulator = await this._executeDeviceSimulatorOperation(
            resolved.instanceId,
            role,
            'get',
            { includeDeviceList: false },
          );
        } catch (error) {
          errors.deviceSimulator = errorMessage(error);
        }
      }

      if (Object.keys(errors).length > 0) {
        state.errors = errors;
      }
      return { role, state };
    }));

    const roles: Record<string, unknown> = {};
    for (const entry of roleEntries) {
      roles[entry.role] = entry.state;
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          include: selectedInclude,
          target: resolved.selectedTarget,
          roles,
          warnings: resolved.warnings,
          persistenceNotes: SIMULATION_PERSISTENCE_NOTES,
        }),
      }],
    };
  }

  async resetSimulationState(target?: string, network?: boolean, deviceSimulator?: boolean, instance_id?: string) {
    const resetNetwork = network !== false;
    const resetDeviceSimulator = deviceSimulator !== false;
    if (!resetNetwork && !resetDeviceSimulator) {
      throw new Error('reset_simulation_state requires network=true and/or deviceSimulator=true; both default to true');
    }

    const resolved = this._resolveSimulationTargets(target, instance_id, 'reset_simulation_state');
    const roleEntries = await Promise.all(resolved.roles.map(async (role) => {
      const result: Record<string, unknown> = {};
      const errors: Record<string, string> = {};

      if (resetNetwork) {
        try {
          result.network = await this._executeNetworkStateOperation(resolved.instanceId, role, 'reset');
        } catch (error) {
          errors.network = errorMessage(error);
        }
      }

      if (resetDeviceSimulator) {
        try {
          result.deviceSimulator = await this._executeDeviceSimulatorOperation(
            resolved.instanceId,
            role,
            'set',
            { stopSimulation: true },
          );
        } catch (error) {
          errors.deviceSimulator = errorMessage(error);
        }
      }

      if (Object.keys(errors).length > 0) {
        result.errors = errors;
      }
      return { role, result };
    }));

    const roles: Record<string, unknown> = {};
    const failures: string[] = [];
    for (const entry of roleEntries) {
      roles[entry.role] = entry.result;
      const errors = (entry.result as { errors?: Record<string, string> }).errors;
      if (errors) {
        for (const [kind, message] of Object.entries(errors)) {
          failures.push(`${entry.role}.${kind}: ${message}`);
        }
      }
    }

    const body = {
      target: resolved.selectedTarget,
      network: resetNetwork,
      deviceSimulator: resetDeviceSimulator,
      roles,
      warnings: resolved.warnings,
      persistenceNotes: SIMULATION_PERSISTENCE_NOTES,
    };

    if (failures.length > 0) {
      throw new Error(`reset_simulation_state failed for ${failures.join('; ')}. Partial result: ${JSON.stringify(body)}`);
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(body),
      }],
    };
  }

  async getDeviceSimulatorState(target?: string, deviceId?: string, includeDeviceList?: boolean, instance_id?: string) {
    if (deviceId !== undefined && (typeof deviceId !== 'string' || deviceId.trim() === '')) {
      throw new Error('deviceId must be a non-empty string when provided');
    }
    const resolved = this._resolveDeviceSimulatorSingleTarget(target, instance_id, 'get_device_simulator_state');
    const state = await this._executeDeviceSimulatorOperation(
      resolved.instanceId,
      resolved.role,
      'get',
      {
        includeDeviceList: includeDeviceList !== false,
        deviceId,
      },
    );
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          target: resolved.selectedTarget,
          role: resolved.role,
          ...(state as Record<string, unknown>),
        }),
      }],
    };
  }

  async setDeviceSimulator(
    target?: string,
    deviceId?: string,
    orientation?: string,
    resolution?: unknown,
    pixelDensity?: number,
    scalingMode?: string,
    stopSimulation?: boolean,
    instance_id?: string,
  ) {
    const settings = normalizeDeviceSimulatorSettings({ deviceId, orientation, resolution, pixelDensity, scalingMode });
    if (stopSimulation === true && hasDeviceSimulatorSettings(settings)) {
      throw new Error('stopSimulation=true cannot be combined with deviceId, orientation, resolution, pixelDensity, or scalingMode');
    }
    if (stopSimulation !== true && !hasDeviceSimulatorSettings(settings)) {
      throw new Error('set_device_simulator requires stopSimulation=true or at least one simulator setting');
    }

    const resolved = this._resolveDeviceSimulatorSetTargets(target, instance_id);
    const responses = await Promise.allSettled(
      resolved.roles.map(async (role) => {
        const result = await this._executeDeviceSimulatorOperation(
          resolved.instanceId,
          role,
          'set',
          stopSimulation === true ? { stopSimulation: true } : { settings },
        );
        return { role, result };
      }),
    );

    const body: Record<string, unknown> = {
      target: resolved.selectedTarget,
      targets: {},
    };
    const targets = body.targets as Record<string, unknown>;
    const failures: string[] = [];
    for (let i = 0; i < responses.length; i++) {
      const role = resolved.roles[i];
      const response = responses[i];
      if (response.status === 'fulfilled') {
        targets[role] = response.value.result;
      } else {
        const message = errorMessage(response.reason);
        targets[role] = { error: message };
        failures.push(`${role}: ${message}`);
      }
    }

    if (failures.length > 0) {
      throw new Error(`set_device_simulator failed for ${failures.join('; ')}. Partial result: ${JSON.stringify(body)}`);
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(body),
      }],
    };
  }

  async captureDeviceMatrix(
    entries: unknown,
    target?: string,
    format?: string,
    quality?: number,
    settleSeconds?: number,
    restoreAfter?: boolean,
    instance_id?: string,
  ) {
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error('capture_device_matrix requires a non-empty entries array');
    }
    if (entries.length > MAX_DEVICE_MATRIX_ENTRIES) {
      throw new Error(`capture_device_matrix supports at most ${MAX_DEVICE_MATRIX_ENTRIES} entries per call; split larger matrices into multiple calls`);
    }

    const matrixEntries: DeviceSimulatorMatrixEntry[] = entries.map((entry, index) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new Error(`entries[${index}] must be an object`);
      }
      const raw = entry as Record<string, unknown>;
      if (raw.label !== undefined && typeof raw.label !== 'string') {
        throw new Error(`entries[${index}].label must be a string when provided`);
      }
      return {
        ...normalizeDeviceSimulatorSettings({
          deviceId: raw.deviceId,
          orientation: raw.orientation,
          resolution: raw.resolution,
          pixelDensity: raw.pixelDensity,
          scalingMode: raw.scalingMode,
        }),
        label: raw.label as string | undefined,
      };
    });

    const resolved = this._resolveDeviceSimulatorSingleTarget(target, instance_id, 'capture_device_matrix');
    if (resolved.role.startsWith('client-') && await this._isMultiplayerTestRunning(resolved.instanceId)) {
      throw new Error('capture_device_matrix does not support StudioTestService multiplayer client targets because Roblox scopes temporary screenshot textures per client process');
    }

    const settleMs = settleSeconds === undefined ? 300 : Math.max(0, Math.floor(settleSeconds * 1000));
    const shouldRestore = restoreAfter !== false;
    const before = await this._executeDeviceSimulatorOperation(
      resolved.instanceId,
      resolved.role,
      'get',
      { includeDeviceList: shouldRestore },
    );
    if (shouldRestore) {
      this._assertCanRestoreDeviceSimulatorState(before);
    }

    const summary: Record<string, unknown> = {
      target: resolved.selectedTarget,
      role: resolved.role,
      restoreAfter: shouldRestore,
      before: this._deviceSimulatorStateWithoutDeviceList(before),
      entries: [],
    };
    const entrySummaries = summary.entries as Array<Record<string, unknown>>;
    const content: ToolContent[] = [];
    const failures: string[] = [];

    try {
      for (let i = 0; i < matrixEntries.length; i++) {
        const entry = matrixEntries[i];
        const label = entry.label ?? `entry-${i + 1}`;
        const entrySummary: Record<string, unknown> = {
          index: i,
          label,
          settings: entry,
        };
        entrySummaries.push(entrySummary);

        try {
          const { label: _label, ...settings } = entry;
          const applied = await this._executeDeviceSimulatorOperation(
            resolved.instanceId,
            resolved.role,
            'set',
            { settings },
          );
          entrySummary.applied = applied;
          if (settleMs > 0) await sleep(settleMs);

          const capture = await this._captureViewportImage(resolved.instanceId, resolved.role, format, quality);
          if (capture.success) {
            entrySummary.screenshot = {
              width: capture.width,
              height: capture.height,
              format: capture.format,
              quality: capture.quality,
              mimeType: capture.mimeType,
            };
            content.push({
              type: 'text',
              text: `capture_device_matrix ${i + 1}/${matrixEntries.length} ${label}: ${capture.message}`,
            });
            content.push({
              type: 'image',
              data: capture.data,
              mimeType: capture.mimeType,
            });
          } else {
            entrySummary.error = capture.error;
            failures.push(`${label}: ${capture.error}`);
            content.push({
              type: 'text',
              text: `capture_device_matrix ${i + 1}/${matrixEntries.length} ${label}: ${capture.error}`,
            });
          }
        } catch (error) {
          const message = errorMessage(error);
          entrySummary.error = message;
          failures.push(`${label}: ${message}`);
          content.push({
            type: 'text',
            text: `capture_device_matrix ${i + 1}/${matrixEntries.length} ${label}: ${message}`,
          });
        }
      }
    } finally {
      if (shouldRestore) {
        try {
          const restoreSettings = this._settingsFromDeviceSimulatorState(before);
          if ('stopSimulation' in restoreSettings) {
            summary.restore = await this._executeDeviceSimulatorOperation(
              resolved.instanceId,
              resolved.role,
              'set',
              { stopSimulation: true },
            );
          } else {
            summary.restore = await this._executeDeviceSimulatorOperation(
              resolved.instanceId,
              resolved.role,
              'set',
              { settings: restoreSettings },
            );
          }
        } catch (error) {
          const message = errorMessage(error);
          summary.restoreError = message;
          failures.push(`restore: ${message}`);
        }
      }
    }

    if (failures.length > 0) {
      throw new Error(`capture_device_matrix failed for ${failures.join('; ')}. Partial result: ${JSON.stringify(summary)}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(summary),
        },
        ...content,
      ],
    };
  }

  async getRuntimeLogs(target?: string, since?: number, tail?: number, filter?: string, instance_id?: string) {
    // Per-capture in-memory log buffer (see studio-plugin RuntimeLogBuffer.ts).
    // target="all" (default) fans out to every connected instance except
    // edit-proxy (which has no buffer, just polls for stop-playtest), merges
    // by (ts, seq) and dedups same-message-and-level entries captured within
    // 2 seconds in different buffers. Ordinary Studio playtests reflect logs
    // across edit/server/client, so capturedBy is not a reliable origin peer;
    // only StudioTestService multiplayer sessions get a peer attribution.
    const tgt = target ?? 'all';
    const data: Record<string, unknown> = {};
    if (since !== undefined) data.since = since;
    if (tail !== undefined) data.tail = tail;
    if (filter !== undefined) data.filter = filter;

    // Resolve once. Single mode → one request and pass-through. Fanout
    // mode → iterate the resolved (instanceId, role) tuples; results keyed
    // by role within the selected instance, so duplicate roles across
    // different places no longer collapse (the v2.11.x bug).
    const resolved = this.bridge.resolveTarget({ instance_id, target: tgt });
    if (!resolved.ok) throw new RoutingFailure(resolved.error);

    if (resolved.mode === 'single') {
      const originPeerReliable = await this._isMultiplayerTestRunning(resolved.targetInstanceId);
      const response = (await this.client.request(
        '/api/get-runtime-logs',
        data,
        resolved.targetInstanceId,
        resolved.targetRole,
      )) as { capturedBy?: string; peer?: string; entries?: Array<{ capturedBy?: string; peer?: string }> } & Record<string, unknown>;
      // The plugin-side handler can only report generic "client" because the
      // client DM doesn't know its server-assigned client-N role. Normalize to
      // the resolved capture buffer, but do not claim script-origin peer unless
      // the selected place is running a StudioTestService multiplayer test.
      response.capturedBy = resolved.targetRole;
      delete response.peer;
      response.originPeerReliable = originPeerReliable;
      response.peerAttribution = originPeerReliable ? 'guaranteed_multiplayer' : 'unavailable_shared_logservice';
      if (originPeerReliable) response.peer = resolved.targetRole;
      if (Array.isArray(response.entries)) {
        for (const e of response.entries) {
          e.capturedBy = resolved.targetRole;
          delete e.peer;
          if (originPeerReliable) e.peer = resolved.targetRole;
        }
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(response) }],
      };
    }

    const targets = resolved.targets.filter((t) => t.targetRole !== 'edit-proxy');

    type PeerResponse = {
      capturedBy?: string;
      entries?: Entry[];
      totalDropped?: number;
      nextSince?: number;
      error?: string;
    };
    type Entry = { seq: number; ts: number; level: string; message: string; capturedBy?: string; peer?: string };
    const originPeerReliable = targets.length > 0
      ? await this._isMultiplayerTestRunning(targets[0].targetInstanceId)
      : false;

    const responses = await Promise.allSettled(
      targets.map(async (t) => {
        const r = (await this.client.request(
          '/api/get-runtime-logs',
          data,
          t.targetInstanceId,
          t.targetRole,
        )) as PeerResponse;
        return { ...r, capturedBy: t.targetRole };
      }),
    );

    const merged: Entry[] = [];
    const perCaptureNextSince: Record<string, number> = {};
    const perCaptureErrors: Record<string, string> = {};
    let totalDropped = 0;

    for (const r of responses) {
      if (r.status !== 'fulfilled') continue;
      const v = r.value;
      const capturedBy = v.capturedBy ?? 'unknown';
      if (v.error) {
        perCaptureErrors[capturedBy] = v.error;
        continue;
      }
      if (v.nextSince !== undefined) perCaptureNextSince[capturedBy] = v.nextSince;
      totalDropped += v.totalDropped ?? 0;
      for (const e of v.entries ?? []) {
        const entry = { ...e };
        delete entry.peer;
        merged.push({ ...entry, capturedBy });
      }
    }

    merged.sort((a, b) => (a.ts !== b.ts ? a.ts - b.ts : a.seq - b.seq));

    // Cross-peer dedup. LogService reflects prints across peers in Studio
    // Play, so the same message can land in multiple peers' buffers within
    // ~250ms (client batch) + ~700ms (peer-listener startup skew). 2s window
    // matches the LogBuffer primitive's heuristic.
    const DEDUP_WINDOW = 2.0;
    const deduped: Entry[] = [];
    for (const e of merged) {
      const isDup = deduped.some(
        (d) =>
          d.message === e.message &&
          d.level === e.level &&
          Math.abs(d.ts - e.ts) <= DEDUP_WINDOW &&
          d.capturedBy !== e.capturedBy,
      );
      if (!isDup) deduped.push(e);
    }

    // Re-apply tail post-merge since per-peer tail may have over-returned.
    let final = deduped;
    if (tail !== undefined && deduped.length > tail) {
      final = deduped.slice(deduped.length - tail);
    }
    const finalEntries = originPeerReliable
      ? final.map((e) => ({ ...e, peer: e.capturedBy }))
      : final;

    const body: Record<string, unknown> = {
      entries: finalEntries,
      totalDropped,
      perCaptureNextSince,
      originPeerReliable,
      peerAttribution: originPeerReliable ? 'guaranteed_multiplayer' : 'unavailable_shared_logservice',
    };
    if (originPeerReliable) {
      body.perPeerNextSince = perCaptureNextSince;
    }
    if (Object.keys(perCaptureErrors).length > 0) {
      body.perCaptureErrors = perCaptureErrors;
      if (originPeerReliable) body.perPeerErrors = perCaptureErrors;
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
  }

  async startPlaytest(mode: string, numPlayers?: number, instance_id?: string) {
    if (mode !== 'play' && mode !== 'run') {
      throw new Error('mode must be "play" or "run"');
    }
    if (numPlayers !== undefined) {
      throw new Error('start_playtest is single-player only. Use multiplayer_test_start for multi-client StudioTestService sessions.');
    }
    const data: Record<string, unknown> = { mode };
    const startedAt = Date.now();
    const resolved = this.bridge.resolveTarget({ instance_id, target: undefined });
    if (!resolved.ok) throw new RoutingFailure(resolved.error);
    if (resolved.mode !== 'single') {
      throw new RoutingFailure({
        code: 'target_role_not_present_on_instance',
        message: 'This tool does not support target=all. Pick a specific role or omit target.',
        data: {
          instances: this.bridge.getPublicInstances(),
          count: this.bridge.getInstances().length,
        },
      });
    }
    const response = await this.client.request(
      '/api/start-playtest',
      data,
      resolved.targetInstanceId,
      resolved.targetRole,
    );
    let wait: { ok: boolean; roles: string[]; timedOut: boolean } | undefined;
    if (response?.success === true) {
      const requiredRoles = mode === 'play' ? ['server', 'client-1'] : ['server'];
      wait = await this._waitForRuntimeRolesFresh(resolved.targetInstanceId, startedAt, requiredRoles, 60, true);
    }
    const body = wait
      ? {
        ...response,
        runtimeReady: wait.ok,
        timedOut: wait.timedOut,
        roles: wait.roles,
      }
      : response;
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(body)
        }
      ]
    };
  }

  async stopPlaytest(instance_id?: string) {
    // The edit DM's stopPlaytest handler writes a plugin:SetSetting request
    // that StopPlayMonitor reads from inside the play-server DM (the only DM where
    // StudioTestService:EndTest is legal). No edit-proxy peer registration is
    // involved — the cross-DM signal works regardless of MCP server state,
    // peer-role bookkeeping, or restart cycles.
    const { instanceId } = this._resolveSingleTarget('edit', instance_id);
    let response: Record<string, unknown>;
    let stopRequestError: string | undefined;
    try {
      response = await this.client.request('/api/stop-playtest', {}, instanceId, 'edit');
    } catch (error) {
      stopRequestError = errorMessage(error);
      response = {
        success: false,
        error: 'Edit stop request failed.',
        detail: stopRequestError,
      };
    }
    let wait: { ok: boolean; roles: string[]; timedOut: boolean } | undefined;
    if (response?.success === true) {
      wait = await this._waitForRuntimeRoles(instanceId, { noRuntime: true }, 15, true);
    } else if (this._runtimeTargetsForEquivalentInstances(instanceId).length > 0) {
      wait = {
        ok: false,
        roles: this._rolesForEquivalentInstances(instanceId),
        timedOut: false,
      };
    }
    const body = wait
      ? {
        ...response,
        runtimeStopped: wait.ok,
        timedOut: wait.timedOut,
        roles: wait.roles,
      }
      : response;
    if (wait && !wait.ok) {
      const runtimeRoles = wait.roles.filter((role) => role === 'server' || /^client-\d+$/.test(role));
      const failureBody = {
        ...body,
        success: false,
        error: 'Playtest teardown did not complete.',
        message: response?.success === true
          ? wait.timedOut
            ? 'Stop signal was accepted, but runtime peers did not disconnect before timeout.'
            : 'Stop signal was accepted, but runtime peers are still connected.'
          : 'Edit stop request failed, and runtime peers are still connected.',
        stopSignalAccepted: response?.success === true,
        stopRequestError,
        runtimeRoles,
        possibleCause:
          'A game shutdown hook such as BindToClose may be blocking Studio teardown. ' +
          'No runtime hard-stop or synthetic keyboard fallback was attempted.',
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(failureBody) }],
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
  }

  async getPlaytestOutput(target?: string, instance_id?: string) {
    const response = await this._callSingle('/api/get-playtest-output', {}, target || 'edit', instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  private async _buildMultiplayerState(instanceId: string): Promise<Record<string, unknown>> {
    const peers = this.bridge.getPublicInstances()
      .filter((i) => i.instanceId === instanceId)
      .sort((a, b) => a.role.localeCompare(b.role));

    const body: Record<string, unknown> = {
      instanceId,
      peers,
      peerCount: peers.length,
    };

    const edit = peers.find((p) => p.role === 'edit');
    const server = peers.find((p) => p.role === 'server');

    let editState: any | undefined;
    let serverState: any | undefined;

    if (edit) {
      try {
        editState = await this.client.request('/api/multiplayer-test-state', {}, instanceId, 'edit');
        body.edit = editState;
      } catch (err) {
        body.edit = { error: err instanceof Error ? err.message : String(err) };
      }
    }

    if (server) {
      try {
        serverState = await this.client.request('/api/multiplayer-test-state', {}, instanceId, 'server');
        body.server = serverState;
      } catch (err) {
        body.server = { error: err instanceof Error ? err.message : String(err) };
      }
    }

    const session = editState?.session;
    const rawPhase = typeof session?.phase === 'string' ? session.phase : undefined;
    const hasRuntime = peers.some((p) => p.role === 'server' || p.role.startsWith('client-'));
    body.phase = rawPhase === 'starting' && hasRuntime ? 'running' : (rawPhase ?? (hasRuntime ? 'running' : 'idle'));
    body.testId = session?.testId;
    body.numPlayers = session?.numPlayers;
    body.testArgs = session?.testArgs ?? serverState?.testArgs;
    body.result = session?.result;
    body.error = session?.error;
    body.players = serverState?.players ?? [];
    body.playerCount = serverState?.playerCount ?? 0;
    body.clientRoles = this._clientRolesForInstance(instanceId);

    return body;
  }

  private async _waitForMultiplayerEditDone(instanceId: string, timeoutSec = 30): Promise<boolean> {
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      if (!this._rolesForInstance(instanceId).includes('edit')) return false;
      try {
        const editState = await this.client.request('/api/multiplayer-test-state', {}, instanceId, 'edit');
        const phase = editState?.session?.phase;
        if (phase === 'completed' || phase === 'failed') return true;
      } catch {
        // The edit peer may be temporarily busy while Studio tears down.
      }
      await sleep(250);
    }
    return false;
  }

  private async _isMultiplayerTestRunning(instanceId: string): Promise<boolean> {
    const roles = this._rolesForInstance(instanceId);
    const hasServer = roles.includes('server');
    const clientCount = roles.filter((role) => role.startsWith('client-')).length;
    if (roles.includes('edit')) {
      try {
        const editState = await this.client.request('/api/multiplayer-test-state', {}, instanceId, 'edit');
        const phase = editState?.session?.phase;
        if (phase === 'starting' || phase === 'running') return true;
      } catch {
        // Fall through to the runtime-shape heuristic below. Direct/manual
        // StudioTestService multiplayer sessions do not update the edit peer's
        // MCP-managed session state, but they still expose distinct server and
        // client plugin peers.
      }
    }
    return hasServer && clientCount >= 2;
  }

  private async _waitForMultiplayerStart(
    instanceId: string,
    clientCount: number,
    timeoutSec = 30,
  ): Promise<{ ok: boolean; roles: string[]; timedOut: boolean; phase?: string; error?: unknown }> {
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      const exact = await this._waitForExactClientCount(instanceId, clientCount, 0.25, 0);
      if (exact.ok || exact.extraClients) {
        return { ok: exact.ok, roles: exact.roles, timedOut: false, error: exact.extraClients ? `Expected ${clientCount} client(s), but Studio registered ${exact.clientCount}.` : undefined };
      }
      try {
        const editState = await this.client.request('/api/multiplayer-test-state', {}, instanceId, 'edit');
        const session = editState?.session;
        if (session?.phase === 'failed' || session?.phase === 'completed') {
          return { ok: false, roles: this._rolesForInstance(instanceId), timedOut: false, phase: session.phase, error: session.error };
        }
      } catch {
        // Keep waiting; normal startup is driven by runtime peers registering.
      }
      await sleep(250);
    }
    return { ok: false, roles: this._rolesForInstance(instanceId), timedOut: true };
  }

  async multiplayerTestStart(numPlayers: number, testArgs?: unknown, timeout?: number, instance_id?: string) {
    if (!Number.isInteger(numPlayers) || numPlayers < 1 || numPlayers > 8) {
      throw new Error('numPlayers must be an integer from 1 to 8');
    }
    const editTarget = this._resolveSingleTarget('edit', instance_id);
    const response = await this.client.request(
      '/api/multiplayer-test-start',
      { numPlayers, testArgs: testArgs ?? {} },
      editTarget.instanceId,
      editTarget.role,
    );
    if (response?.error) {
      return { content: [{ type: 'text', text: JSON.stringify(response) }] };
    }

    const wait = await this._waitForMultiplayerStart(editTarget.instanceId, numPlayers, timeout ?? 30);
    const state = await this._buildMultiplayerState(editTarget.instanceId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ...response,
          ready: wait.ok,
          timedOut: wait.timedOut,
          wait,
          roles: wait.roles,
          state,
        }),
      }],
    };
  }

  async multiplayerTestState(instance_id?: string) {
    const instanceId = this._resolveInstanceIdOnly(instance_id);
    const state = await this._buildMultiplayerState(instanceId);
    return { content: [{ type: 'text', text: JSON.stringify(state) }] };
  }

  async multiplayerTestAddPlayers(numPlayers: number, timeout?: number, instance_id?: string) {
    if (!Number.isInteger(numPlayers) || numPlayers < 1 || numPlayers > 8) {
      throw new Error('numPlayers must be an integer from 1 to 8');
    }
    const serverTarget = this._resolveSingleTarget('server', instance_id);
    const before = this._clientRolesForInstance(serverTarget.instanceId).length;
    const response = await this.client.request(
      '/api/multiplayer-test-add-players',
      { numPlayers, timeout: timeout ?? 10 },
      serverTarget.instanceId,
      serverTarget.role,
    );
    if (response?.error) {
      return { content: [{ type: 'text', text: JSON.stringify(response) }] };
    }
    const wait = await this._waitForExactClientCount(serverTarget.instanceId, before + numPlayers, timeout ?? 30);
    const state = await this._buildMultiplayerState(serverTarget.instanceId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ...response,
          ready: wait.ok,
          timedOut: wait.timedOut,
          wait,
          roles: wait.roles,
          state,
        }),
      }],
    };
  }

  async multiplayerTestLeaveClient(target: string = 'client-1', timeout?: number, instance_id?: string) {
    if (!/^client-\d+$/.test(target)) {
      throw new Error(`multiplayer_test_leave_client requires target=client-N (got: ${target})`);
    }
    const clientTarget = this._resolveSingleTarget(target, instance_id);
    const response = await this.client.request(
      '/api/multiplayer-test-leave-client',
      {},
      clientTarget.instanceId,
      clientTarget.role,
    );
    if (response?.error) {
      return { content: [{ type: 'text', text: JSON.stringify(response) }] };
    }
    const wait = await this._waitForRuntimeRoles(
      clientTarget.instanceId,
      { absentRole: clientTarget.role },
      timeout ?? 30,
    );
    const state = await this._buildMultiplayerState(clientTarget.instanceId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ...response,
          left: wait.ok,
          timedOut: wait.timedOut,
          roles: wait.roles,
          state,
        }),
      }],
    };
  }

  async multiplayerTestEnd(value?: unknown, timeout?: number, instance_id?: string) {
    const serverTarget = this._resolveSingleTarget('server', instance_id);
    const response = await this.client.request(
      '/api/multiplayer-test-end',
      { value: value ?? 'ended_by_mcp' },
      serverTarget.instanceId,
      serverTarget.role,
    );
    if (response?.error) {
      return { content: [{ type: 'text', text: JSON.stringify(response) }] };
    }
    const editDone = await this._waitForMultiplayerEditDone(serverTarget.instanceId, timeout ?? 30);
    const wait = await this._waitForRuntimeRoles(
      serverTarget.instanceId,
      { noRuntime: true },
      timeout ?? 30,
    );
    const state = await this._buildMultiplayerState(serverTarget.instanceId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ...response,
          ended: wait.ok,
          editDone,
          timedOut: wait.timedOut,
          roles: wait.roles,
          state,
        }),
      }],
    };
  }

  async getConnectedInstances() {
    const instances = this.bridge.getPublicInstances();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ instances, count: instances.length })
        }
      ]
    };
  }

  async undo(instance_id?: string) {
    const response = await this._callSingle('/api/undo', {}, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async redo(instance_id?: string) {
    const response = await this._callSingle('/api/redo', {}, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }


  private static findProjectRoot(startDir: string): string | null {
    let dir = path.resolve(startDir);
    let previous = '';
    while (dir !== previous) {
      if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, 'package.json'))) {
        return dir;
      }
      previous = dir;
      dir = path.dirname(dir);
    }
    return null;
  }

  private static isDirectory(candidate: string | null | undefined): candidate is string {
    if (!candidate) return false;
    try {
      return fs.statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  }

  private static ensureWritableDirectory(candidate: string, label: string): string {
    const resolved = path.resolve(candidate);
    try {
      fs.mkdirSync(resolved, { recursive: true });
    } catch (error) {
      throw new Error(`Unable to create ${label} build-library directory at ${resolved}: ${(error as Error).message}`);
    }
    if (!RobloxStudioTools.isDirectory(resolved)) {
      throw new Error(`${label} build-library path is not a directory: ${resolved}`);
    }
    try {
      fs.accessSync(resolved, fs.constants.W_OK);
    } catch (error) {
      throw new Error(`${label} build-library directory is not writable: ${resolved}. ${(error as Error).message}`);
    }
    return resolved;
  }

  private static _cachedLibraryPath: string | undefined;

  private static findLibraryPath(): string {
    if (RobloxStudioTools._cachedLibraryPath) return RobloxStudioTools._cachedLibraryPath;

    const overridePath = process.env.ROBLOXSTUDIO_MCP_BUILD_LIBRARY || process.env.BUILD_LIBRARY_PATH;
    const cwd = path.resolve(process.cwd());
    const projectRoot = RobloxStudioTools.findProjectRoot(cwd);
    const homeLibraryPath = path.join(os.homedir(), '.robloxstudio-mcp', 'build-library');
    const projectLibraryPath = projectRoot ? path.join(projectRoot, 'build-library') : null;
    const cwdLibraryPath = path.join(cwd, 'build-library');

    let result: string;

    if (overridePath) {
      result = RobloxStudioTools.ensureWritableDirectory(overridePath, 'override');
    } else {
      const existing = [projectLibraryPath, cwdLibraryPath].find(
        c => c && RobloxStudioTools.isDirectory(c) && (() => { try { fs.accessSync(c, fs.constants.W_OK); return true; } catch { return false; } })()
      );
      if (existing) {
        result = path.resolve(existing);
      } else if (projectLibraryPath) {
        try {
          result = RobloxStudioTools.ensureWritableDirectory(projectLibraryPath, 'project-root');
        } catch (err) {
          console.error(`Warning: could not create build-library at project root (${projectLibraryPath}): ${(err as Error).message}. Falling back to home directory.`);
          result = RobloxStudioTools.ensureWritableDirectory(homeLibraryPath, 'home');
        }
      } else {
        result = RobloxStudioTools.ensureWritableDirectory(homeLibraryPath, 'home');
      }
    }

    RobloxStudioTools._cachedLibraryPath = result;
    return result;
  }

  async exportBuild(instancePath: string, outputId?: string, style: string = 'misc', instance_id?: string) {
    if (!instancePath) {
      throw new Error('Instance path is required for export_build');
    }
    const response = await this._callSingle('/api/export-build', {
      instancePath,
      outputId,
      style
    }, undefined, instance_id) as any;

    // Auto-save to library
    if (response && response.success && response.buildData) {
      const buildData = response.buildData;
      const buildId = buildData.id || `${style}/exported`;
      const filePath = path.join(RobloxStudioTools.findLibraryPath(), `${buildId}.json`);
      const dirPath = path.dirname(filePath);

      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
      fs.writeFileSync(filePath, JSON.stringify(buildData, null, 2));
      response.savedTo = filePath;
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  private normalizePalette(palette: Record<string, unknown>): Record<string, [string, string]> {
    if (!palette || typeof palette !== 'object' || Array.isArray(palette)) {
      throw new Error('palette must be an object mapping keys to [BrickColor, Material] tuples');
    }
    const normalized: Record<string, [string, string]> = {};
    for (const [key, value] of Object.entries(palette)) {
      if (!Array.isArray(value) || value.length < 2) {
        throw new Error(`Palette key "${key}" must map to [BrickColor, Material]`);
      }
      normalized[key] = [String(value[0]), String(value[1])];
    }
    if (Object.keys(normalized).length === 0) {
      throw new Error('palette must contain at least one key');
    }
    return normalized;
  }

  private normalizeBuildParts(parts: unknown, paletteKeys: Set<string>): any[][] {
    if (!Array.isArray(parts) || parts.length === 0) {
      throw new Error('parts must be a non-empty array');
    }

    const ALLOWED_SHAPES = new Set(['Block', 'Wedge', 'Cylinder', 'Ball', 'CornerWedge']);
    const normalized: any[][] = [];

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];

      if (Array.isArray(part)) {
        if (part.length < 10) {
          throw new Error(`Part ${i} must have at least 10 elements`);
        }
        const [px, py, pz, sx, sy, sz, rx, ry, rz, paletteKey, ...rest] = part;
        if (typeof paletteKey !== 'string' || !paletteKeys.has(paletteKey)) {
          throw new Error(`Part ${i} references unknown palette key "${paletteKey}"`);
        }
        const tuple: any[] = [px, py, pz, sx, sy, sz, rx, ry, rz, paletteKey];
        if (rest[0] !== undefined) {
          if (!ALLOWED_SHAPES.has(rest[0])) throw new Error(`Part ${i} has invalid shape "${rest[0]}"`);
          tuple.push(rest[0]);
        }
        if (rest[1] !== undefined) {
          if (!rest[0]) tuple.push('Block');
          tuple.push(rest[1]);
        }
        normalized.push(tuple);
        continue;
      }

      if (!part || typeof part !== 'object') {
        throw new Error(`Part ${i} must be an array or object`);
      }

      const r = part as Record<string, unknown>;
      const position = r.position as number[];
      const size = r.size as number[];
      const rotation = r.rotation as number[];
      const pk = r.paletteKey as string;

      if (!Array.isArray(position) || position.length !== 3) throw new Error(`Part ${i}: position must be [x,y,z]`);
      if (!Array.isArray(size) || size.length !== 3) throw new Error(`Part ${i}: size must be [x,y,z]`);
      if (!Array.isArray(rotation) || rotation.length !== 3) throw new Error(`Part ${i}: rotation must be [x,y,z]`);
      if (typeof pk !== 'string' || !paletteKeys.has(pk)) throw new Error(`Part ${i} references unknown palette key "${pk}"`);

      const tuple: any[] = [...position, ...size, ...rotation, pk];
      if (r.shape !== undefined) {
        if (!ALLOWED_SHAPES.has(r.shape as string)) throw new Error(`Part ${i} has invalid shape "${r.shape}"`);
        tuple.push(r.shape);
      }
      if (r.transparency !== undefined) {
        if (!r.shape) tuple.push('Block');
        tuple.push(r.transparency);
      }
      normalized.push(tuple);
    }

    return normalized;
  }

  async createBuild(
    id: string,
    style: string,
    palette: Record<string, any>,
    parts: unknown,
    bounds?: [number, number, number]
  ) {
    if (!id) {
      throw new Error('id is required for create_build');
    }

    const normalizedPalette = this.normalizePalette(palette);
    const normalizedParts = this.normalizeBuildParts(parts, new Set(Object.keys(normalizedPalette)));

    // Auto-compute bounds if not provided
    const computedBounds = bounds || this.computeBounds(normalizedParts);

    const buildData = { id, style, bounds: computedBounds, palette: normalizedPalette, parts: normalizedParts };

    const filePath = path.join(RobloxStudioTools.findLibraryPath(), `${id}.json`);
    const dirPath = path.dirname(filePath);

    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(buildData, null, 2));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            id,
            style,
            bounds: computedBounds,
            partCount: normalizedParts.length,
            paletteKeys: Object.keys(normalizedPalette),
            savedTo: filePath
          })
        }
      ]
    };
  }

  private computeBounds(parts: any[][]): [number, number, number] {
    let maxX = 0, maxY = 0, maxZ = 0;
    for (const p of parts) {
      const px = Math.abs(p[0]) + p[3] / 2;
      const py = Math.abs(p[1]) + p[4] / 2;
      const pz = Math.abs(p[2]) + p[5] / 2;
      maxX = Math.max(maxX, px);
      maxY = Math.max(maxY, py);
      maxZ = Math.max(maxZ, pz);
    }
    return [
      Math.round(maxX * 2 * 10) / 10,
      Math.round(maxY * 2 * 10) / 10,
      Math.round(maxZ * 2 * 10) / 10
    ];
  }

  async generateBuild(
    id: string,
    style: string,
    palette: Record<string, [string, string]>,
    code: string,
    seed?: number
  ) {
    if (!id || !palette || !code) {
      throw new Error('id, palette, and code are required for generate_build');
    }

    // Validate palette
    for (const [key, value] of Object.entries(palette)) {
      if (!Array.isArray(value) || value.length < 2 || value.length > 3) {
        throw new Error(`Palette key "${key}" must map to [BrickColor, Material] or [BrickColor, Material, MaterialVariant]`);
      }
    }

    // Run the build executor
    const result = runBuildExecutor(code, palette, seed);

    const buildData: Record<string, any> = {
      id,
      style,
      bounds: result.bounds,
      palette,
      parts: result.parts,
      generatorCode: code,
    };
    if (seed !== undefined) buildData.generatorSeed = seed;

    const filePath = path.join(RobloxStudioTools.findLibraryPath(), `${id}.json`);
    const dirPath = path.dirname(filePath);

    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(buildData, null, 2));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            id,
            style,
            bounds: result.bounds,
            partCount: result.partCount,
            paletteKeys: Object.keys(palette),
            savedTo: filePath
          })
        }
      ]
    };
  }

  async importBuild(buildData: Record<string, any> | string, targetPath: string, position?: [number, number, number], instance_id?: string) {
    if (!buildData || !targetPath) {
      throw new Error('buildData (or library ID string) and targetPath are required for import_build');
    }

    // If buildData is a string, treat it as a library ID and load the file
    let resolved: Record<string, any>;
    if (typeof buildData === 'string') {
      const filePath = path.join(RobloxStudioTools.findLibraryPath(), `${buildData}.json`);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Build not found in library: ${buildData}`);
      }
      resolved = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } else if (buildData.id && !buildData.parts) {
      // Object with just an id - try loading from library
      const filePath = path.join(RobloxStudioTools.findLibraryPath(), `${buildData.id}.json`);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Build not found in library: ${buildData.id}`);
      }
      resolved = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } else {
      resolved = buildData;
    }

    const response = await this._callSingle('/api/import-build', {
      buildData: resolved,
      targetPath,
      position
    }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async listLibrary(style?: string) {
    const libraryPath = RobloxStudioTools.findLibraryPath();
    const styles = style ? [style] : ['medieval', 'modern', 'nature', 'scifi', 'misc'];
    const builds: Array<{ id: string; style: string; bounds: number[]; partCount: number }> = [];

    for (const s of styles) {
      const dirPath = path.join(libraryPath, s);
      if (!fs.existsSync(dirPath)) continue;

      const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(dirPath, file), 'utf-8');
          const data = JSON.parse(content);
          builds.push({
            id: data.id || `${s}/${file.replace('.json', '')}`,
            style: data.style || s,
            bounds: data.bounds || [0, 0, 0],
            partCount: Array.isArray(data.parts) ? data.parts.length : 0
          });
        } catch {
          // Skip invalid JSON files
        }
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ builds, total: builds.length })
        }
      ]
    };
  }

  async searchMaterials(query?: string, maxResults?: number, instance_id?: string) {
    const response = await this._callSingle('/api/search-materials', {
      query: query ?? '',
      maxResults: maxResults ?? 50
    }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async getBuild(id: string) {
    if (!id) {
      throw new Error('Build ID is required for get_build');
    }

    const filePath = path.join(RobloxStudioTools.findLibraryPath(), `${id}.json`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Build not found in library: ${id}`);
    }

    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

    // Return metadata + code (but not the full parts array to save tokens)
    const result: Record<string, any> = {
      id: data.id,
      style: data.style,
      bounds: data.bounds,
      partCount: Array.isArray(data.parts) ? data.parts.length : 0,
      paletteKeys: data.palette ? Object.keys(data.palette) : [],
      palette: data.palette,
    };

    if (data.generatorCode) {
      result.generatorCode = data.generatorCode;
      result.generatorSeed = data.generatorSeed;
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result)
        }
      ]
    };
  }

  async importScene(
    sceneData: {
      models?: Record<string, string>;
      place?: Array<
        [string, number[], number[]?]
        | { modelKey: string; position: number[]; rotation?: number[] }
      >;
      custom?: Array<{ n: string; o: number[]; palette: Record<string, [string, string]>; parts: any[][] }>;
    },
    targetPath: string = 'game.Workspace',
    instance_id?: string
  ) {
    if (!sceneData) {
      throw new Error('sceneData is required for import_scene');
    }

    const libraryPath = RobloxStudioTools.findLibraryPath();
    const expandedBuilds: Array<{ buildData: Record<string, any>; position: number[]; rotation: number[]; name: string }> = [];

    // Resolve model references from library
    const modelMap = sceneData.models || {};
    const placements = sceneData.place || [];

    const isVec3Tuple = (value: unknown): value is [number, number, number] => {
      return Array.isArray(value)
        && value.length === 3
        && value.every(component => typeof component === 'number' && Number.isFinite(component));
    };

    for (const [placementIndex, placement] of placements.entries()) {
      let modelKey: string;
      let position: [number, number, number];
      let rotation: [number, number, number] | undefined;
      let validatedKeyPath: string;

      if (Array.isArray(placement)) {
        if (placement.length < 2 || placement.length > 3) {
          throw new Error(
            `Invalid sceneData.place[${placementIndex}]: expected [modelKey, [x,y,z], [rotX?,rotY?,rotZ?]]`
          );
        }
        const [tupleModelKey, tuplePosition, tupleRotation] = placement;
        if (typeof tupleModelKey !== 'string' || tupleModelKey.trim() === '') {
          throw new Error(`Invalid sceneData.place[${placementIndex}][0]: model key must be a non-empty string`);
        }
        modelKey = tupleModelKey.trim();
        validatedKeyPath = `sceneData.place[${placementIndex}][0]`;
        if (!isVec3Tuple(tuplePosition)) {
          throw new Error(`Invalid sceneData.place[${placementIndex}][1]: position must be a numeric [x,y,z] tuple`);
        }
        position = tuplePosition;
        if (tupleRotation !== undefined) {
          if (!isVec3Tuple(tupleRotation)) {
            throw new Error(
              `Invalid sceneData.place[${placementIndex}][2]: rotation must be a numeric [x,y,z] tuple when provided`
            );
          }
          rotation = tupleRotation;
        }
      } else if (placement && typeof placement === 'object') {
        const placementRecord = placement as Record<string, unknown>;
        const objectModelKey = placementRecord.modelKey;
        const objectPosition = placementRecord.position;
        const objectRotation = placementRecord.rotation;
        if (typeof objectModelKey !== 'string' || objectModelKey.trim() === '') {
          throw new Error(`Invalid sceneData.place[${placementIndex}].modelKey: model key must be a non-empty string`);
        }
        if (!isVec3Tuple(objectPosition)) {
          throw new Error(`Invalid sceneData.place[${placementIndex}].position: must be a numeric [x,y,z] tuple`);
        }
        if (objectRotation !== undefined && !isVec3Tuple(objectRotation)) {
          throw new Error(
            `Invalid sceneData.place[${placementIndex}].rotation: must be a numeric [x,y,z] tuple when provided`
          );
        }
        modelKey = objectModelKey.trim();
        validatedKeyPath = `sceneData.place[${placementIndex}].modelKey`;
        position = objectPosition;
        rotation = objectRotation as [number, number, number] | undefined;
      } else {
        throw new Error(
          `Invalid sceneData.place[${placementIndex}]: expected an object placement or [modelKey, [x,y,z], [rotX?,rotY?,rotZ?]] tuple`
        );
      }

      const buildId = modelMap[modelKey];
      if (!buildId) {
        throw new Error(
          `Invalid ${validatedKeyPath}: model key "${modelKey}" is not defined in sceneData.models`
        );
      }

      // Load build data from library
      const filePath = path.join(libraryPath, `${buildId}.json`);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Build not found in library: ${buildId}`);
      }

      const content = fs.readFileSync(filePath, 'utf-8');
      const buildData = JSON.parse(content);
      const buildName = buildId.split('/').pop() || buildId;

      expandedBuilds.push({
        buildData,
        position,
        rotation: rotation || [0, 0, 0],
        name: buildName
      });
    }

    // Add custom inline builds
    const customs = sceneData.custom || [];
    for (const custom of customs) {
      expandedBuilds.push({
        buildData: {
          palette: custom.palette,
          parts: custom.parts
        },
        position: custom.o || [0, 0, 0],
        rotation: [0, 0, 0],
        name: custom.n || 'Custom'
      });
    }

    if (expandedBuilds.length === 0) {
      throw new Error('No builds to import - check model references and library');
    }

    // Send expanded builds to plugin
    const response = await this._callSingle('/api/import-scene', {
      expandedBuilds,
      targetPath
    }, undefined, instance_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }


  // === Asset Tools ===

  async searchAssets(
    assetType: string,
    query?: string,
    maxResults?: number,
    sortBy?: string,
    verifiedCreatorsOnly?: boolean
  ) {
    if (!this.openCloudClient.hasApiKey()) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: 'ROBLOX_OPEN_CLOUD_API_KEY environment variable is not set. Set it to use Creator Store asset tools.' })
        }]
      };
    }

    const response = await this.openCloudClient.searchAssets({
      searchCategoryType: assetType as any,
      query,
      maxPageSize: maxResults,
      sortCategory: sortBy as any,
      includeOnlyVerifiedCreators: verifiedCreatorsOnly,
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response)
      }]
    };
  }

  async getAssetDetails(assetId: number) {
    if (!assetId) {
      throw new Error('Asset ID is required for get_asset_details');
    }

    if (this.cookieClient.hasCookie() && !this.openCloudClient.hasApiKey()) {
      const results = await this.cookieClient.getAssetDetails([assetId]);
      const asset = results[0];
      if (!asset) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Asset not found or not owned by authenticated user' }) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(asset) }] };
    }

    if (!this.openCloudClient.hasApiKey()) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: 'No auth configured. Set ROBLOSECURITY or ROBLOX_OPEN_CLOUD_API_KEY env var.' })
        }]
      };
    }

    const response = await this.openCloudClient.getAssetDetails(assetId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response)
      }]
    };
  }

  async getAssetThumbnail(assetId: number, size?: string) {
    if (!assetId) {
      throw new Error('Asset ID is required for get_asset_thumbnail');
    }
    if (!this.openCloudClient.hasApiKey()) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: 'ROBLOX_OPEN_CLOUD_API_KEY environment variable is not set. Set it to use Creator Store asset tools.' })
        }]
      };
    }

    const result = await this.openCloudClient.getAssetThumbnail(assetId, size as any);
    if (!result) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: 'Thumbnail not available for this asset' })
        }]
      };
    }

    return {
      content: [{
        type: 'image',
        data: result.base64,
        mimeType: result.mimeType,
      }]
    };
  }

  async insertAsset(assetId: number, parentPath?: string, position?: { x: number; y: number; z: number }, instance_id?: string) {
    if (!assetId) {
      throw new Error('Asset ID is required for insert_asset');
    }
    const response = await this._callSingle('/api/insert-asset', {
      assetId,
      parentPath: parentPath || 'game.Workspace',
      position
    }, undefined, instance_id);
    const outcome = interpretInsertResponse(response);
    if (!outcome.ok) {
      const hint = outcome.code === 'AUTH'
        ? 'This asset is copy-locked: InsertService can only load assets you own or that are public + copy-enabled. Pick a free/owned asset (e.g. via marketplace_search, which ranks insertable candidates) and try another id.'
        : outcome.code === 'NOT_FOUND'
          ? `Parent path "${parentPath || 'game.Workspace'}" did not resolve. Verify it with get_instance_children before inserting.`
          : undefined;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ ...typedError(outcome.message ?? 'Insert failed', outcome.code), inserted: false, hint, response }),
        }],
      };
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response)
      }]
    };
  }

  async previewAsset(assetId: number, includeProperties?: boolean, maxDepth?: number, instance_id?: string) {
    if (!assetId) {
      throw new Error('Asset ID is required for preview_asset');
    }
    const response = await this._callSingle('/api/preview-asset', {
      assetId,
      includeProperties: includeProperties ?? true,
      maxDepth: maxDepth ?? 10
    }, undefined, instance_id);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response)
      }]
    };
  }

  // === Free marketplace (no Open Cloud key) ===
  // Search Roblox's public toolbox for insertable assets, then insert with
  // insert_asset (InsertService — also key-free). Pairs the discovery gap that
  // search_assets (Creator Store) leaves for users without an API key.

  async marketplaceSearch(keyword: string, category?: string, limit?: number, sortType?: string) {
    if (!keyword || !keyword.trim()) {
      throw new Error('keyword is required for marketplace_search');
    }
    try {
      const results = await this.marketplace.search({ keyword, category, limit, sortType });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            keyword,
            category: category ?? 'Model',
            count: results.length,
            results,
            hint: results.length > 0 ? 'Insert one with insert_asset (assetId) or marketplace_search_and_insert.' : 'No results — try a different keyword or category.',
          }),
        }] as ToolContent[],
      };
    } catch (error) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: errorMessage(error) }) }] as ToolContent[] };
    }
  }

  async marketplaceSearchAndInsert(
    keyword: string,
    category?: string,
    parentPath?: string,
    position?: { x: number; y: number; z: number },
    instance_id?: string,
  ) {
    if (!keyword || !keyword.trim()) {
      throw new Error('keyword is required for marketplace_search_and_insert');
    }
    let results;
    try {
      results = await this.marketplace.search({ keyword, category, limit: 5 });
    } catch (error) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: errorMessage(error) }) }] as ToolContent[] };
    }
    if (results.length === 0) {
      return { content: [{ type: 'text', text: JSON.stringify({ inserted: false, reason: `No marketplace results for "${keyword}".` }) }] as ToolContent[] };
    }
    // Results are already ranked best-fit-first. Many toolbox models are
    // copy-locked (InsertService AUTH); walk the candidates and insert the first
    // that actually loads, rather than failing on a single locked hit.
    const attempts: Array<{ id: number; name: string; code?: string }> = [];
    for (const chosen of results) {
      const response = await this._callSingle('/api/insert-asset', {
        assetId: chosen.id,
        parentPath: parentPath || 'game.Workspace',
        position,
      }, undefined, instance_id);
      const outcome = interpretInsertResponse(response);
      if (outcome.ok) {
        this.safety.recordOperation({ kind: 'marketplace_insert', summary: `inserted "${chosen.name}" (${chosen.id})` });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              inserted: true,
              asset: chosen,
              triedBeforeSuccess: attempts,
              alternatives: results.filter((r) => r.id !== chosen.id),
              response,
            }),
          }] as ToolContent[],
        };
      }
      attempts.push({ id: chosen.id, name: chosen.name, code: outcome.code });
      // Stop early on non-asset problems (e.g. bad parent) — retrying other ids won't help.
      if (outcome.code === 'NOT_FOUND') break;
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          inserted: false,
          reason: `None of the ${attempts.length} ranked candidate(s) for "${keyword}" could be inserted (mostly copy-locked / auth-blocked).`,
          tried: attempts,
          candidates: results,
          hint: 'Toolbox models are often copy-locked. Try a different keyword, or pick a result you own / that is public+copy-enabled.',
        }),
      }] as ToolContent[],
    };
  }

  // === Media tools (audio / animation / texture) ===

  async audioCreateSound(options: CreateSoundOptions, instance_id?: string) {
    if (!options?.parentPath || options?.soundId === undefined) throw new Error('parentPath and soundId are required for audio_create_sound');
    const result = await this._runGeneratedLuau(buildCreateSoundLuau(options), instance_id);
    this.safety.recordOperation({ kind: 'audio', summary: `sound ${options.soundId} under ${options.parentPath}` });
    return result;
  }

  async audioPlaySound(path: string, instance_id?: string) {
    if (!path) throw new Error('path is required for audio_play_sound');
    return this._runGeneratedLuau(buildPlaySoundLuau({ path }), instance_id);
  }

  async animationCreate(options: CreateAnimationOptions, instance_id?: string) {
    if (!options?.parentPath || options?.animationId === undefined) throw new Error('parentPath and animationId are required for animation_create');
    const result = await this._runGeneratedLuau(buildCreateAnimationLuau(options), instance_id);
    this.safety.recordOperation({ kind: 'animation', summary: `animation ${options.animationId} under ${options.parentPath}` });
    return result;
  }

  async animationPlay(options: PlayAnimationOptions, instance_id?: string) {
    if (!options?.rigPath || options?.animationId === undefined) throw new Error('rigPath and animationId are required for animation_play');
    return this._runGeneratedLuau(buildPlayAnimationLuau(options), instance_id);
  }

  async assetApplyTexture(options: ApplyTextureOptions, instance_id?: string) {
    if (!options?.targetPath || options?.assetId === undefined) throw new Error('targetPath and assetId are required for asset_apply_texture');
    const result = await this._runGeneratedLuau(buildApplyTextureLuau(options), instance_id);
    this.safety.recordOperation({ kind: 'texture', summary: `applied ${options.assetId} to ${options.targetPath}` });
    return result;
  }

  // === AI image generation (Pollinations) ===
  // Generates an image from a text prompt and saves it locally. To use it in
  // Roblox: upload it (image_generate_and_upload or upload_asset) to get an
  // asset id, then asset_apply_texture it. Requires POLLINATIONS_API_KEY.

  private async _generateImageToFile(prompt: string, options?: ImageGenOptions): Promise<{ file: string; bytes: number; model: string }> {
    const { buffer, contentType } = await this.imageClient.generate(prompt, options ?? {});
    const ext = contentType.includes('png') ? 'png' : 'jpg';
    const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'image';
    const dir = path.resolve(process.env.ROBLOX_IMAGE_DIR ?? path.join(process.cwd(), 'generated-images'));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${slug}-${Date.now()}.${ext}`);
    fs.writeFileSync(file, buffer);
    return { file, bytes: buffer.length, model: options?.model ?? DEFAULT_IMAGE_MODEL };
  }

  async imageGenerate(prompt: string, options?: ImageGenOptions) {
    if (!prompt || !prompt.trim()) throw new Error('prompt is required for image_generate');
    if (!this.imageClient.hasApiKey()) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'POLLINATIONS_API_KEY is not set. Get a server-side sk_ key from https://enter.pollinations.ai and pass it via env or --pollinations-key.' }) }] as ToolContent[] };
    }
    try {
      const saved = await this._generateImageToFile(prompt, options);
      this.safety.recordOperation({ kind: 'image_generate', summary: `generated "${prompt}" → ${saved.file}` });
      return { content: [{ type: 'text', text: JSON.stringify({ prompt, ...saved, next: 'Upload with image_generate_and_upload or upload_asset, then asset_apply_texture.' }) }] as ToolContent[] };
    } catch (error) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: errorMessage(error) }) }] as ToolContent[] };
    }
  }

  async imageGenerateAndUpload(prompt: string, options?: ImageGenOptions, assetType?: string, displayName?: string) {
    if (!prompt || !prompt.trim()) throw new Error('prompt is required for image_generate_and_upload');
    if (!this.imageClient.hasApiKey()) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'POLLINATIONS_API_KEY is not set. Get a server-side sk_ key from https://enter.pollinations.ai.' }) }] as ToolContent[] };
    }
    let saved;
    try {
      saved = await this._generateImageToFile(prompt, options);
    } catch (error) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: errorMessage(error) }) }] as ToolContent[] };
    }
    // Reuse the existing Roblox upload path (Open Cloud / cookie auth). It
    // returns a structured result with the new assetId once moderation clears.
    try {
      const upload = await this.uploadAsset(saved.file, assetType ?? 'Decal', displayName ?? prompt.slice(0, 50));
      this.safety.recordOperation({ kind: 'image_generate', summary: `generated + uploaded "${prompt}"` });
      const uploadText = (upload.content.find((c) => c.type === 'text') as { text?: string } | undefined)?.text ?? '{}';
      return { content: [{ type: 'text', text: JSON.stringify({ generated: saved, upload: JSON.parse(uploadText), next: 'Apply the returned assetId with asset_apply_texture.' }) }] as ToolContent[] };
    } catch (error) {
      return { content: [{ type: 'text', text: JSON.stringify({ generated: saved, uploadError: errorMessage(error), hint: 'Image saved locally; set ROBLOX_OPEN_CLOUD_API_KEY (asset:write) or ROBLOSECURITY to upload, or upload the file manually in Studio.' }) }] as ToolContent[] };
    }
  }

  // === Diagnostics ("fix all script errors") ===

  async diagnoseScripts(maxEntries?: number, instance_id?: string) {
    const response = await this._callSingle('/api/get-output-log', { maxEntries: maxEntries ?? 200 }, undefined, instance_id);
    const entries = Array.isArray(response?.entries) ? response.entries : [];
    const result = parseLogErrors(entries);
    return {
      content: [{
        type: 'text',
        text: `${formatDiagnostics(result)}\n\n${JSON.stringify({ errors: result.errors, warnings: result.warnings })}`,
      }] as ToolContent[],
    };
  }

  // Decal asset IDs are the wrapper asset; ImageLabel.Image needs the underlying image
  // content ID. The only reliable cross-auth way to resolve this is InsertService:LoadAsset
  // via the connected Studio plugin - the unauthenticated economy endpoint returns 401.
  private async resolveImageId(decalAssetId: string): Promise<string | null> {
    const code = `
      local InsertService = game:GetService("InsertService")
      local ok, result = pcall(function() return InsertService:LoadAsset(${decalAssetId}) end)
      if not ok then return nil end
      local decal = result:FindFirstChildWhichIsA("Decal", true)
      local id = decal and decal.Texture:match("(%d+)") or nil
      result:Destroy()
      return id
    `;
    try {
      const response = await this._callSingle('/api/execute-luau', { code }, 'edit', undefined) as { returnValue?: unknown };
      const returnValue = response?.returnValue;
      if (returnValue !== undefined && returnValue !== null && /^\d+$/.test(String(returnValue))) {
        return String(returnValue);
      }
    } catch {
      // plugin not connected or luau execution failed
    }
    return null;
  }

  async uploadAsset(
    filePath: string,
    assetType: string,
    displayName: string,
    description?: string,
    userId?: string,
    groupId?: string
  ) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const fileContent = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);

    if (assetType === 'Decal' && this.cookieClient.hasCookie()) {
      const result = await this.cookieClient.uploadDecal(fileContent, displayName, description || '');
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            done: true,
            response: {
              assetId: String(result.assetId),
              displayName,
              assetType,
              decalId: String(result.assetId),
              imageId: String(result.backingAssetId),
            },
          })
        }]
      };
    }

    if (!this.openCloudClient.hasApiKey()) {
      const cookieHint = assetType === 'Decal'
        ? ' Alternatively, set ROBLOSECURITY to use cookie auth.'
        : '';
      throw new Error(
        `No auth configured for ${assetType} upload. Set ROBLOX_OPEN_CLOUD_API_KEY (needs asset:write scope).${cookieHint}`
      );
    }

    const resolvedGroupId = groupId || process.env.ROBLOX_CREATOR_GROUP_ID;
    const resolvedUserId = userId || process.env.ROBLOX_CREATOR_USER_ID;

    if (!resolvedUserId && !resolvedGroupId) {
      throw new Error(
        'Creator identity required for Open Cloud upload. Set ROBLOX_CREATOR_USER_ID or ROBLOX_CREATOR_GROUP_ID, or pass userId/groupId as parameters.'
      );
    }

    const creator: { userId?: string; groupId?: string } = {};
    if (resolvedGroupId) {
      creator.groupId = resolvedGroupId;
    } else {
      creator.userId = resolvedUserId;
    }

    const result = await this.openCloudClient.createAsset(
      {
        assetType: assetType as 'Audio' | 'Decal' | 'Model' | 'Animation' | 'Video',
        displayName,
        description: description || '',
        creationContext: { creator },
      },
      fileContent,
      fileName
    );

    // Decals: also resolve the underlying image content ID for ImageLabel.Image usage.
    if (assetType === 'Decal') {
      const decalId = result.response?.assetId;
      const imageId = decalId ? await this.resolveImageId(decalId) : null;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            ...result,
            decalId: decalId ?? null,
            imageId,
          })
        }]
      };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result)
      }]
    };
  }

  async simulateMouseInput(action: string, x: number, y: number, button?: string, scrollDirection?: string, target?: string, instance_id?: string) {
    if (!action) {
      throw new Error('action is required for simulate_mouse_input');
    }
    // Default to the running playtest client (where the input pipeline lives)
    // when the caller didn't pick a target; fall back to edit otherwise.
    const { instanceId, clientRole } = this._resolveRuntime(instance_id);
    const response = await this._callSingle('/api/simulate-mouse-input', {
      action, x, y, button
    }, target || clientRole || 'edit', instanceId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response)
      }]
    };
  }

  async simulateKeyboardInput(keyCode?: string, action?: string, duration?: number, text?: string, target?: string, instance_id?: string) {
    if (!keyCode && text === undefined) {
      throw new Error('keyCode or text is required for simulate_keyboard_input');
    }
    const { instanceId, clientRole } = this._resolveRuntime(instance_id);
    const response = await this._callSingle('/api/simulate-keyboard-input', {
      keyCode, action, duration, text
    }, target || clientRole || 'edit', instanceId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response)
      }]
    };
  }

  async characterNavigation(position?: number[], instancePath?: string, waitForCompletion?: boolean, timeout?: number, target?: string, instance_id?: string) {
    if (!position && !instancePath) {
      throw new Error('Either position or instancePath is required for character_navigation');
    }
    const response = await this._callSingle('/api/character-navigation', {
      position, instancePath, waitForCompletion, timeout
    }, target || 'edit', instance_id);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response)
      }]
    };
  }

  async cloneObject(instancePath: string, targetParentPath: string, instance_id?: string) {
    if (!instancePath || !targetParentPath) {
      throw new Error('instancePath and targetParentPath are required for clone_object');
    }
    const response = await this._callSingle('/api/clone-object', { instancePath, targetParentPath }, undefined, instance_id);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }

  async getDescendants(instancePath: string, maxDepth?: number, classFilter?: string, instance_id?: string) {
    if (!instancePath) {
      throw new Error('instancePath is required for get_descendants');
    }
    const response = await this._callSingle('/api/get-descendants', { instancePath, maxDepth, classFilter }, undefined, instance_id);
    return compactText(response);
  }

  async compareInstances(instancePathA: string, instancePathB: string, instance_id?: string) {
    if (!instancePathA || !instancePathB) {
      throw new Error('instancePathA and instancePathB are required for compare_instances');
    }
    const response = await this._callSingle('/api/compare-instances', { instancePathA, instancePathB }, undefined, instance_id);
    return compactText(response);
  }

  async getOutputLog(maxEntries?: number, messageType?: string, instance_id?: string) {
    const response = await this._callSingle('/api/get-output-log', { maxEntries, messageType }, undefined, instance_id);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }

  async bulkSetAttributes(instancePath: string, attributes: Record<string, unknown>, instance_id?: string) {
    if (!instancePath || !attributes) {
      throw new Error('instancePath and attributes are required for bulk_set_attributes');
    }
    const response = await this._callSingle('/api/bulk-set-attributes', { instancePath, attributes }, undefined, instance_id);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }

  async findAndReplaceInScripts(
    pattern: string,
    replacement: string,
    options?: {
      caseSensitive?: boolean;
      usePattern?: boolean;
      path?: string;
      classFilter?: string;
      dryRun?: boolean;
      maxReplacements?: number;
    },
    instance_id?: string
  ) {
    if (!pattern) {
      throw new Error('pattern is required for find_and_replace_in_scripts');
    }
    if (replacement === undefined || replacement === null) {
      throw new Error('replacement is required for find_and_replace_in_scripts');
    }
    const response = await this._callSingle('/api/find-and-replace-in-scripts', {
      pattern,
      replacement,
      ...options
    }, undefined, instance_id);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response)
      }]
    };
  }

  async getMemoryBreakdown(target?: string, tags?: string[], instance_id?: string) {
    const tgt = target ?? 'all';
    const data: Record<string, unknown> = {};
    if (tags !== undefined) data.tags = tags;

    const resolved = this.bridge.resolveTarget({ instance_id, target: tgt });
    if (!resolved.ok) throw new RoutingFailure(resolved.error);

    if (resolved.mode === 'single') {
      const response = await this.client.request(
        '/api/get-memory-breakdown',
        data,
        resolved.targetInstanceId,
        resolved.targetRole,
      );
      return compactText(response);
    }

    const targets = resolved.targets.filter((t) => t.targetRole !== 'edit-proxy');

    const responses = await Promise.allSettled(
      targets.map(async (t) => ({
        peer: t.targetRole,
        result: await this.client.request(
          '/api/get-memory-breakdown',
          data,
          t.targetInstanceId,
          t.targetRole,
        ),
      })),
    );

    const body: Record<string, unknown> = {};
    for (let i = 0; i < responses.length; i++) {
      const r = responses[i];
      const peer = targets[i].targetRole;
      if (r.status === 'fulfilled') {
        body[peer] = r.value.result;
      } else {
        body[peer] = { error: 'disconnected' };
      }
    }

    return compactText(body);
  }

  async getSceneAnalysis(mode?: string, target?: string, topN?: number, raw?: boolean, instance_id?: string) {
    const tgt = target ?? 'all';
    const data: Record<string, unknown> = {};
    if (mode !== undefined) data.mode = mode;
    if (topN !== undefined) data.topN = topN;
    if (raw !== undefined) data.raw = raw;

    const resolved = this.bridge.resolveTarget({ instance_id, target: tgt });
    if (!resolved.ok) throw new RoutingFailure(resolved.error);

    if (resolved.mode === 'single') {
      const response = await this.client.request(
        '/api/get-scene-analysis',
        data,
        resolved.targetInstanceId,
        resolved.targetRole,
      );
      return compactText(response);
    }

    const targets = resolved.targets.filter((t) => t.targetRole !== 'edit-proxy');

    const responses = await Promise.allSettled(
      targets.map(async (t) => ({
        peer: t.targetRole,
        result: await this.client.request(
          '/api/get-scene-analysis',
          data,
          t.targetInstanceId,
          t.targetRole,
        ),
      })),
    );

    const body: Record<string, unknown> = {};
    for (let i = 0; i < responses.length; i++) {
      const r = responses[i];
      const peer = targets[i].targetRole;
      if (r.status === 'fulfilled') {
        body[peer] = r.value.result;
      } else {
        body[peer] = { error: 'disconnected' };
      }
    }

    return compactText(body);
  }

  async exportRbxm(instancePaths: string[], outputPath: string, target?: string, instance_id?: string) {
    if (!Array.isArray(instancePaths) || instancePaths.length === 0) {
      throw new Error('instance_paths must be a non-empty array for export_rbxm');
    }
    if (!outputPath || typeof outputPath !== 'string') {
      throw new Error('output_path is required for export_rbxm');
    }
    const tgt = target || 'edit';
    if (tgt !== 'edit' && tgt !== 'server') {
      throw new Error(`export_rbxm target must be "edit" or "server" (got: ${tgt})`);
    }

    const response = await this._callSingle(
      '/api/export-rbxm',
      { instance_paths: instancePaths },
      tgt,
      instance_id,
    ) as { error?: string; base64?: string; instance_count?: number };

    if (response.error) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: response.error }) }] };
    }
    if (!response.base64) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'plugin returned no base64 payload' }) }] };
    }

    const bytes = Buffer.from(response.base64, 'base64');
    const resolved = path.resolve(outputPath);
    try {
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, bytes);
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `failed to write ${resolved}: ${(err as Error).message}` }) }] };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          bytes_written: bytes.length,
          instance_count: response.instance_count ?? instancePaths.length,
          output_path: resolved,
        }),
      }],
    };
  }

  async importRbxm(
    source: { path?: string; url?: string; base64?: string } | undefined,
    parentPath: string,
    target?: string,
    instance_id?: string
  ) {
    if (!source || typeof source !== 'object') {
      throw new Error('source is required for import_rbxm');
    }
    if (!parentPath || typeof parentPath !== 'string') {
      throw new Error('parent_path is required for import_rbxm');
    }
    const tgt = target || 'edit';
    if (tgt !== 'edit' && tgt !== 'server') {
      throw new Error(`import_rbxm target must be "edit" or "server" (got: ${tgt})`);
    }

    const modes = ['path', 'url', 'base64'].filter((k) => (source as Record<string, unknown>)[k] !== undefined);
    if (modes.length !== 1) {
      throw new Error(`source must contain exactly one of { path, url, base64 } (got: ${modes.join(', ') || 'none'})`);
    }

    let bytes: Buffer;
    let sourceLabel: string;
    if (source.path !== undefined) {
      const resolved = path.resolve(source.path);
      try {
        bytes = fs.readFileSync(resolved);
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `failed to read ${resolved}: ${(err as Error).message}` }) }] };
      }
      sourceLabel = resolved;
    } else if (source.url !== undefined) {
      // SSRF guard: only http(s). Blocks file://, ftp://, gopher://, etc.
      // Does NOT block requests to internal IPs (127.0.0.1, 169.254.x, RFC1918) —
      // a local MCP server has legitimate reasons to hit localhost, so internal-IP
      // blocking should be opt-in if needed.
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(source.url);
      } catch {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `import_rbxm url is not a valid URL: ${source.url}` }) }] };
      }
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `import_rbxm url must use http(s); got ${parsedUrl.protocol}` }) }] };
      }

      // 50 MiB matches the project's existing express.json('50mb') cap and is
      // empirically well within the Studio plugin's HttpService:RequestAsync
      // response ceiling (probed up to 100 MiB without issue, 150+ stalls on
      // Studio memory, not protocol). Far above any realistic rbxm size.
      const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
      try {
        const res = await fetch(source.url);
        if (!res.ok) {
          const snippet = (await res.text()).slice(0, 500);
          return { content: [{ type: 'text', text: JSON.stringify({ error: `fetch ${source.url} returned ${res.status}: ${snippet}` }) }] };
        }
        const claimed = Number(res.headers.get('content-length') ?? '0');
        if (claimed > MAX_IMPORT_BYTES) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: `fetch ${source.url}: content-length ${claimed} exceeds ${MAX_IMPORT_BYTES} byte cap` }) }] };
        }
        const arr = await res.arrayBuffer();
        if (arr.byteLength > MAX_IMPORT_BYTES) {
          return { content: [{ type: 'text', text: JSON.stringify({ error: `fetch ${source.url}: downloaded ${arr.byteLength} bytes exceeds ${MAX_IMPORT_BYTES} byte cap` }) }] };
        }
        bytes = Buffer.from(arr);
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `fetch ${source.url} failed: ${(err as Error).message}` }) }] };
      }
      sourceLabel = source.url;
    } else {
      try {
        bytes = Buffer.from(source.base64 as string, 'base64');
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `base64 decode failed: ${(err as Error).message}` }) }] };
      }
      sourceLabel = `base64(${bytes.length}B)`;
    }

    const response = await this._callSingle(
      '/api/import-rbxm',
      {
        base64: bytes.toString('base64'),
        parent_path: parentPath,
        source_label: sourceLabel,
      },
      tgt,
      instance_id,
    );

    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  }

  private async _captureViewportImage(
    instanceId: string,
    targetRole: string,
    format?: string,
    quality?: number,
  ): Promise<EncodedViewportCapture> {
    let response: RawImageCaptureResponse;
    if (targetRole.startsWith('client-')) {
      // Play mode. The running game VM can trigger CaptureScreenshot but can't
      // read the resulting temp texture back (privilege gate). So capture on
      // the client to get the rbxtemp:// id, then read it back in the edit DM —
      // the rbxtemp handle is process-scoped and the edit/plugin identity is
      // allowed to promote it into a readable EditableImage.
      const begin = await this._callSingle('/api/capture-begin', {}, targetRole, instanceId) as { contentId?: string; error?: string };
      if (begin.error) {
        return { success: false, error: begin.error };
      }
      if (!begin.contentId) {
        return { success: false, error: 'Screenshot capture failed: no content id returned from client.' };
      }
      response = await this._callSingle('/api/capture-read', { contentId: begin.contentId }, 'edit', instanceId) as RawImageCaptureResponse;
    } else {
      // Edit mode: capture and read back in the same (edit) context.
      response = await this._callSingle('/api/capture-screenshot', {}, 'edit', instanceId) as RawImageCaptureResponse;
    }

    if (response.error) {
      let text = response.error;
      if (
        targetRole.startsWith('client-') &&
        response.error.includes('Failed to load texture, unexpected format') &&
        await this._isMultiplayerTestRunning(instanceId)
      ) {
        text =
          'Screenshot capture reached the multiplayer client, but Roblox returned a temporary screenshot texture ' +
          'that the edit peer cannot read in StudioTestService multiplayer sessions. Regular start_playtest capture ' +
          'works because the temporary rbxtemp:// handle is readable from the edit process; multiplayer client handles ' +
          `appear to be scoped to the client process. Raw error: ${response.error}`;
      }
      return { success: false, error: text };
    }

    const w = response.width;
    const h = response.height;
    if (w === undefined || h === undefined) {
      return { success: false, error: 'Screenshot response missing dimensions.' };
    }

    const fmt: 'jpeg' | 'png' = format === 'png' ? 'png' : 'jpeg';
    const q = quality === undefined ? 92 : Math.max(1, Math.min(100, Math.floor(quality)));

    // Cap the inline image size. Measured empirically: an ~8MB image (11MB
    // base64) returns fine, but ~16MB (22MB base64) CLOSES the MCP connection
    // and drops every Studio registration — a catastrophic failure, not a
    // graceful error. 6MB is in the proven-safe range with comfortable margin.
    // For PNG we refuse (rather than silently dropping the lossless guarantee
    // the caller asked for); for JPEG we step quality down so the call still
    // succeeds.
    const encoded = encodeImageFromRgbaResponse(response, fmt, q);
    let { buffer } = encoded;
    const { mimeType } = encoded;
    let usedQ = q;
    let note = '';

    if (buffer.length > MAX_INLINE_IMAGE_BYTES) {
      if (fmt === 'png') {
        const mb = (buffer.length / 1048576).toFixed(1);
        return {
          success: false,
          error:
            `PNG screenshot is ${mb}MB, over the ~${(MAX_INLINE_IMAGE_BYTES / 1048576).toFixed(0)}MB inline image limit. ` +
            `Use the default jpeg format (optionally with a "quality" value) or make the Studio window smaller for a lossless capture.`,
        };
      }
      while (buffer.length > MAX_INLINE_IMAGE_BYTES && usedQ > 25) {
        usedQ = Math.max(25, usedQ - 20);
        buffer = encodeImageFromRgbaResponse(response, 'jpeg', usedQ).buffer;
      }
      note = ` — auto-reduced to q${usedQ} to fit the inline size limit; enlarge the Studio window or capture a smaller region for finer detail`;
    }

    // Explicit coordinate contract: the image is returned at native viewport
    // resolution and is never downscaled, so its pixel grid IS the coordinate
    // space simulate_mouse_input expects. Stating the dimensions removes any
    // ambiguity about what (x, y) mean.

    const message =
      `Screenshot ${w}x${h}px (${fmt}${fmt === 'jpeg' ? ` q${usedQ}` : ''})${note}. ` +
      `For simulate_mouse_input, x/y are pixel coordinates in this exact image with (0,0) at the ` +
      `top-left; it is not downscaled, so use coordinates as you read them off the image.`;

    return {
      success: true,
      width: w,
      height: h,
      format: fmt,
      quality: fmt === 'jpeg' ? usedQ : undefined,
      note,
      data: buffer.toString('base64'),
      mimeType,
      message,
    };
  }

  async captureScreenshot(instance_id?: string, format?: string, quality?: number) {
    const { instanceId, clientRole } = this._resolveRuntime(instance_id);
    const capture = await this._captureViewportImage(instanceId, clientRole ?? 'edit', format, quality);
    if (!capture.success) {
      return { content: [{ type: 'text', text: capture.error }] };
    }

    return {
      content: [
        {
          type: 'text',
          text: capture.message,
        },
        {
          type: 'image',
          data: capture.data,
          mimeType: capture.mimeType,
        },
      ],
    };
  }
}
