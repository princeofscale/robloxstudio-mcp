/// <reference types="@rbxts/types/plugin" />

export interface Connection {
	port: number;
	serverUrl: string;
	isActive: boolean;
	pollInterval: number;
	lastPoll: number;
	consecutiveFailures: number;
	maxFailuresBeforeError: number;
	lastSuccessfulConnection: number;
	currentRetryDelay: number;
	maxRetryDelay: number;
	retryBackoffMultiplier: number;
	lastHttpOk: boolean;
	lastMcpOk: boolean;
	mcpWaitStartTime?: number;
	isPolling: boolean;
	heartbeatConnection?: RBXScriptConnection;
}

export interface RequestData {
	[key: string]: unknown;
}

export interface RequestPayload {
	endpoint: string;
	data?: RequestData;
}

export interface PollResponse {
	mcpConnected: boolean;
	serverVersion?: string;
	pluginVersion?: string;
	pluginVariant?: string;
	versionMismatch?: boolean;
	request?: RequestPayload;
	requestId?: string;
	// Server signals knownInstance=false when its in-memory instances map
	// doesn't contain our pluginSessionId (typically after an MCP process
	// restart). The plugin re-issues /ready when it sees this.
	knownInstance?: boolean;
}

export interface Job {
	id: string;
	status: "running" | "done" | "error" | "cancelled";
	startedAt: number;
	finishedAt?: number;
	success?: boolean;
	returnValue?: string;
	output?: string[];
	error?: string;
	message?: string;
	cancelled?: boolean;
	// Cooperative progress, reported by server-generated code via _G.__mcp.progress.
	progress?: number;
	total?: number;
	stage?: string;
}

export interface ReadyResponse {
	success: boolean;
	assignedRole?: string;
	instanceId?: string;
	serverVersion?: string;
	versionMismatch?: boolean;
	error?: string;
	message?: string;
}

declare global {
	function loadstring(code: string): LuaTuple<[(() => unknown) | undefined, string?]>;
}
