// Semantic-lite scene search. The research review recommended NOT a vector engine
// but a lightweight multi-signal index over name + class + tags + attributes +
// path/folder context — enough to answer "find the door system", "where is the shop
// UI", "what controls the day/night". Scoring runs server-side in Luau and returns
// only the ranked top-N (with a per-hit reason), so it stays token-lean. Runs via
// execute-luau.

import { luaString, luaNumber, PATH_RESOLVER_LUA } from './luau-emit.js';

export function buildSceneSearchLuau(query: string, path = 'game', limit = 10): string {
	const safePath = luaString(path);
	const safeQuery = luaString(query.toLowerCase());
	const safeLimit = luaNumber(Math.max(1, Math.min(50, Math.floor(limit))));
	return `${PATH_RESOLVER_LUA}
local root = resolvePath(${safePath})
if not root then return { error = "Path not found: " .. ${safePath} } end

local query = ${safeQuery}
local terms = {}
for w in string.gmatch(query, "[%w]+") do table.insert(terms, w) end
if #terms == 0 then return { error = "query must contain a search term" } end

local function lc(s) return string.lower(tostring(s)) end
local function countHits(haystack, term, weight)
\tif haystack == "" then return 0 end
\treturn (string.find(haystack, term, 1, true) ~= nil) and weight or 0
end

local scored = {}
for _, d in ipairs(root:GetDescendants()) do
\tlocal name = lc(d.Name)
\tlocal class = lc(d.ClassName)
\tlocal parentName = d.Parent and lc(d.Parent.Name) or ""
\t-- tags
\tlocal tagStr = ""
\tlocal okT, tags = pcall(function() return d:GetTags() end)
\tif okT and tags then tagStr = lc(table.concat(tags, " ")) end
\t-- attribute keys
\tlocal attrStr = ""
\tlocal okA, attrs = pcall(function() return d:GetAttributes() end)
\tif okA and attrs then
\t\tlocal keys = {}
\t\tfor k in pairs(attrs) do table.insert(keys, k) end
\t\tattrStr = lc(table.concat(keys, " "))
\tend

\tlocal score = 0
\tlocal matched = {}
\tfor _, term in ipairs(terms) do
\t\tlocal s = countHits(name, term, 5) + countHits(tagStr, term, 4)
\t\t\t+ countHits(attrStr, term, 3) + countHits(parentName, term, 2) + countHits(class, term, 1)
\t\tif s > 0 then score = score + s table.insert(matched, term) end
\tend
\t-- Require at least one matched term; bonus when the whole multi-word query hits the name.
\tif score > 0 then
\t\tif #terms > 1 and string.find(name, query, 1, true) then score = score + 6 end
\t\ttable.insert(scored, {
\t\t\tpath = d:GetFullName(), name = d.Name, className = d.ClassName,
\t\t\tscore = score, matched = matched,
\t\t})
\tend
end

table.sort(scored, function(a, b) return a.score > b.score end)
local top = {}
for i = 1, math.min(${safeLimit}, #scored) do top[i] = scored[i] end
return { query = query, total = #scored, returned = #top, results = top }`;
}
