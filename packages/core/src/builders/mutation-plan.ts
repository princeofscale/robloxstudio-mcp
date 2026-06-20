// Transactional batch mutations (research review #4). One typed plan → many small
// edits in a single round-trip, with a dry-run diff and a ready-to-run reverse plan
// ("rollback") in the receipt — stateless: the rollback IS another mutation plan, so
// no server-side handle/TTL is needed. Runs via execute-luau.
//
// Supported ops (safe, type-unambiguous subset; for Vector3/Color3/Enum properties
// use the existing set_property tool, which has full deserialization):
//   { op:"set_property",  target, property, value }   value: boolean | number | string
//   { op:"set_attribute", target, name, value }       value: boolean | number | string
//   { op:"add_tag",       target, tag }
//   { op:"remove_tag",    target, tag }

import { luaBool, PATH_RESOLVER_LUA } from './luau-emit.js';

export interface MutationOp {
  op: 'set_property' | 'set_attribute' | 'add_tag' | 'remove_tag';
  target: string;
  property?: string;
  name?: string;
  tag?: string;
  value?: boolean | number | string;
}

export function buildMutationPlanLuau(operations: MutationOp[], dryRun: boolean): string {
  // Operations travel as a JSON literal decoded inside Luau (HttpService:JSONDecode),
  // so user strings never interpolate into code — injection-safe.
  const opsJson = JSON.stringify(JSON.stringify(operations));
  return `${PATH_RESOLVER_LUA}
local HttpService = game:GetService("HttpService")
local CollectionService = game:GetService("CollectionService")
local ops = HttpService:JSONDecode(${opsJson})
local dryRun = ${luaBool(dryRun)}

local function ser(v)
\tlocal t = typeof(v)
\tif t == "number" or t == "boolean" or t == "string" then return v end
\treturn tostring(v)
end

local results = {}
local rollback = {}
local succeeded, failed = 0, 0

for _, op in ipairs(ops) do
\tlocal r = { op = op.op, target = op.target }
\tlocal inst = resolvePath(op.target)
\tif not inst then
\t\tr.ok = false; r.error = "not found"; failed = failed + 1
\telse
\t\tif op.op == "set_property" then
\t\t\tlocal okb, before = pcall(function() return inst[op.property] end)
\t\t\tif okb then r.before = ser(before) end
\t\t\tr.property = op.property
\t\t\tif dryRun then
\t\t\t\tr.ok = true; r.wouldSet = ser(op.value)
\t\t\telse
\t\t\t\tlocal oks, err = pcall(function() inst[op.property] = op.value end)
\t\t\t\tr.ok = oks
\t\t\t\tif oks then
\t\t\t\t\tr.after = ser(op.value); succeeded = succeeded + 1
\t\t\t\t\tif okb then table.insert(rollback, { op = "set_property", target = op.target, property = op.property, value = ser(before) }) end
\t\t\t\telse r.error = tostring(err); failed = failed + 1 end
\t\t\tend
\t\telseif op.op == "set_attribute" then
\t\t\tlocal before = inst:GetAttribute(op.name)
\t\t\tif before ~= nil then r.before = ser(before) end
\t\t\tr.name = op.name
\t\t\tif dryRun then r.ok = true; r.wouldSet = ser(op.value)
\t\t\telse
\t\t\t\tlocal oks, err = pcall(function() inst:SetAttribute(op.name, op.value) end)
\t\t\t\tr.ok = oks
\t\t\t\tif oks then succeeded = succeeded + 1
\t\t\t\t\ttable.insert(rollback, { op = "set_attribute", target = op.target, name = op.name, value = before ~= nil and ser(before) or nil })
\t\t\t\telse r.error = tostring(err); failed = failed + 1 end
\t\t\tend
\t\telseif op.op == "add_tag" then
\t\t\tlocal had = CollectionService:HasTag(inst, op.tag)
\t\t\tif dryRun then r.ok = true
\t\t\telse local oks, err = pcall(function() CollectionService:AddTag(inst, op.tag) end)
\t\t\t\tr.ok = oks
\t\t\t\tif oks then succeeded = succeeded + 1
\t\t\t\t\tif not had then table.insert(rollback, { op = "remove_tag", target = op.target, tag = op.tag }) end
\t\t\t\telse r.error = tostring(err); failed = failed + 1 end
\t\t\tend
\t\telseif op.op == "remove_tag" then
\t\t\tlocal had = CollectionService:HasTag(inst, op.tag)
\t\t\tif dryRun then r.ok = true
\t\t\telse local oks, err = pcall(function() CollectionService:RemoveTag(inst, op.tag) end)
\t\t\t\tr.ok = oks
\t\t\t\tif oks then succeeded = succeeded + 1
\t\t\t\t\tif had then table.insert(rollback, { op = "add_tag", target = op.target, tag = op.tag }) end
\t\t\t\telse r.error = tostring(err); failed = failed + 1 end
\t\t\tend
\t\telse
\t\t\tr.ok = false; r.error = "unsupported op: " .. tostring(op.op); failed = failed + 1
\t\tend
\tend
\ttable.insert(results, r)
end

return {
\tapplied = not dryRun,
\tdryRun = dryRun,
\tresults = results,
\trollback = rollback,
\tsummary = { total = #ops, succeeded = succeeded, failed = failed },
}`;
}
