// Generators for Terrain operations. Terrain has no settable "property" form,
// so these must run as Luau in the plugin edit context against workspace.Terrain.
// Volume helpers are exported so the tool layer can enforce hard size limits
// (preventing an AI from freezing Studio with a giant FillRegion) before the
// generated code is ever sent.

import { luaNumber, vector3 } from './luau-emit.js';

export type Vec3 = [number, number, number];

export function boxVolume(size: Vec3): number {
  return Math.abs(size[0]) * Math.abs(size[1]) * Math.abs(size[2]);
}

export function regionVolume(min: Vec3, max: Vec3): number {
  return Math.abs(max[0] - min[0]) * Math.abs(max[1] - min[1]) * Math.abs(max[2] - min[2]);
}

function material(name: string): string {
  return `Enum.Material.${name.replace(/[^A-Za-z0-9]/g, '')}`;
}

function region3(min: Vec3, max: Vec3): string {
  return `Region3.new(${vector3(...min)}, ${vector3(...max)}):ExpandToGrid(4)`;
}

export interface BaseplateOptions {
  size: Vec3;
  position?: Vec3;
  material?: string;
}

export function buildBaseplateLuau(options: BaseplateOptions): string {
  const pos = options.position ?? [0, 0, 0];
  const mat = material(options.material ?? 'Grass');
  return [
    'local Terrain = workspace.Terrain',
    `Terrain:FillBlock(CFrame.new(${vector3(...pos)}), ${vector3(...options.size)}, ${mat})`,
    `return { shape = "baseplate", volume = ${luaNumber(boxVolume(options.size))}, success = true }`,
  ].join('\n');
}

export interface IslandOptions {
  center: Vec3;
  radius: number;
  material?: string;
  waterMaterial?: string;
  waterRadius?: number;
}

export function buildIslandLuau(options: IslandOptions): string {
  const mat = material(options.material ?? 'Sand');
  const lines = [
    'local Terrain = workspace.Terrain',
    `Terrain:FillBall(${vector3(...options.center)}, ${luaNumber(options.radius)}, ${mat})`,
  ];
  if (options.waterMaterial || options.waterRadius) {
    const wr = options.waterRadius ?? options.radius * 1.6;
    const cy = options.center[1];
    const waterMat = material(options.waterMaterial ?? 'Water');
    // A shallow water disk around the island, sitting at the island's base.
    lines.push(`Terrain:FillBlock(CFrame.new(${vector3(options.center[0], cy - options.radius * 0.5, options.center[2])}), ${vector3(wr * 2, options.radius, wr * 2)}, ${waterMat})`);
  }
  lines.push(`return { shape = "island", radius = ${luaNumber(options.radius)}, success = true }`);
  return lines.join('\n');
}

export interface MountainsOptions {
  center: Vec3;
  extent: [number, number];
  maxHeight: number;
  material?: string;
  resolution?: number;
  seed?: number;
  frequency?: number;
}

export function buildMountainsLuau(options: MountainsOptions): string {
  const mat = material(options.material ?? 'Rock');
  const res = options.resolution && options.resolution >= 4 ? options.resolution : 16;
  const seed = options.seed ?? 0;
  const freq = options.frequency ?? 100;
  const [cx, cy, cz] = options.center;
  const [ex, ez] = options.extent;
  return [
    'local Terrain = workspace.Terrain',
    `local res = ${luaNumber(res)}`,
    `local maxHeight = ${luaNumber(options.maxHeight)}`,
    `local seed = ${luaNumber(seed)}`,
    `local baseX, baseY, baseZ = ${luaNumber(cx - ex / 2)}, ${luaNumber(cy)}, ${luaNumber(cz - ez / 2)}`,
    `for gx = 0, ${luaNumber(ex)}, res do`,
    `\tfor gz = 0, ${luaNumber(ez)}, res do`,
    '\t\tlocal wx = baseX + gx',
    '\t\tlocal wz = baseZ + gz',
    `\t\tlocal n = (math.noise(wx / ${luaNumber(freq)} + seed, wz / ${luaNumber(freq)} + seed) + 1) * 0.5`,
    '\t\tlocal h = math.max(4, n * maxHeight)',
    `\t\tTerrain:FillBlock(CFrame.new(wx, baseY + h / 2, wz), Vector3.new(res, h, res), ${mat})`,
    '\tend',
    'end',
    'return { shape = "mountains", success = true }',
  ].join('\n');
}

export interface WaterOptions {
  size: Vec3;
  position?: Vec3;
}

export function buildWaterLuau(options: WaterOptions): string {
  const pos = options.position ?? [0, 0, 0];
  return [
    'local Terrain = workspace.Terrain',
    `Terrain:FillBlock(CFrame.new(${vector3(...pos)}), ${vector3(...options.size)}, Enum.Material.Water)`,
    `return { shape = "water", volume = ${luaNumber(boxVolume(options.size))}, success = true }`,
  ].join('\n');
}

export interface PaintMaterialOptions {
  min: Vec3;
  max: Vec3;
  material: string;
  replaceMaterial?: string;
}

export function buildPaintMaterialLuau(options: PaintMaterialOptions): string {
  const target = material(options.material);
  const region = region3(options.min, options.max);
  const op = options.replaceMaterial
    ? `Terrain:ReplaceMaterial(${region}, 4, ${material(options.replaceMaterial)}, ${target})`
    : `Terrain:FillRegion(${region}, 4, ${target})`;
  return [
    'local Terrain = workspace.Terrain',
    op,
    'return { shape = "paint", success = true }',
  ].join('\n');
}

export interface ClearRegionOptions {
  min: Vec3;
  max: Vec3;
}

export function buildClearRegionLuau(options: ClearRegionOptions): string {
  return [
    'local Terrain = workspace.Terrain',
    `Terrain:FillRegion(${region3(options.min, options.max)}, 4, Enum.Material.Air)`,
    'return { shape = "clear", success = true }',
  ].join('\n');
}
