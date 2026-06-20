// World fingerprint generator for get_changes_since. The first cut keyed on path
// with a ClassName|childCount signature — too coarse (blind to renames, moves,
// property/tag/attribute/audio/script changes). This version emits three signature
// channels per node so the diff can say WHAT changed, keyed by a stable per-session
// node id (GetDebugId) instead of a fragile path:
//   structure = class | parentId | name | childCount   (topology/rename/move)
//   semantics = domain-specific properties             (geom/audio/script/env)
//   meta      = sorted tags + attributes               (CollectionService/attrs)
// Runs via execute-luau. All reads are pcall-guarded (some props throw under
// PluginSecurity).

import { luaString, luaNumber, PATH_RESOLVER_LUA } from './luau-emit.js';

// Shared Luau helpers: stable id + the three channel signatures.
const FINGERPRINT_HELPERS_LUA = `local function nid(d)
\tlocal ok, id = pcall(function() return d:GetDebugId(0) end)
\tif ok and id ~= nil and id ~= "" then return tostring(id) end
\treturn d:GetFullName()
end
local function get(d, prop)
\tlocal ok, v = pcall(function() return d[prop] end)
\tif ok then return v end
\treturn nil
end
local function structureSig(d)
\tlocal parent = d.Parent
\tlocal pid = parent and nid(parent) or "nil"
\treturn d.ClassName .. "|" .. pid .. "|" .. d.Name .. "|" .. tostring(#d:GetChildren())
end
local function round(n) if typeof(n) ~= "number" then return "?" end return tostring(math.floor(n * 100 + 0.5) / 100) end
local function semanticsSig(d)
\tif d:IsA("BasePart") then
\t\tlocal cf = get(d, "CFrame"); local sz = get(d, "Size")
\t\tlocal p = cf and cf.Position or Vector3.new()
\t\treturn "geom:" .. round(p.X) .. "," .. round(p.Y) .. "," .. round(p.Z)
\t\t\t.. "|" .. (sz and (round(sz.X) .. "," .. round(sz.Y) .. "," .. round(sz.Z)) or "?")
\t\t\t.. "|" .. tostring(get(d, "Material")) .. "|" .. tostring(get(d, "Anchored"))
\t\t\t.. "|" .. tostring(get(d, "CanCollide")) .. "|" .. round(get(d, "Transparency") or 0)
\telseif d:IsA("Sound") then
\t\treturn "audio:" .. tostring(get(d, "SoundId")) .. "|" .. tostring(get(d, "Playing"))
\t\t\t.. "|" .. tostring(get(d, "Looped")) .. "|" .. round(get(d, "Volume") or 0)
\t\t\t.. "|" .. round(get(d, "PlaybackSpeed") or 1)
\telseif d:IsA("LuaSourceContainer") then
\t\tlocal src = get(d, "Source")
\t\treturn "script:" .. tostring(get(d, "Enabled")) .. "|" .. (typeof(src) == "string" and tostring(#src) or "?")
\telseif d:IsA("Light") then
\t\treturn "light:" .. tostring(get(d, "Enabled")) .. "|" .. round(get(d, "Brightness") or 0)
\telse
\t\treturn ""
\tend
end
local function metaSig(d)
\tlocal parts = {}
\tlocal okT, tags = pcall(function() return d:GetTags() end)
\tif okT and tags and #tags > 0 then table.sort(tags) table.insert(parts, "t:" .. table.concat(tags, ",")) end
\tlocal okA, attrs = pcall(function() return d:GetAttributes() end)
\tif okA and attrs then
\t\tlocal keys = {}
\t\tfor k in pairs(attrs) do table.insert(keys, k) end
\t\ttable.sort(keys)
\t\tlocal kv = {}
\t\tfor _, k in ipairs(keys) do table.insert(kv, k .. "=" .. tostring(attrs[k])) end
\t\tif #kv > 0 then table.insert(parts, "a:" .. table.concat(kv, ",")) end
\tend
\treturn table.concat(parts, "|")
end`;

export function buildWorldFingerprintLuau(path = 'game', maxNodes = 8000): string {
	const safePath = luaString(path);
	const safeMax = luaNumber(Math.max(1, Math.floor(maxNodes)));
	return `${PATH_RESOLVER_LUA}
${FINGERPRINT_HELPERS_LUA}
local root = resolvePath(${safePath})
if not root then return { error = "Path not found: " .. ${safePath} } end
local fp = {}
local count = 0
local truncated = false
for _, d in ipairs(root:GetDescendants()) do
\tif count >= ${safeMax} then truncated = true break end
\tlocal id = nid(d)
\tfp[id] = {
\t\tp = d:GetFullName(),
\t\tst = structureSig(d),
\t\tse = semanticsSig(d),
\t\tme = metaSig(d),
\t}
\tcount = count + 1
end
return { fingerprint = fp, count = count, truncated = truncated, root = ${safePath} }`;
}
