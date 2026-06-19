// Generators for lighting / atmosphere / sky / day-night tooling. As with the
// UI builders, these emit Luau executed in the plugin edit context so complex
// types (Color3, Atmosphere/Sky children) are configured natively.

import { luaString, luaNumber, color3FromRGB } from './luau-emit.js';

export interface AtmospherePreset {
  density?: number;
  offset?: number;
  color?: [number, number, number];
  decay?: [number, number, number];
  glare?: number;
  haze?: number;
}

export interface LightingPreset {
  clockTime: number;
  ambient: [number, number, number];
  outdoorAmbient: [number, number, number];
  brightness: number;
  fogColor?: [number, number, number];
  fogEnd?: number;
  fogStart?: number;
  colorShiftTop?: [number, number, number];
  atmosphere?: AtmospherePreset;
}

// Hand-tuned presets. Values are deliberately moderate so they read well in a
// default place without additional post-processing effects.
export const LIGHTING_PRESETS: Record<string, LightingPreset> = {
  sunny: {
    clockTime: 14, ambient: [70, 70, 70], outdoorAmbient: [128, 128, 128], brightness: 2,
    fogColor: [191, 215, 230], fogEnd: 100000, colorShiftTop: [0, 0, 0],
  },
  sunset: {
    clockTime: 17.5, ambient: [80, 50, 40], outdoorAmbient: [120, 80, 60], brightness: 1.5,
    fogColor: [230, 150, 100], fogEnd: 5000,
    atmosphere: { density: 0.35, color: [255, 180, 130], decay: [120, 90, 80], glare: 0.4, haze: 2 },
  },
  night: {
    clockTime: 0, ambient: [25, 25, 40], outdoorAmbient: [40, 40, 70], brightness: 1,
    fogColor: [20, 20, 40], fogEnd: 2000, colorShiftTop: [20, 20, 60],
  },
  horror: {
    clockTime: 2, ambient: [10, 10, 12], outdoorAmbient: [15, 15, 18], brightness: 0.4,
    fogColor: [8, 8, 10], fogEnd: 120, fogStart: 0,
    atmosphere: { density: 0.6, color: [30, 30, 35], decay: [20, 20, 25], glare: 0, haze: 5 },
  },
  cyberpunk: {
    clockTime: 22, ambient: [40, 20, 60], outdoorAmbient: [60, 30, 90], brightness: 1.2,
    fogColor: [40, 10, 60], fogEnd: 1500, colorShiftTop: [120, 40, 180],
    atmosphere: { density: 0.4, color: [180, 80, 255], decay: [90, 40, 160], glare: 0.6, haze: 3 },
  },
  obby: {
    clockTime: 13, ambient: [90, 90, 100], outdoorAmbient: [150, 150, 160], brightness: 2.5,
    fogColor: [200, 225, 240], fogEnd: 100000,
  },
  simulator: {
    clockTime: 12, ambient: [100, 100, 110], outdoorAmbient: [160, 160, 170], brightness: 3,
    fogColor: [210, 230, 245], fogEnd: 100000,
  },
  realistic: {
    clockTime: 15, ambient: [60, 60, 65], outdoorAmbient: [110, 110, 120], brightness: 2,
    fogColor: [180, 200, 215], fogEnd: 8000,
    atmosphere: { density: 0.3, color: [200, 210, 220], decay: [100, 110, 120], glare: 0.2, haze: 1.5 },
  },
};

export function getLightingPresetNames(): string[] {
  return Object.keys(LIGHTING_PRESETS);
}

function clampClock(hour: number): number {
  return Math.max(0, Math.min(24, hour));
}

export function buildSetTimeOfDayLuau(time: number | string): string {
  const lines = ['local Lighting = game:GetService("Lighting")'];
  if (typeof time === 'number') {
    lines.push(`Lighting.ClockTime = ${luaNumber(clampClock(time))}`);
  } else {
    lines.push(`Lighting.TimeOfDay = ${luaString(time)}`);
  }
  lines.push('return { clockTime = Lighting.ClockTime, timeOfDay = Lighting.TimeOfDay, success = true }');
  return lines.join('\n');
}

function atmosphereLines(target: string, atm: AtmospherePreset): string[] {
  const lines = [
    `local atmosphere = ${target}:FindFirstChildOfClass("Atmosphere") or Instance.new("Atmosphere")`,
  ];
  if (atm.density !== undefined) lines.push(`atmosphere.Density = ${luaNumber(atm.density)}`);
  if (atm.offset !== undefined) lines.push(`atmosphere.Offset = ${luaNumber(atm.offset)}`);
  if (atm.color) lines.push(`atmosphere.Color = ${color3FromRGB(...atm.color)}`);
  if (atm.decay) lines.push(`atmosphere.Decay = ${color3FromRGB(...atm.decay)}`);
  if (atm.glare !== undefined) lines.push(`atmosphere.Glare = ${luaNumber(atm.glare)}`);
  if (atm.haze !== undefined) lines.push(`atmosphere.Haze = ${luaNumber(atm.haze)}`);
  lines.push(`atmosphere.Parent = ${target}`);
  return lines;
}

// Named, idempotent post-processing effects for a polished "simulator" look.
// Each is created only if absent (looked up by name) so re-applying a preset
// doesn't stack duplicates.
function postFxLines(): string[] {
  return [
    'pcall(function() Lighting.Technology = Enum.Technology.Future end)',
    'Lighting.GlobalShadows = true',
    'local function ensureFx(className, name, props)',
    '\tlocal fx = Lighting:FindFirstChild(name)',
    '\tif not fx then fx = Instance.new(className); fx.Name = name; fx.Parent = Lighting end',
    '\tfor k, v in pairs(props) do fx[k] = v end',
    '\treturn fx',
    'end',
    'ensureFx("BloomEffect", "PresetBloom", { Intensity = 0.45, Size = 24, Threshold = 1.15 })',
    'ensureFx("ColorCorrectionEffect", "PresetColor", { Saturation = 0.15, Contrast = 0.05, Brightness = 0 })',
    'ensureFx("SunRaysEffect", "PresetSunRays", { Intensity = 0.08, Spread = 0.35 })',
  ];
}

export function buildLightingPresetLuau(preset: string, withPostFx = false): string {
  const config = LIGHTING_PRESETS[preset];
  if (!config) {
    throw new Error(`Unknown preset "${preset}". Available: ${getLightingPresetNames().join(', ')}`);
  }
  const lines: string[] = [
    'local Lighting = game:GetService("Lighting")',
    `Lighting.ClockTime = ${luaNumber(config.clockTime)}`,
    `Lighting.Ambient = ${color3FromRGB(...config.ambient)}`,
    `Lighting.OutdoorAmbient = ${color3FromRGB(...config.outdoorAmbient)}`,
    `Lighting.Brightness = ${luaNumber(config.brightness)}`,
  ];
  if (config.fogColor) lines.push(`Lighting.FogColor = ${color3FromRGB(...config.fogColor)}`);
  if (config.fogEnd !== undefined) lines.push(`Lighting.FogEnd = ${luaNumber(config.fogEnd)}`);
  if (config.fogStart !== undefined) lines.push(`Lighting.FogStart = ${luaNumber(config.fogStart)}`);
  if (config.colorShiftTop) lines.push(`Lighting.ColorShift_Top = ${color3FromRGB(...config.colorShiftTop)}`);
  if (config.atmosphere) lines.push(...atmosphereLines('Lighting', config.atmosphere));
  if (withPostFx) lines.push(...postFxLines());
  lines.push(`return { preset = ${luaString(preset)}, postFx = ${withPostFx ? 'true' : 'false'}, success = true }`);
  return lines.join('\n');
}

export function buildAtmosphereLuau(options: AtmospherePreset): string {
  const lines = ['local Lighting = game:GetService("Lighting")'];
  lines.push(...atmosphereLines('Lighting', options));
  lines.push('return { success = true }');
  return lines.join('\n');
}

export interface SkyOptions {
  sunTextureId?: string;
  moonTextureId?: string;
  starCount?: number;
  skyboxFaces?: string; // single asset id applied to all six faces
  celestialBodiesShown?: boolean;
}

export function buildSkyLuau(options: SkyOptions): string {
  const lines = [
    'local Lighting = game:GetService("Lighting")',
    'local sky = Lighting:FindFirstChildOfClass("Sky") or Instance.new("Sky")',
  ];
  if (options.sunTextureId !== undefined) lines.push(`sky.SunTextureId = ${luaString(options.sunTextureId)}`);
  if (options.moonTextureId !== undefined) lines.push(`sky.MoonTextureId = ${luaString(options.moonTextureId)}`);
  if (options.starCount !== undefined) lines.push(`sky.StarCount = ${luaNumber(options.starCount)}`);
  if (options.celestialBodiesShown !== undefined) lines.push(`sky.CelestialBodiesShown = ${options.celestialBodiesShown ? 'true' : 'false'}`);
  if (options.skyboxFaces !== undefined) {
    for (const face of ['SkyboxBk', 'SkyboxDn', 'SkyboxFt', 'SkyboxLf', 'SkyboxRt', 'SkyboxUp']) {
      lines.push(`sky.${face} = ${luaString(options.skyboxFaces)}`);
    }
  }
  lines.push('sky.Parent = Lighting');
  lines.push('return { success = true }');
  return lines.join('\n');
}

export interface DayNightCycleOptions {
  minutesPerDay?: number;
  scriptName?: string;
  parentPath?: string;
}

export function buildDayNightCycleScriptLuau(options: DayNightCycleOptions = {}): string {
  const minutesPerDay = options.minutesPerDay && options.minutesPerDay > 0 ? options.minutesPerDay : 10;
  const scriptName = options.scriptName ?? 'DayNightCycle';
  // The day-night logic itself, embedded as the new Script's Source via a Lua
  // long-bracket literal (`[==[ ... ]==]`) so quotes/newlines pass through clean.
  const cycleSource = `--!strict
-- ${scriptName} — advances Lighting.ClockTime continuously.
local Lighting = game:GetService("Lighting")
local RunService = game:GetService("RunService")
local MINUTES_PER_DAY = ${minutesPerDay}
local SECONDS_PER_DAY = MINUTES_PER_DAY * 60
RunService.Heartbeat:Connect(function(dt)
\tLighting.ClockTime = (Lighting.ClockTime + (24 / SECONDS_PER_DAY) * dt) % 24
end)`;
  const lines = [
    'local ServerScriptService = game:GetService("ServerScriptService")',
    `local existing = ServerScriptService:FindFirstChild(${luaString(scriptName)})`,
    'if existing then existing:Destroy() end',
    'local script = Instance.new("Script")',
    `script.Name = ${luaString(scriptName)}`,
    `script.Source = [==[\n${cycleSource}\n]==]`,
    'script.Parent = ServerScriptService',
    `return { path = script:GetFullName(), minutesPerDay = ${minutesPerDay}, success = true }`,
  ];
  return lines.join('\n');
}
