import { rgbaToJpeg } from '../jpeg-encoder.js';
import { rgbaToPng } from '../png-encoder.js';

export type RawImageCaptureResponse = {
  success?: boolean;
  error?: string;
  width?: number;
  height?: number;
  data?: string;
  instancePath?: string;
  instanceName?: string;
  cameraPreset?: string;
};

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export type EncodedViewportCapture = {
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

export type DeviceSimulatorSettings = {
  deviceId?: string;
  orientation?: string;
  resolution?: { width: number; height: number };
  pixelDensity?: number;
  scalingMode?: string;
};

export type DeviceSimulatorMatrixEntry = DeviceSimulatorSettings & {
  label?: string;
};

export type SimulationInclude = 'network' | 'deviceSimulator' | 'both';

// Per-call safety controls threaded into destructive/bulk tools. Both are
// optional and additive: omitting them preserves the original behavior for any
// non-gated operation, while gated ones (protected deletes, large bulk changes,
// dangerous Luau) stay blocked until `confirm: true` is supplied.
export type SafetyOptions = {
  /** Preview the operation without mutating anything. */
  dryRun?: boolean;
  /** Explicitly approve an operation the safety layer would otherwise gate. */
  confirm?: boolean;
};

export const MAX_INLINE_IMAGE_BYTES = 6_000_000;
export const MAX_DEVICE_MATRIX_ENTRIES = 6;
export const MAX_NETWORK_PACKET_LOSS_PERCENT = 0.5;

// Encodes the raw RGBA capture into the requested image format.
// - 'png': lossless — sharpest text/UI, but a busy 3D scene can be large.
// - 'jpeg': default; quality 92 with 4:4:4 chroma (no subsampling) keeps text
//   crisp at ~1/3 the size. The image rides back inline as an MCP tool result,
//   so JPEG is the safe default for staying under client result-size caps.
export function encodeImageFromRgbaResponse(
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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const NETWORK_PROFILE_KEYS = [
  'InboundNetworkMinDelayMs',
  'OutboundNetworkMinDelayMs',
  'InboundNetworkJitterMs',
  'OutboundNetworkJitterMs',
  'InboundNetworkLossPercent',
  'OutboundNetworkLossPercent',
] as const;

export type NetworkProfileKey = typeof NETWORK_PROFILE_KEYS[number];
export type NetworkProfileValues = Partial<Record<NetworkProfileKey, number>>;

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

export const SIMULATION_PERSISTENCE_NOTES = [
  'Normal Play client changes can write back to edit state.',
  'Multiplayer clients inherit baseline at startup but are isolated afterward.',
  'StudioTestService client device simulator state may appear stale on fresh clients, so reset after client startup is required.',
];

export function normalizeNetworkProfile(profile: string, overrides?: Record<string, unknown>): NetworkProfileValues {
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

export function buildNetworkProfileLuau(profile: string, values: NetworkProfileValues): string {
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

export function buildNetworkStateLuau(operation: 'get' | 'reset'): string {
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

export function normalizeDeviceSimulatorResolution(value: unknown): { width: number; height: number } | undefined {
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

export function normalizeDeviceSimulatorSettings(input: {
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

export function hasDeviceSimulatorSettings(settings: DeviceSimulatorSettings): boolean {
  return settings.deviceId !== undefined ||
    settings.orientation !== undefined ||
    settings.resolution !== undefined ||
    settings.pixelDensity !== undefined ||
    settings.scalingMode !== undefined;
}

export function buildDeviceSimulatorLuau(operation: 'get' | 'set', options: Record<string, unknown>): string {
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
