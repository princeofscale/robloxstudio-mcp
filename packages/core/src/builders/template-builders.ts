// Game-template generators. Each returns one self-contained Luau blueprint that
// runs in the Studio edit context and builds a complete, clean starter game:
// Workspace geometry, services wiring, leaderstats, and gameplay scripts whose
// Source is embedded via Lua long-bracket literals. Re-running a template is
// idempotent — `ensure` rebuilds each named instance rather than duplicating.

import { luaString } from './luau-emit.js';

// Shared helpers available to every template body.
const TEMPLATE_PRELUDE_LUA = `local Workspace = game:GetService("Workspace")
local ServerScriptService = game:GetService("ServerScriptService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local ServerStorage = game:GetService("ServerStorage")
local StarterGui = game:GetService("StarterGui")

local function ensure(parent, name, className)
\tlocal existing = parent:FindFirstChild(name)
\tif existing and existing.ClassName == className then return existing end
\tif existing then existing:Destroy() end
\tlocal inst = Instance.new(className)
\tinst.Name = name
\tinst.Parent = parent
\treturn inst
end

local function makeScript(parent, name, src, className)
\tlocal s = ensure(parent, name, className or "Script")
\ts.Source = src
\treturn s
end

local function makePart(parent, name, size, position, color, anchored)
\tlocal p = ensure(parent, name, "Part")
\tp.Size = size
\tp.Position = position
\tp.Anchored = (anchored ~= false)
\tp.TopSurface = Enum.SurfaceType.Smooth
\tp.BottomSurface = Enum.SurfaceType.Smooth
\tif color then p.Color = color end
\treturn p
end`;

function blueprint(body: string): string {
  return `${TEMPLATE_PRELUDE_LUA}\n\n${body}`;
}

// --- Obby -------------------------------------------------------------------

export interface ObbyTemplateOptions {
  checkpoints?: number;
}

export function buildObbyTemplateLuau(options: ObbyTemplateOptions = {}): string {
  const checkpoints = options.checkpoints && options.checkpoints > 0 ? Math.floor(options.checkpoints) : 5;

  const obbyServer = `local Players = game:GetService("Players")
local course = workspace:WaitForChild("ObbyCourse")
local checkpoints = course:WaitForChild("Checkpoints")

local function spawnAtStage(player, char)
\tlocal stage = player:FindFirstChild("leaderstats") and player.leaderstats:FindFirstChild("Stage")
\tlocal cp = stage and checkpoints:FindFirstChild("Checkpoint" .. stage.Value)
\tif cp then
\t\tlocal hrp = char:WaitForChild("HumanoidRootPart")
\t\thrp.CFrame = cp.CFrame + Vector3.new(0, 5, 0)
\tend
end

Players.PlayerAdded:Connect(function(player)
\tlocal stats = Instance.new("Folder")
\tstats.Name = "leaderstats"
\tlocal stage = Instance.new("IntValue")
\tstage.Name = "Stage"
\tstage.Value = 0
\tstage.Parent = stats
\tstats.Parent = player
\tplayer.CharacterAdded:Connect(function(char)
\t\ttask.wait()
\t\tspawnAtStage(player, char)
\tend)
end)

for _, cp in ipairs(checkpoints:GetChildren()) do
\tcp.Touched:Connect(function(hit)
\t\tlocal player = Players:GetPlayerFromCharacter(hit.Parent)
\t\tif not player then return end
\t\tlocal stage = player.leaderstats.Stage
\t\tlocal n = cp:GetAttribute("Stage") or 0
\t\tif n > stage.Value then stage.Value = n end
\tend)
end

for _, kb in ipairs(course:GetChildren()) do
\tif string.match(kb.Name, "^KillBrick") then
\t\tkb.Touched:Connect(function(hit)
\t\t\tlocal hum = hit.Parent and hit.Parent:FindFirstChildOfClass("Humanoid")
\t\t\tif hum then hum.Health = 0 end
\t\tend)
\tend
end`;

  const timerClient = `local RunService = game:GetService("RunService")
local label = script.Parent:WaitForChild("TimerLabel")
local startTime = os.clock()
RunService.RenderStepped:Connect(function()
\tlabel.Text = string.format("Time: %.1fs", os.clock() - startTime)
end)`;

  const body = `local NUM_CHECKPOINTS = ${checkpoints}
local course = ensure(Workspace, "ObbyCourse", "Folder")

local spawn = ensure(course, "SpawnLocation", "SpawnLocation")
spawn.Size = Vector3.new(12, 1, 12)
spawn.Position = Vector3.new(0, 5, 0)
spawn.Anchored = true

local checkpoints = ensure(course, "Checkpoints", "Folder")
for i = 0, NUM_CHECKPOINTS do
\tlocal cp = makePart(checkpoints, "Checkpoint" .. i, Vector3.new(10, 1, 10), Vector3.new(i * 40, 5, 0), Color3.fromRGB(80, 200, 120), true)
\tcp:SetAttribute("Stage", i)
\tif i > 0 then
\t\tmakePart(course, "KillBrick" .. i, Vector3.new(10, 1, 24), Vector3.new(i * 40 - 20, 5, 0), Color3.fromRGB(200, 60, 60), true)
\tend
end

makePart(course, "Finish", Vector3.new(14, 1, 14), Vector3.new((NUM_CHECKPOINTS + 1) * 40, 5, 0), Color3.fromRGB(255, 215, 0), true)

makeScript(ServerScriptService, "ObbyServer", [===[\n${obbyServer}\n]===])

local hud = ensure(StarterGui, "ObbyHud", "ScreenGui")
hud.ResetOnSpawn = false
local label = ensure(hud, "TimerLabel", "TextLabel")
label.Size = UDim2.new(0, 200, 0, 40)
label.Position = UDim2.new(0.5, -100, 0, 8)
label.BackgroundTransparency = 0.4
label.BackgroundColor3 = Color3.fromRGB(20, 20, 30)
label.TextColor3 = Color3.fromRGB(255, 255, 255)
label.Font = Enum.Font.GothamBold
label.TextScaled = true
label.Text = "Time: 0.0s"
makeScript(hud, "TimerClient", [===[\n${timerClient}\n]===], "LocalScript")

return { template = "obby", checkpoints = NUM_CHECKPOINTS, success = true }`;

  return blueprint(body);
}

// --- Simulator --------------------------------------------------------------

export interface SimulatorTemplateOptions {
  currencyName?: string;
}

export function buildSimulatorTemplateLuau(options: SimulatorTemplateOptions = {}): string {
  const currency = options.currencyName ?? 'Coins';

  const simServer = `local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local clickRemote = ReplicatedStorage:WaitForChild("ClickRemote")
local CURRENCY = ${luaString(currency)}

Players.PlayerAdded:Connect(function(player)
\tlocal stats = Instance.new("Folder")
\tstats.Name = "leaderstats"
\tlocal money = Instance.new("IntValue")
\tmoney.Name = CURRENCY
\tmoney.Value = 0
\tmoney.Parent = stats
\tstats.Parent = player
end)

clickRemote.OnServerEvent:Connect(function(player)
\tlocal stats = player:FindFirstChild("leaderstats")
\tlocal money = stats and stats:FindFirstChild(CURRENCY)
\tif money then money.Value += 1 end
end)`;

  const clickClient = `local ReplicatedStorage = game:GetService("ReplicatedStorage")
local clickRemote = ReplicatedStorage:WaitForChild("ClickRemote")
local button = script.Parent:WaitForChild("ClickButton")
button.Activated:Connect(function()
\tclickRemote:FireServer()
end)`;

  const dataModule = `-- Placeholder data module. Swap in DataStoreService-backed
-- persistence here. Returns a table of per-player default data.
return {
\tdefaults = {
\t\t[${luaString(currency)}] = 0,
\t},
}`;

  const body = `ensure(ReplicatedStorage, "ClickRemote", "RemoteEvent")

makeScript(ServerScriptService, "SimulatorServer", [===[\n${simServer}\n]===])

local hud = ensure(StarterGui, "SimulatorHud", "ScreenGui")
hud.ResetOnSpawn = false
local button = ensure(hud, "ClickButton", "TextButton")
button.Size = UDim2.new(0, 220, 0, 80)
button.Position = UDim2.new(0.5, -110, 1, -110)
button.AnchorPoint = Vector2.new(0, 0)
button.BackgroundColor3 = Color3.fromRGB(70, 160, 255)
button.TextColor3 = Color3.fromRGB(255, 255, 255)
button.Font = Enum.Font.GothamBold
button.TextScaled = true
button.Text = "Click to earn ${currency}!"
makeScript(hud, "ClickClient", [===[\n${clickClient}\n]===], "LocalScript")

local shop = ensure(ReplicatedStorage, "Shop", "Folder")
ensure(shop, "Items", "Folder")

makeScript(ServerStorage, "DataModule", [===[\n${dataModule}\n]===], "ModuleScript")

return { template = "simulator", currency = ${luaString(currency)}, success = true }`;

  return blueprint(body);
}

// --- Tycoon -----------------------------------------------------------------

export interface TycoonTemplateOptions {
  startingCash?: number;
  buttonPrice?: number;
}

export function buildTycoonTemplateLuau(options: TycoonTemplateOptions = {}): string {
  const startingCash = options.startingCash ?? 0;
  const buttonPrice = options.buttonPrice ?? 50;

  const tycoonServer = `local Players = game:GetService("Players")
local plot = workspace:WaitForChild("Tycoons"):WaitForChild("Plot1")
local buttons = plot:WaitForChild("Buttons")

Players.PlayerAdded:Connect(function(player)
\tlocal stats = Instance.new("Folder")
\tstats.Name = "leaderstats"
\tlocal cash = Instance.new("IntValue")
\tcash.Name = "Cash"
\tcash.Value = ${startingCash}
\tcash.Parent = stats
\tstats.Parent = player
end)

local function purchase(button, player)
\tlocal cash = player:FindFirstChild("leaderstats") and player.leaderstats:FindFirstChild("Cash")
\tlocal price = button:GetAttribute("Price") or 0
\tif cash and cash.Value >= price then
\t\tcash.Value -= price
\t\tbutton.Transparency = 1
\t\tbutton.CanCollide = false
\t\tlocal dropper = plot:FindFirstChild("Dropper1")
\t\tif not dropper then
\t\t\tlocal d = Instance.new("Part")
\t\t\td.Name = "Dropper1"
\t\t\td.Anchored = true
\t\t\td.Size = Vector3.new(4, 4, 4)
\t\t\td.Position = button.Position + Vector3.new(0, 4, 0)
\t\t\td.Color = Color3.fromRGB(120, 200, 255)
\t\t\td.Parent = plot
\t\tend
\tend
end

for _, button in ipairs(buttons:GetChildren()) do
\tlocal prompt = button:FindFirstChildOfClass("ProximityPrompt")
\tif prompt then
\t\tprompt.Triggered:Connect(function(player) purchase(button, player) end)
\tend
\tbutton.Touched:Connect(function(hit)
\t\tlocal player = Players:GetPlayerFromCharacter(hit.Parent)
\t\tif player then purchase(button, player) end
\tend)
end`;

  const body = `local PLOT_PRICE = ${buttonPrice}
local tycoons = ensure(Workspace, "Tycoons", "Folder")
local plot = ensure(tycoons, "Plot1", "Model")

makePart(plot, "Base", Vector3.new(48, 1, 48), Vector3.new(0, 1, 0), Color3.fromRGB(90, 90, 90), true)

local buttons = ensure(plot, "Buttons", "Folder")
local button = makePart(buttons, "Button1", Vector3.new(4, 1, 4), Vector3.new(12, 2, 12), Color3.fromRGB(80, 200, 80), true)
button:SetAttribute("Price", PLOT_PRICE)
local prompt = ensure(button, "PurchasePrompt", "ProximityPrompt")
prompt.ActionText = "Buy (" .. PLOT_PRICE .. " Cash)"
prompt.ObjectText = "Dropper"
prompt.HoldDuration = 0.2

makeScript(ServerScriptService, "TycoonServer", [===[\n${tycoonServer}\n]===])

return { template = "tycoon", buttonPrice = PLOT_PRICE, success = true }`;

  return blueprint(body);
}

// --- Round-based ------------------------------------------------------------

export interface RoundTemplateOptions {
  roundSeconds?: number;
  intermissionSeconds?: number;
  teleportPoints?: number;
}

export function buildRoundTemplateLuau(options: RoundTemplateOptions = {}): string {
  const roundSeconds = options.roundSeconds ?? 90;
  const intermission = options.intermissionSeconds ?? 15;
  const teleportPoints = options.teleportPoints && options.teleportPoints > 0 ? Math.floor(options.teleportPoints) : 4;

  const roundServer = `local Players = game:GetService("Players")
local arena = workspace:WaitForChild("Arena")
local teleports = arena:WaitForChild("TeleportPoints")
local lobby = workspace:WaitForChild("Lobby"):WaitForChild("LobbySpawn")
local ROUND_SECONDS = ${roundSeconds}
local INTERMISSION_SECONDS = ${intermission}

local status = Instance.new("StringValue")
status.Name = "RoundStatus"
status.Parent = game:GetService("ReplicatedStorage")

local function teleportToArena()
\tlocal points = teleports:GetChildren()
\tif #points == 0 then return end
\tlocal idx = 1
\tfor _, player in ipairs(Players:GetPlayers()) do
\t\tlocal char = player.Character
\t\tlocal hrp = char and char:FindFirstChild("HumanoidRootPart")
\t\tif hrp then
\t\t\thrp.CFrame = points[idx].CFrame + Vector3.new(0, 5, 0)
\t\t\tidx = (idx % #points) + 1
\t\tend
\tend
end

local function teleportToLobby()
\tfor _, player in ipairs(Players:GetPlayers()) do
\t\tlocal char = player.Character
\t\tlocal hrp = char and char:FindFirstChild("HumanoidRootPart")
\t\tif hrp then hrp.CFrame = lobby.CFrame + Vector3.new(0, 5, 0) end
\tend
end

while true do
\tstatus.Value = "Intermission"
\ttask.wait(INTERMISSION_SECONDS)
\tif #Players:GetPlayers() > 0 then
\t\tstatus.Value = "Round in progress"
\t\tteleportToArena()
\t\ttask.wait(ROUND_SECONDS)
\t\tteleportToLobby()
\tend
end`;

  const body = `local ROUND_SECONDS = ${roundSeconds}
local NUM_TELEPORTS = ${teleportPoints}

local lobby = ensure(Workspace, "Lobby", "Model")
local lobbySpawn = ensure(lobby, "LobbySpawn", "SpawnLocation")
lobbySpawn.Size = Vector3.new(40, 1, 40)
lobbySpawn.Position = Vector3.new(0, 5, 0)
lobbySpawn.Anchored = true
lobbySpawn.Neutral = true

local arena = ensure(Workspace, "Arena", "Model")
makePart(arena, "ArenaFloor", Vector3.new(120, 1, 120), Vector3.new(300, 5, 0), Color3.fromRGB(110, 110, 120), true)
local teleports = ensure(arena, "TeleportPoints", "Folder")
for i = 1, NUM_TELEPORTS do
\tlocal angle = (i / NUM_TELEPORTS) * math.pi * 2
\tlocal tp = makePart(teleports, "Teleport" .. i, Vector3.new(6, 1, 6), Vector3.new(300 + math.cos(angle) * 40, 6, math.sin(angle) * 40), Color3.fromRGB(120, 120, 255), true)
\ttp.Transparency = 0.5
end

makeScript(ServerScriptService, "RoundServer", [===[\n${roundServer}\n]===])

return { template = "round", roundSeconds = ROUND_SECONDS, teleportPoints = NUM_TELEPORTS, success = true }`;

  return blueprint(body);
}
