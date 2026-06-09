// Game-VM eval bridges, ported from chrrxs/roblox-mcp-primitives.
//
// Our standard `execute_luau target=server/client-N` runs in the plugin VM
// with a fresh ModuleScript per call. That gives a clean sandbox but means
// `require(SomeModule)` returns a fresh copy, not the one the running game
// scripts hold. So runtime-mutated module state is invisible to probes.
//
// These bridges fix that by living inside the user's game scripts. Both
// peers use the same symmetric shape:
//   - Server: a Script in ServerScriptService that creates a BindableFunction.
//     Plugin (server peer) invokes it with a fresh ModuleScript payload;
//     require() runs inside the Script VM so it shares the running server's
//     require cache.
//   - Client: a LocalScript in StarterPlayer.StarterPlayerScripts that
//     creates a BindableFunction. Plugin invokes it with a fresh ModuleScript
//     payload; require() runs inside the LocalScript VM so it shares the
//     game's require cache.
//
// Why ModuleScript+require on both sides (no loadstring): require'd modules
// run with the security level they were created at and don't need
// ServerScriptService.LoadStringEnabled, so eval_server_runtime works even
// when LoadStringEnabled=false (the default in fresh places).
//
// Lifecycle: the bridges live PERMANENTLY in the edit DM. Communication
// installs them (ensureBridgesInstalled) when the plugin connects in edit,
// and TestHandlers.startPlaytest force-refreshes them right before
// ExecutePlayModeAsync. ExecutePlayModeAsync clones the DataModel into the
// play DMs, so the scripts come along and run there. We keep them in the edit
// DM after a playtest ends (rather than cleaning up) so that a playtest the
// dev starts MANUALLY via the Studio Play button — not the MCP start_playtest
// tool — also gets the bridges cloned in. This is intentionally a little
// intrusive (two helper scripts visible in Explorer) in exchange for a
// zero-roundtrip eval_*_runtime experience for devs working 1:1 with an agent.
//
// Archivable handling: ExecutePlayModeAsync's deep-clone SKIPS instances
// with Archivable=false (verified empirically in v2.9.0 testing - bridges
// never reached the play DMs because we'd set them to false). We now keep
// Archivable=true so the clone works, and rely on cleanupBridges() to
// remove the scripts from the edit DM when the test ends. The only failure
// mode is the user saving DURING an active playtest, which would persist
// the bridges to the .rbxl - that's a no-op next session because
// installBridges() always calls cleanupBridges() first to clear stale
// instances. The RemoteFunction/BindableFunction that the bridge scripts
// CREATE at runtime stay Archivable=false (they're runtime-only and should
// never appear in a save).

import { ServerScriptService, StarterPlayer } from "@rbxts/services";

const ScriptEditorService = game.GetService("ScriptEditorService");

function getStarterPlayerScripts(): Instance | undefined {
	return StarterPlayer.FindFirstChild("StarterPlayerScripts");
}

const SERVER_SCRIPT_NAME = "__MCP_ServerEvalBridge";
const CLIENT_SCRIPT_NAME = "__MCP_ClientEvalBridge";

// Public so the eval_*_runtime tool wrappers can reference the same names.
export const BRIDGE_NAMES = {
	serverScript: SERVER_SCRIPT_NAME,
	clientScript: CLIENT_SCRIPT_NAME,
	serverLocal: "__MCP_ServerEvalLocal",
	clientLocal: "__MCP_ClientEvalBridge",
} as const;

// Embedded Luau. The double `${...}` references our exported names so a
// rename here propagates to both the script source and the tool wrappers.
const SERVER_BRIDGE_SOURCE = `
-- Installed by @chrrxs/robloxstudio-mcp to power the eval_server_runtime MCP
-- tool (shared-require-cache eval on the server during playtests). Inert
-- outside Studio (no-ops in live games); safe to leave in place.

local ServerScriptService = game:GetService("ServerScriptService")
local RunService = game:GetService("RunService")

if not RunService:IsStudio() then
	return
end

local prevBf = ServerScriptService:FindFirstChild("${BRIDGE_NAMES.serverLocal}")
if prevBf then prevBf:Destroy() end

local bf = Instance.new("BindableFunction")
bf.Name = "${BRIDGE_NAMES.serverLocal}"
bf.Archivable = false
bf.Parent = ServerScriptService
bf.OnInvoke = function(payload)
	if typeof(payload) ~= "Instance" or not payload:IsA("ModuleScript") then
		return { ok = false, value = "payload must be a ModuleScript instance" }
	end
	local ok, value = pcall(require, payload)
	return { ok = ok, value = value }
end
`;

const CLIENT_BRIDGE_SOURCE = `
-- Installed by @chrrxs/robloxstudio-mcp to power the eval_client_runtime MCP
-- tool (shared-require-cache eval on the client during playtests). Inert
-- outside Studio (no-ops in live games); safe to leave in place.

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")

if not RunService:IsStudio() then
	return
end

local prevBf = ReplicatedStorage:FindFirstChild("${BRIDGE_NAMES.clientLocal}")
if prevBf then prevBf:Destroy() end

local bf = Instance.new("BindableFunction")
bf.Name = "${BRIDGE_NAMES.clientLocal}"
bf.Archivable = false
bf.Parent = ReplicatedStorage
bf.OnInvoke = function(payload)
	if typeof(payload) ~= "Instance" or not payload:IsA("ModuleScript") then
		return { ok = false, value = "payload must be a ModuleScript instance" }
	end
	local ok, value = pcall(require, payload)
	return { ok = ok, value = value }
end
`;

// Stamp written onto each installed bridge Script so we can tell whether the
// bridge currently in the DM was produced by THIS plugin build. It's a djb2
// hash of the actual bridge source plus the plugin version, so ANY change to
// the source (or a version bump) yields a new stamp — which makes
// ensureBridgesInstalled() force a refresh on the next plugin load instead of
// keeping a stale bridge that happens to still be present (e.g. one saved into
// the .rbxl from an older build).
const STAMP_ATTR = "__MCPBridgeStamp";

function computeBridgeStamp(): string {
	const combined = `${SERVER_BRIDGE_SOURCE}|${CLIENT_BRIDGE_SOURCE}`;
	let h = 5381;
	for (let i = 1; i <= combined.size(); i++) {
		h = (h * 33 + string.byte(combined, i)[0]) % 2147483647;
	}
	// "__VERSION__" is replaced with the package version at package time
	// (scripts/build-plugin.mjs injectVersion), so a release bump also restamps.
	return `${tostring(h)}-__VERSION__`;
}

const BRIDGE_STAMP = computeBridgeStamp();

function setSource(scriptInst: Script | LocalScript, source: string): void {
	// ScriptEditorService is the cleaner API and integrates with Studio's
	// edit history; fall back to direct Source mutation (allowed in plugin
	// context with PluginSecurity) if the edit service rejects the call.
	const [seOk] = pcall(() => {
		ScriptEditorService.UpdateSourceAsync(scriptInst, () => source);
	});
	if (!seOk) {
		(scriptInst as unknown as { Source: string }).Source = source;
	}
}

function findBridges(): { server?: Instance; client?: Instance } {
	const sps = getStarterPlayerScripts();
	return {
		server: ServerScriptService.FindFirstChild(SERVER_SCRIPT_NAME),
		client: sps ? sps.FindFirstChild(CLIENT_SCRIPT_NAME) : undefined,
	};
}

export function cleanupBridges(): void {
	const { server, client } = findBridges();
	if (server) {
		pcall(() => server.Destroy());
	}
	if (client) {
		pcall(() => client.Destroy());
	}
}

// Idempotent variant: install only if the bridge scripts aren't already
// present in the edit DM. Used to keep the bridges always available (so a
// playtest the dev starts manually — not via the MCP start_playtest tool —
// still clones them into the play DMs). Cheap no-op when already installed,
// which avoids re-dirtying the place on every plugin reconnect.
export function ensureBridgesInstalled(): { installed: boolean; error?: string } {
	const { server, client } = findBridges();
	if (server && client) {
		// Both present — but only skip the reinstall if they were produced by
		// THIS build. A mismatched/absent stamp means a stale bridge (older
		// plugin, or one persisted in the saved place), so force a refresh.
		const sStamp = server.GetAttribute(STAMP_ATTR);
		const cStamp = client.GetAttribute(STAMP_ATTR);
		if (sStamp === BRIDGE_STAMP && cStamp === BRIDGE_STAMP) {
			return { installed: true };
		}
	}
	return installBridges();
}

export function installBridges(): { installed: boolean; error?: string } {
	// Defensive: clear any stale bridges from a prior unclean exit before
	// inserting fresh. The injected script also self-cleans its
	// ReplicatedStorage/ServerScriptService children at startup, but the
	// containing Script/LocalScript objects themselves we must clear here.
	cleanupBridges();

	const [ok, err] = pcall(() => {
		const serverScript = new Instance("Script");
		serverScript.Name = SERVER_SCRIPT_NAME;
		// Archivable=true so ExecutePlayModeAsync's deep-clone includes the
		// script. cleanupBridges() removes it from the edit DM when the
		// playtest ends.
		setSource(serverScript, SERVER_BRIDGE_SOURCE);
		serverScript.SetAttribute(STAMP_ATTR, BRIDGE_STAMP);
		serverScript.Parent = ServerScriptService;

		const sps = getStarterPlayerScripts();
		if (!sps) {
			error("StarterPlayer.StarterPlayerScripts not found - cannot install client eval bridge");
		}
		const clientScript = new Instance("LocalScript");
		clientScript.Name = CLIENT_SCRIPT_NAME;
		setSource(clientScript, CLIENT_BRIDGE_SOURCE);
		clientScript.SetAttribute(STAMP_ATTR, BRIDGE_STAMP);
		clientScript.Parent = sps;
	});

	if (!ok) {
		return { installed: false, error: tostring(err) };
	}
	return { installed: true };
}
