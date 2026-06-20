// World-model read generators. The research review's top finding: an agent should
// reason from a token-lean *world snapshot* (signal layers, not the whole
// DataModel), then drill down with a batch read — rather than firing many small
// per-instance calls or one giant get_descendants. Both run via execute-luau, so
// no plugin rebuild is needed.

import { luaString, luaNumber, luaBool, PATH_RESOLVER_LUA } from './luau-emit.js';

// Shared Luau: serialize a Roblox value into a compact JSON-friendly shape so the
// agent gets [x,y,z] / [r,g,b] / names instead of opaque tostring() blobs.
const SERIALIZE_LUA = `local function ser(v)
\tlocal t = typeof(v)
\tif t == "Vector3" then return { v.X, v.Y, v.Z }
\telseif t == "Vector2" then return { v.X, v.Y }
\telseif t == "Color3" then return { math.floor(v.R*255+0.5), math.floor(v.G*255+0.5), math.floor(v.B*255+0.5) }
\telseif t == "CFrame" then local p = v.Position return { p.X, p.Y, p.Z }
\telseif t == "EnumItem" then return v.Name
\telseif t == "Instance" then return v:GetFullName()
\telseif t == "number" or t == "boolean" or t == "string" then return v
\telse return tostring(v) end
end`;

/**
 * Batch read: resolve several paths in one round-trip and return only the
 * requested fields per node. Replaces a cascade of get_instance_properties /
 * an expensive get_descendants when the agent already knows which nodes it wants.
 */
export function buildNodeBatchLuau(
  paths: string[],
  fields: string[] = [],
  includeChildrenCount = false,
): string {
  const pathList = paths.map((p) => luaString(p)).join(', ');
  const fieldList = fields.map((f) => luaString(f)).join(', ');
  return `${PATH_RESOLVER_LUA}
${SERIALIZE_LUA}
local paths = { ${pathList} }
local fields = { ${fieldList} }
local out = {}
for _, p in ipairs(paths) do
\tlocal inst = resolvePath(p)
\tif not inst then
\t\ttable.insert(out, { path = p, error = "not found" })
\telse
\t\tlocal row = { path = p, name = inst.Name, className = inst.ClassName }
\t\tif #fields > 0 then
\t\t\tlocal props = {}
\t\t\tfor _, f in ipairs(fields) do
\t\t\t\tlocal ok, val = pcall(function() return inst[f] end)
\t\t\t\tif ok then props[f] = ser(val) end
\t\t\tend
\t\t\trow.props = props
\t\tend
\t\tif ${luaBool(includeChildrenCount)} then row.childCount = #inst:GetChildren() end
\t\ttable.insert(out, row)
\tend
end
return { nodes = out, count = #out }`;
}

export type SnapshotLevel = 'overview' | 'standard';

/**
 * Token-lean world snapshot for reasoning before drill-down. `overview` returns
 * place info, class/tag/audio/script counts, notable subtree roots, and the
 * environment summary — enough to answer "where is the UI", "is there music",
 * "is the scene heavy", "are there tags" without dumping the tree.
 */
export function buildWorldSnapshotLuau(
  path = 'game',
  level: SnapshotLevel = 'overview',
  topNPerClass = 12,
): string {
  const safePath = luaString(path);
  const safeTopN = luaNumber(Math.max(1, Math.floor(topNPerClass)));
  return `${PATH_RESOLVER_LUA}
local root = resolvePath(${safePath})
if not root then return { error = "Path not found: " .. ${safePath} } end

local byClass = {}
local total = 0
local soundCount, soundPlaying, soundLooped = 0, 0, 0
local scriptCount, localScriptCount, moduleCount = 0, 0, 0
local taggedCount = 0
for _, d in ipairs(root:GetDescendants()) do
\ttotal = total + 1
\tbyClass[d.ClassName] = (byClass[d.ClassName] or 0) + 1
\tif d:IsA("Sound") then
\t\tsoundCount = soundCount + 1
\t\tlocal ok1, playing = pcall(function() return d.Playing end)
\t\tif ok1 and playing then soundPlaying = soundPlaying + 1 end
\t\tlocal ok2, looped = pcall(function() return d.Looped end)
\t\tif ok2 and looped then soundLooped = soundLooped + 1 end
\telseif d:IsA("LocalScript") then localScriptCount = localScriptCount + 1
\telseif d:IsA("ModuleScript") then moduleCount = moduleCount + 1
\telseif d:IsA("Script") then scriptCount = scriptCount + 1
\tend
\tlocal okt, tags = pcall(function() return #d:GetTags() > 0 end)
\tif okt and tags then taggedCount = taggedCount + 1 end
end

local arr = {}
for cls, n in pairs(byClass) do table.insert(arr, { className = cls, count = n }) end
table.sort(arr, function(a, b) return a.count > b.count end)
local top = {}
for i = 1, math.min(${safeTopN}, #arr) do top[i] = arr[i] end

-- Notable subtree roots: direct children of the root that actually contain
-- something. At game level this would otherwise dump ~110 empty services and
-- defeat the token-lean purpose, so skip childless roots and cap the list.
local roots = {}
local ROOT_LIMIT = 30
for _, c in ipairs(root:GetChildren()) do
\tlocal childCount = #c:GetChildren()
\tif childCount > 0 then
\t\ttable.insert(roots, { name = c.Name, className = c.ClassName, path = c:GetFullName(), childCount = childCount })
\tend
\tif #roots >= ROOT_LIMIT then break end
end

-- Environment summary (global Lighting + presence of key atmosphere objects).
-- Read individual properties through pcall: some (e.g. Lighting.Technology) need
-- the RobloxScript capability and throw under the plugin's PluginSecurity context.
local env = {}
local function safeGet(fn)
\tlocal ok, v = pcall(fn)
\tif ok then return v end
\treturn nil
end
local lighting = game:GetService("Lighting")
if lighting then
\tenv.clockTime = safeGet(function() return lighting.ClockTime end)
\tenv.technology = safeGet(function() return tostring(lighting.Technology) end)
\tenv.hasAtmosphere = lighting:FindFirstChildOfClass("Atmosphere") ~= nil
\tenv.hasSky = lighting:FindFirstChildOfClass("Sky") ~= nil
end
local ws = game:GetService("Workspace")
env.hasTerrain = ws and ws:FindFirstChildOfClass("Terrain") ~= nil
env.hasClouds = ws and ws.Terrain ~= nil and ws.Terrain:FindFirstChildOfClass("Clouds") ~= nil

local snapshot = {
\troot = ${safePath},
\tlevel = ${luaString(level)},
\tplace = { placeId = game.PlaceId, name = game.Name },
\tcounts = {
\t\ttotalDescendants = total,
\t\tdistinctClasses = #arr,
\t\ttagged = taggedCount,
\t\tsounds = soundCount,
\t\tsoundsPlaying = soundPlaying,
\t\tsoundsLooped = soundLooped,
\t\tscripts = scriptCount,
\t\tlocalScripts = localScriptCount,
\t\tmoduleScripts = moduleCount,
\t},
\ttopClasses = top,
\troots = roots,
\tenvironment = env,
}
return snapshot`;
}
