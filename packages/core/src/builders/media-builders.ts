// Media / creative-asset generators: Sound, Animation, and image/texture
// application. Like the other builders these emit Luau executed in the plugin
// edit context, so they handle asset URIs and class-specific properties cleanly
// without a plugin rebuild.

import { luaString, luaNumber, luaBool, PATH_RESOLVER_LUA } from './luau-emit.js';

/** Normalize an asset reference to a usable Roblox content URI. */
export function assetUri(asset: number | string): string {
  if (typeof asset === 'number') return `rbxassetid://${asset}`;
  const trimmed = asset.trim();
  if (/^\d+$/.test(trimmed)) return `rbxassetid://${trimmed}`;
  return trimmed;
}

function wrap(body: string): string {
  return `${PATH_RESOLVER_LUA}\n${body}`;
}

export interface CreateSoundOptions {
  parentPath: string;
  soundId: number | string;
  name?: string;
  volume?: number;
  looped?: boolean;
  playbackSpeed?: number;
  playOnCreate?: boolean;
}

export function buildCreateSoundLuau(options: CreateSoundOptions): string {
  const lines = [
    `local parent = resolvePath(${luaString(options.parentPath)})`,
    `if parent == nil then error("Parent not found: " .. ${luaString(options.parentPath)}) end`,
    `local sound = Instance.new("Sound")`,
    `sound.SoundId = ${luaString(assetUri(options.soundId))}`,
  ];
  if (options.name !== undefined) lines.push(`sound.Name = ${luaString(options.name)}`);
  if (options.volume !== undefined) lines.push(`sound.Volume = ${luaNumber(options.volume)}`);
  if (options.looped !== undefined) lines.push(`sound.Looped = ${luaBool(options.looped)}`);
  if (options.playbackSpeed !== undefined) lines.push(`sound.PlaybackSpeed = ${luaNumber(options.playbackSpeed)}`);
  lines.push(`sound.Parent = parent`);
  if (options.playOnCreate) lines.push(`sound:Play()`);
  lines.push(`return { path = sound:GetFullName(), className = "Sound", success = true }`);
  return wrap(lines.join('\n'));
}

export interface PlaySoundOptions {
  path: string;
}

export function buildPlaySoundLuau(options: PlaySoundOptions): string {
  const body = `local sound = resolvePath(${luaString(options.path)})
if sound == nil or not sound:IsA("Sound") then error("Sound not found: " .. ${luaString(options.path)}) end
sound:Play()
return { path = sound:GetFullName(), playing = true, success = true }`;
  return wrap(body);
}

export interface CreateAnimationOptions {
  parentPath: string;
  animationId: number | string;
  name?: string;
}

export function buildCreateAnimationLuau(options: CreateAnimationOptions): string {
  const lines = [
    `local parent = resolvePath(${luaString(options.parentPath)})`,
    `if parent == nil then error("Parent not found: " .. ${luaString(options.parentPath)}) end`,
    `local anim = Instance.new("Animation")`,
    `anim.AnimationId = ${luaString(assetUri(options.animationId))}`,
    `anim.Name = ${luaString(options.name ?? 'Animation')}`,
    `anim.Parent = parent`,
    `return { path = anim:GetFullName(), className = "Animation", success = true }`,
  ];
  return wrap(lines.join('\n'));
}

export interface PlayAnimationOptions {
  rigPath: string;
  animationId: number | string;
  looped?: boolean;
}

export function buildPlayAnimationLuau(options: PlayAnimationOptions): string {
  // Resolve the rig, find (or create) an Animator under its Humanoid or
  // AnimationController, load the animation, and play it. Works on R6/R15 rigs.
  const body = `local rig = resolvePath(${luaString(options.rigPath)})
if rig == nil then error("Rig not found: " .. ${luaString(options.rigPath)}) end
local controller = rig:FindFirstChildOfClass("Humanoid") or rig:FindFirstChildOfClass("AnimationController")
if controller == nil then error("No Humanoid or AnimationController under: " .. ${luaString(options.rigPath)}) end
local animator = controller:FindFirstChildOfClass("Animator")
if animator == nil then
\tanimator = Instance.new("Animator")
\tanimator.Parent = controller
end
local anim = Instance.new("Animation")
anim.AnimationId = ${luaString(assetUri(options.animationId))}
local track = animator:LoadAnimation(anim)
track.Looped = ${luaBool(options.looped ?? false)}
track:Play()
return { rig = rig:GetFullName(), playing = true, success = true }`;
  return wrap(body);
}

export interface ApplyTextureOptions {
  targetPath: string;
  assetId: number | string;
  /** Force a specific property instead of inferring from class. */
  property?: string;
}

export function buildApplyTextureLuau(options: ApplyTextureOptions): string {
  const uri = luaString(assetUri(options.assetId));
  if (options.property) {
    const body = `local target = resolvePath(${luaString(options.targetPath)})
if target == nil then error("Target not found: " .. ${luaString(options.targetPath)}) end
target.${options.property.replace(/[^A-Za-z0-9]/g, '')} = ${uri}
return { path = target:GetFullName(), property = ${luaString(options.property)}, success = true }`;
    return wrap(body);
  }
  // Pick the natural image property for the target's class.
  const body = `local target = resolvePath(${luaString(options.targetPath)})
if target == nil then error("Target not found: " .. ${luaString(options.targetPath)}) end
local uri = ${uri}
local prop
if target:IsA("ImageLabel") or target:IsA("ImageButton") then
\tprop = "Image"
elseif target:IsA("Decal") or target:IsA("Texture") then
\tprop = "Texture"
elseif target:IsA("MeshPart") then
\tprop = "TextureID"
elseif target:IsA("SurfaceAppearance") then
\tprop = "ColorMap"
else
\terror("Don't know which texture property to set on a " .. target.ClassName .. "; pass property explicitly.")
end
target[prop] = uri
return { path = target:GetFullName(), property = prop, success = true }`;
  return wrap(body);
}

// === Native AI 3D model generation (GenerationService:GenerateModelAsync) ===
// On-platform, free, moderation-aware. Verified live: returns (Model, {UUID=...})
// after ~28s; PredefinedSchema "Body1" yields a Model > "body" > MeshPart.
// ponytail: text-prompt path only; Image-conditioning input deferred until asked.

export interface GenerateModelOptions {
  prompt: string;
  parentPath?: string;
  name?: string;
  /** Predefined Roblox schema: "Body1" (single mesh) or "Car5" (five-part car). */
  predefinedSchema?: 'Body1' | 'Car5';
  /** Custom schema: names of the parts to produce (maps to SchemaDefinition.Groups). */
  parts?: string[];
  size?: { x: number; y: number; z: number };
  maxTriangles?: number;
  generateTextures?: boolean;
}

export function buildGenerateModelLuau(options: GenerateModelOptions): string {
  const parentPath = options.parentPath ?? 'Workspace';

  const inputs = [`TextPrompt = ${luaString(options.prompt)}`];
  if (options.size) {
    inputs.push(`Size = Vector3.new(${luaNumber(options.size.x)}, ${luaNumber(options.size.y)}, ${luaNumber(options.size.z)})`);
  }
  if (options.maxTriangles !== undefined) inputs.push(`MaxTriangles = ${luaNumber(options.maxTriangles)}`);
  if (options.generateTextures !== undefined) inputs.push(`GenerateTextures = ${luaBool(options.generateTextures)}`);

  // schema: exactly one of PredefinedSchema or SchemaDefinition.Groups (default Body1).
  let schemaLua: string;
  if (options.parts && options.parts.length > 0) {
    const groups = options.parts.map((p) => luaString(p)).join(', ');
    schemaLua = `{ SchemaDefinition = { Groups = { ${groups} } } }`;
  } else {
    schemaLua = `{ PredefinedSchema = ${luaString(options.predefinedSchema ?? 'Body1')} }`;
  }

  const nameLua = options.name !== undefined ? luaString(options.name) : 'nil';

  const body = `local GenerationService = game:GetService("GenerationService")
local parent = resolvePath(${luaString(parentPath)})
if parent == nil then error("Parent not found: " .. ${luaString(parentPath)}) end
local inputs = { ${inputs.join(', ')} }
local schema = ${schemaLua}
local model, meta = GenerationService:GenerateModelAsync(inputs, schema)
if model == nil then error("GenerateModelAsync returned no model") end
local desiredName = ${nameLua}
if desiredName ~= nil then model.Name = desiredName end
model.Parent = parent
local parts = {}
for _, d in ipairs(model:GetDescendants()) do
\ttable.insert(parts, { name = d.Name, className = d.ClassName })
end
local cf, size = model:GetBoundingBox()
return {
\tsuccess = true,
\tuuid = (typeof(meta) == "table" and meta.UUID) or nil,
\tmodelPath = model:GetFullName(),
\tmodelName = model.Name,
\tparentPath = parent:GetFullName(),
\tparts = parts,
\tpartCount = #parts,
\tboundingBox = { x = size.X, y = size.Y, z = size.Z },
}`;
  return wrap(body);
}
