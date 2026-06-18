// Luau that walks the common script-bearing services and returns every
// LuaSourceContainer as { path, className, source }. The plugin JSON-encodes
// table return values, so the tool layer parses response.returnValue as JSON.

import { luaString } from '../builders/luau-emit.js';

export const DEFAULT_SYNC_ROOTS = [
  'ServerScriptService',
  'ServerStorage',
  'ReplicatedStorage',
  'ReplicatedFirst',
  'StarterGui',
  'StarterPack',
  'StarterPlayer',
  'Workspace',
  'Lighting',
];

export function buildDumpScriptsLuau(roots: string[] = DEFAULT_SYNC_ROOTS): string {
  const rootList = roots.map((r) => luaString(r)).join(', ');
  return `local roots = { ${rootList} }
local results = {}
for _, rootName in ipairs(roots) do
\tlocal ok, root = pcall(function() return game:GetService(rootName) end)
\tif ok and root then
\t\tfor _, d in ipairs(root:GetDescendants()) do
\t\t\tif d:IsA("LuaSourceContainer") then
\t\t\t\ttable.insert(results, { path = d:GetFullName(), className = d.ClassName, source = d.Source })
\t\t\tend
\t\tend
\tend
end
return results`;
}
