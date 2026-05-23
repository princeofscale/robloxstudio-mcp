import { HttpService, Players, ReplicatedStorage, RunService } from "@rbxts/services";

// The client peer cannot reach the MCP HTTP server - Roblox forbids
// HttpService:RequestAsync from the client DM even under PluginSecurity, and
// HttpEnabled reads as false there regardless of identity. So the server peer
// brokers execute_luau requests to the client via a RemoteFunction it places
// in ReplicatedStorage; each player gets a proxy "client" registration on the
// MCP side, polled and dispatched by the server peer.
//
// The same server peer also registers an "edit" proxy that intercepts
// /api/stop-playtest specifically - StudioTestService:EndTest only works from
// the play server DM, so the real edit DM cannot satisfy stop requests on its
// own. MCP returns the same pending request to multiple pollers until someone
// /responds, so non-stop edit-targeted requests fall through to the actual
// edit DM untouched.

const MCP_URL = "http://localhost:58741";
const BROKER_NAME = "__MCPClientBroker";

interface ProxyEntry {
	instanceId: string;
	role: string;
}

interface ExecutePayload {
	code?: string;
}

interface ExecuteResult {
	success: boolean;
	returnValue?: string;
	message?: string;
	error?: string;
}

interface ReadyResponseBody {
	assignedRole?: string;
}

interface PollResponseBody {
	requestId?: string;
	request?: {
		endpoint: string;
		data?: Record<string, unknown>;
	};
}

function forkRole(): "edit" | "server" | "client" {
	if (!RunService.IsRunning()) return "edit";
	if (RunService.IsServer()) return "server";
	return "client";
}

function postJson(endpoint: string, body: Record<string, unknown>) {
	return pcall(() =>
		HttpService.RequestAsync({
			Url: `${MCP_URL}${endpoint}`,
			Method: "POST",
			Headers: { "Content-Type": "application/json" },
			Body: HttpService.JSONEncode(body),
		}),
	);
}

function setupClientBroker() {
	const rf = ReplicatedStorage.WaitForChild(BROKER_NAME, 10);
	if (!rf || !rf.IsA("RemoteFunction")) {
		warn(`[MCPFork] client: ${BROKER_NAME} not found`);
		return;
	}
	rf.OnClientInvoke = (payload: ExecutePayload | undefined) => {
		const code = payload && payload.code;
		if (typeIs(code, "string") === false || code === "") {
			return identity<ExecuteResult>({ success: false, error: "code is required" });
		}
		const m = new Instance("ModuleScript");
		m.Name = "__MCPClientEval";
		const [okSet, setErr] = pcall(() => {
			(m as unknown as { Source: string }).Source = code as string;
		});
		if (!okSet) {
			m.Destroy();
			return identity<ExecuteResult>({ success: false, error: `Source set failed: ${tostring(setErr)}` });
		}
		m.Parent = game.Workspace;
		const [okReq, result] = pcall(() => require(m));
		m.Destroy();
		if (okReq) {
			return identity<ExecuteResult>({
				success: true,
				returnValue: result !== undefined ? tostring(result) : undefined,
				message: "Code executed successfully",
			});
		}
		return identity<ExecuteResult>({ success: false, error: tostring(result) });
	};
	print("[MCPFork] client broker ready");
}

const proxyByPlayer = new Map<Player, ProxyEntry>();

function pollProxy(proxyId: string, player: Player, rf: RemoteFunction) {
	while (player.Parent !== undefined && proxyByPlayer.has(player)) {
		const [ok, res] = pcall(() =>
			HttpService.RequestAsync({
				Url: `${MCP_URL}/poll?instanceId=${proxyId}`,
				Method: "GET",
				Headers: { "Content-Type": "application/json" },
			}),
		);
		if (ok && res && (res.Success || res.StatusCode === 503)) {
			const [okJson, body] = pcall(() => HttpService.JSONDecode(res.Body) as PollResponseBody);
			if (okJson && body && body.request && body.requestId !== undefined) {
				const request = body.request;
				let response: unknown;
				if (request.endpoint === "/api/execute-luau") {
					const [okInvoke, invokeRes] = pcall(() => rf.InvokeClient(player, request.data));
					if (okInvoke) {
						response = invokeRes !== undefined ? invokeRes : { success: false, error: "nil response" };
					} else {
						response = { success: false, error: `InvokeClient failed: ${tostring(invokeRes)}` };
					}
				} else {
					response = { error: `Client-proxy only supports /api/execute-luau, got: ${tostring(request.endpoint)}` };
				}
				postJson("/response", { requestId: body.requestId, response });
			}
		}
		task.wait(0.5);
	}
}

function registerProxy(player: Player, rf: RemoteFunction) {
	if (proxyByPlayer.has(player)) return;
	const proxyId = HttpService.GenerateGUID(false);
	const [ok, res] = postJson("/ready", { instanceId: proxyId, role: "client" });
	if (!ok || !res || !res.Success) {
		warn(`[MCPFork] proxy register failed for ${player.Name}`);
		return;
	}
	const body = HttpService.JSONDecode(res.Body) as ReadyResponseBody;
	const assigned = body.assignedRole ?? "client";
	proxyByPlayer.set(player, { instanceId: proxyId, role: assigned });
	print(`[MCPFork] proxy ${assigned} -> ${player.Name}`);
	task.spawn(pollProxy, proxyId, player, rf);
}

function startEditProxyLoop() {
	task.spawn(() => {
		const proxyId = HttpService.GenerateGUID(false);
		const [ok, res] = postJson("/ready", { instanceId: proxyId, role: "edit" });
		if (!ok || !res || !res.Success) {
			warn("[MCPFork] edit-proxy register failed");
			return;
		}
		print("[MCPFork] edit-proxy ready (stop-playtest interceptor)");
		while (true) {
			const [okPoll, pollRes] = pcall(() =>
				HttpService.RequestAsync({
					Url: `${MCP_URL}/poll?instanceId=${proxyId}`,
					Method: "GET",
					Headers: { "Content-Type": "application/json" },
				}),
			);
			if (okPoll && pollRes && (pollRes.Success || pollRes.StatusCode === 503)) {
				const [okJson, body] = pcall(() => HttpService.JSONDecode(pollRes.Body) as PollResponseBody);
				if (
					okJson &&
					body &&
					body.request &&
					body.request.endpoint === "/api/stop-playtest" &&
					body.requestId !== undefined
				) {
					const sts = game.GetService("StudioTestService") as Instance & { EndTest(reason: string): void };
					const [endOk, endErr] = pcall(() => sts.EndTest("stopped_by_mcp"));
					const response = endOk
						? { success: true, message: "Playtest stopped via edit-proxy/EndTest" }
						: { success: false, error: `EndTest failed: ${tostring(endErr)}` };
					postJson("/response", { requestId: body.requestId, response });
				}
			}
			task.wait(0.15);
		}
	});
}

function setupServerBroker() {
	let rf = ReplicatedStorage.FindFirstChild(BROKER_NAME) as RemoteFunction | undefined;
	if (!rf) {
		rf = new Instance("RemoteFunction");
		rf.Name = BROKER_NAME;
		rf.Parent = ReplicatedStorage;
	}
	const broker = rf;
	Players.PlayerAdded.Connect((p) => registerProxy(p, broker));
	for (const p of Players.GetPlayers()) {
		task.spawn(registerProxy, p, broker);
	}
	Players.PlayerRemoving.Connect((p) => {
		const entry = proxyByPlayer.get(p);
		if (entry) {
			proxyByPlayer.delete(p);
			postJson("/disconnect", { instanceId: entry.instanceId });
		}
	});
	game.BindToClose(() => {
		for (const [, entry] of proxyByPlayer) {
			postJson("/disconnect", { instanceId: entry.instanceId });
		}
		proxyByPlayer.clear();
	});
	startEditProxyLoop();
	print("[MCPFork] server broker ready");
}

export = {
	MCP_URL,
	forkRole,
	setupClientBroker,
	setupServerBroker,
};
