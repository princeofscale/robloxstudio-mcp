// Cross-DM stop_playtest signaling via plugin:SetSetting, scoped by
// per-instance setting key so the same Studio process can host playtests
// for multiple places without one place's stop_playtest yanking another's.
//
// `plugin:SetSetting` / `plugin:GetSetting` is a per-plugin persistent store
// shared across every DataModel the plugin runs in (edit DMs, play-server
// DMs, play-client DMs). For each connected place we use a dedicated key
// "MCP_STOP_PLAY_<instanceId>" as a single-bit mailbox:
//
//   * The edit DM's stopPlaytest handler writes `true` into its own key
//     (computed from its placeId / ServerStorage anon UUID).
//   * Each play-server DM's monitor loop polls the key matching its own
//     instanceId at 0.1Hz; on `true` it clears the key and calls
//     StudioTestService:EndTest. Play-server DMs for other places never
//     touch this key.
//   * The edit DM waits up to ~8s for its key to be cleared, confirming a
//     matching play-server actually consumed the request.
//
// Earlier versions used a single shared boolean flag, which let any
// play-server DM in the same Studio process consume any place's stop
// request — silently yanking teammates' playtests. The per-key scoping
// below is the fix.

import { HttpService, ServerStorage } from "@rbxts/services";

const StudioTestService = game.GetService("StudioTestService");

const SETTING_KEY_PREFIX = "MCP_STOP_PLAY_";
// Monitor checks the key at this cadence. 0.1s keeps worst-case detection
// lag tight so the consumption-confirmation window doesn't have to absorb
// polling jitter on top of EndTest's teardown time.
const POLL_INTERVAL_SEC = 0.1;
// Total time we wait for the matching play-server DM to consume the
// signal. Must cover: monitor detection (<= POLL_INTERVAL_SEC) +
// StudioTestService:EndTest teardown (several seconds on heavier places).
// 8s is comfortable; the tighter poll above keeps real cases well under.
const WAIT_FOR_CONSUMPTION_TIMEOUT_SEC = 8.0;
const WAIT_POLL_SEC = 0.1;

let pluginRef: Plugin | undefined;

function init(p: Plugin): void {
	pluginRef = p;
}

// Mirror of Communication.computeInstanceId(). Duplicated here because
// StopPlayMonitor runs in both edit and play-server DMs, and both must
// agree on the place identifier (published places: placeId; unpublished:
// UUID on ServerStorage's __MCPPlaceId attribute, travels with the .rbxl
// into the play DM).
function computeInstanceId(): string {
	if (game.PlaceId !== 0) {
		return `place:${tostring(game.PlaceId)}`;
	}
	const existing = ServerStorage.GetAttribute("__MCPPlaceId");
	if (typeIs(existing, "string") && existing !== "") {
		return `anon:${existing as string}`;
	}
	const fresh = HttpService.GenerateGUID(false);
	pcall(() => ServerStorage.SetAttribute("__MCPPlaceId", fresh));
	return `anon:${fresh}`;
}

function settingKey(instanceId: string): string {
	return SETTING_KEY_PREFIX + instanceId;
}

function startMonitor(): void {
	if (!pluginRef) {
		warn("[MCP] StopPlayMonitor.startMonitor called before init; skipping");
		return;
	}
	const myKey = settingKey(computeInstanceId());
	// Clear any stale value left from a prior session. If a real stop
	// request is in-flight when this runs, the requesting edit DM will
	// write again within its consumption-confirmation window.
	pcall(() => pluginRef!.SetSetting(myKey, false));
	task.spawn(() => {
		while (true) {
			const [okGet, val] = pcall(() => pluginRef!.GetSetting(myKey));
			if (okGet && val === true) {
				// Consume the flag first so requestStop's
				// waitForConsumption returns success, then end the test.
				pcall(() => pluginRef!.SetSetting(myKey, false));
				pcall(() => StudioTestService.EndTest("stopped_by_mcp"));
			}
			task.wait(POLL_INTERVAL_SEC);
		}
	});
}

function requestStop(): boolean {
	if (!pluginRef) return false;
	const myKey = settingKey(computeInstanceId());
	const [ok] = pcall(() => pluginRef!.SetSetting(myKey, true));
	return ok;
}

function waitForConsumption(): boolean {
	if (!pluginRef) return false;
	const myKey = settingKey(computeInstanceId());
	const start = tick();
	while (tick() - start < WAIT_FOR_CONSUMPTION_TIMEOUT_SEC) {
		const [okGet, val] = pcall(() => pluginRef!.GetSetting(myKey));
		if (okGet && val !== true) return true;
		task.wait(WAIT_POLL_SEC);
	}
	return false;
}

function clearPending(): void {
	if (!pluginRef) return;
	const myKey = settingKey(computeInstanceId());
	pcall(() => pluginRef!.SetSetting(myKey, false));
}

export = {
	init,
	startMonitor,
	requestStop,
	waitForConsumption,
	clearPending,
};
