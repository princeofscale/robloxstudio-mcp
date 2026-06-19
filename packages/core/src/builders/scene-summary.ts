// Aggregation generator for get_scene_summary. Instead of dumping a whole subtree
// (get_descendants can be thousands of lines), this counts descendants by ClassName
// server-side and returns a compact summary — totals + the top-N classes — so an
// agent can grok a scene's shape for a handful of tokens. Runs via execute-luau, so
// no plugin rebuild is needed.

import { luaString, luaNumber } from './luau-emit.js';
import { PATH_RESOLVER_LUA } from './luau-emit.js';

export function buildSceneSummaryLuau(path = 'game.Workspace', topN = 20): string {
  const safePath = luaString(path);
  const safeTopN = luaNumber(Math.max(1, Math.floor(topN)));
  return `${PATH_RESOLVER_LUA}
local root = resolvePath(${safePath})
if not root then return { error = "Path not found: " .. ${safePath} } end
local byClass = {}
local total = 0
for _, d in ipairs(root:GetDescendants()) do
\ttotal = total + 1
\tbyClass[d.ClassName] = (byClass[d.ClassName] or 0) + 1
end
local arr = {}
for cls, n in pairs(byClass) do table.insert(arr, { className = cls, count = n }) end
table.sort(arr, function(a, b) return a.count > b.count end)
local top = {}
for i = 1, math.min(${safeTopN}, #arr) do top[i] = arr[i] end
return {
\troot = ${safePath},
\tclassName = root.ClassName,
\tchildCount = #root:GetChildren(),
\ttotalDescendants = total,
\tdistinctClasses = #arr,
\ttopClasses = top,
}`;
}
