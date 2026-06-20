// Live playtest telemetry (research review's top Roblox-specific frontier). Samples
// the runtime DataModel during a playtest and returns a domain-masked snapshot of
// live state an agent can reason about while debugging gameplay: players (position/
// health/team/tool), named world state values, active audio, and runtime/role flags.
// Runs via execute-luau against a running peer (target="server" by default). In edit
// mode there are no players, so those domains come back empty — that's expected.

export type TelemetryDomain = 'players' | 'world' | 'audio' | 'runtime';

const ALL: TelemetryDomain[] = ['players', 'world', 'audio', 'runtime'];

export function buildPlaytestSampleLuau(domains: TelemetryDomain[] = ALL): string {
	const want = new Set(domains.length > 0 ? domains : ALL);
	const mask = (d: TelemetryDomain) => (want.has(d) ? 'true' : 'false');
	return `local RunService = game:GetService("RunService")
local out = {}

if ${mask('runtime')} then
\tout.runtime = {
\t\tisRunning = RunService:IsRunning(),
\t\tisServer = RunService:IsServer(),
\t\tisClient = RunService:IsClient(),
\t\tisStudio = RunService:IsStudio(),
\t}
end

if ${mask('players')} then
\tlocal players = {}
\tlocal Players = game:GetService("Players")
\tfor _, plr in ipairs(Players:GetPlayers()) do
\t\tlocal info = { name = plr.Name, userId = plr.UserId }
\t\tlocal char = plr.Character
\t\tif char then
\t\t\tlocal hrp = char:FindFirstChild("HumanoidRootPart")
\t\t\tif hrp then local p = hrp.Position info.position = { p.X, p.Y, p.Z } end
\t\t\tlocal hum = char:FindFirstChildOfClass("Humanoid")
\t\t\tif hum then
\t\t\t\tinfo.health = hum.Health
\t\t\t\tinfo.maxHealth = hum.MaxHealth
\t\t\t\tlocal oks, st = pcall(function() return tostring(hum:GetState()) end)
\t\t\t\tif oks then info.humanoidState = st end
\t\t\t\tlocal tool = char:FindFirstChildOfClass("Tool")
\t\t\t\tif tool then info.tool = tool.Name end
\t\t\tend
\t\tend
\t\tlocal okt, team = pcall(function() return plr.Team and plr.Team.Name or nil end)
\t\tif okt and team then info.team = team end
\t\ttable.insert(players, info)
\tend
\tout.players = players
\tout.playerCount = #players
end

if ${mask('world')} then
\t-- Named state held in ValueBase objects (round counters, flags, ids).
\tlocal values = {}
\tlocal roots = { game:GetService("Workspace"), game:GetService("ReplicatedStorage"), game:GetService("ServerStorage") }
\tfor _, root in ipairs(roots) do
\t\tfor _, d in ipairs(root:GetDescendants()) do
\t\t\tif d:IsA("ValueBase") and #values < 100 then
\t\t\t\tlocal okv, v = pcall(function() return d.Value end)
\t\t\t\tif okv then table.insert(values, { path = d:GetFullName(), class = d.ClassName, value = tostring(v) }) end
\t\t\tend
\t\tend
\tend
\tout.worldValues = values
end

if ${mask('audio')} then
\tlocal playing = {}
\tfor _, d in ipairs(game:GetDescendants()) do
\t\tif d:IsA("Sound") then
\t\t\tlocal okp, p = pcall(function() return d.Playing end)
\t\t\tif okp and p then
\t\t\t\ttable.insert(playing, { path = d:GetFullName(), soundId = tostring(d.SoundId), looped = d.Looped, volume = d.Volume })
\t\t\tend
\t\tend
\tend
\tout.activeAudio = playing
\tout.activeAudioCount = #playing
end

return out`;
}
