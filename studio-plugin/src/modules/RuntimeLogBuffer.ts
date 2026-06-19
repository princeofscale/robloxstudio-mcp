// Per-capture in-memory ring buffer for LogService.MessageOut events.
// Powers the get_runtime_logs MCP tool. Replaces the out-of-tree LogBuffer
// primitives + StringValue approach from chrrxs/roblox-mcp-primitives.
//
// Each peer's plugin attaches a MessageOut listener at plugin load (edit DM,
// play-server DM, play-client DM all run their own copy of this module).
// Captured entries live in plugin module-state; nothing is parented to the
// DataModel. The buffer is bounded by a message-byte budget; oldest entries
// drop when over budget.
//
// Capture caveat: returned entries reflect which plugin buffer CAPTURED the
// entry, NOT which peer's script originated the print. LogService reflects
// prints across peers in ordinary Studio Play (a server print can appear in
// server and client LogService:GetLogHistory()). The MCP-side aggregator
// exposes that as capturedBy, and only promotes it to origin peer in
// StudioTestService multiplayer sessions where peer attribution is reliable.

import { LogService, RunService } from "@rbxts/services";

type LogLevel = "OUT" | "WARN" | "ERR" | "INFO";

interface RuntimeLogEntry {
	seq: number;
	ts: number; // wall-clock seconds via DateTime, coherent across peers
	level: LogLevel;
	message: string;
}

const MAX_BYTES = 64 * 1024;
const HARD_ENTRY_CAP = 50_000;

const entries: RuntimeLogEntry[] = [];
let totalBytes = 0;
let totalDropped = 0;
let nextSeq = 1;
let installed = false;

function levelTag(t: Enum.MessageType): LogLevel {
	if (t === Enum.MessageType.MessageWarning) return "WARN";
	if (t === Enum.MessageType.MessageError) return "ERR";
	if (t === Enum.MessageType.MessageInfo) return "INFO";
	return "OUT";
}

function nowSec(): number {
	return DateTime.now().UnixTimestampMillis / 1000;
}

function dropOldestUntilFits(incomingBytes: number): void {
	while (
		entries.size() > 0 &&
		(totalBytes + incomingBytes > MAX_BYTES || entries.size() >= HARD_ENTRY_CAP)
	) {
		const dropped = entries.shift()!;
		totalBytes -= dropped.message.size();
		totalDropped += 1;
	}
}

function pushEntry(message: string, level: LogLevel, ts: number): void {
	const bytes = message.size();
	dropOldestUntilFits(bytes);
	entries.push({ seq: nextSeq, ts, level, message });
	nextSeq += 1;
	totalBytes += bytes;
}

// Backfill the buffer with logs already emitted before this listener attached.
// In ordinary Studio Play the server/client DMs start (and print, e.g. a game's
// startup banner) before the plugin peer's MessageOut listener connects, so those
// entries were lost (bug B8). GetLogHistory recovers them on install.
function seedFromHistory(): void {
	const [ok, history] = pcall(() => LogService.GetLogHistory());
	if (!ok || !history) return;
	for (const info of history as Array<{ message: string; messageType: Enum.MessageType; timestamp: number }>) {
		if (info && typeIs(info.message, "string")) {
			pushEntry(info.message, levelTag(info.messageType), info.timestamp ?? nowSec());
		}
	}
}

function install(): void {
	if (installed) return;
	if (!RunService.IsStudio()) return;
	installed = true;
	seedFromHistory();
	LogService.MessageOut.Connect((msg, t) => {
		pushEntry(msg, levelTag(t), nowSec());
	});
}

function detectPeer(): "edit" | "server" | "client" {
	if (!RunService.IsRunning()) return "edit";
	if (RunService.IsServer()) return "server";
	return "client";
}

interface QueryOptions {
	since?: number;
	tail?: number;
	filter?: string; // Plain substring match, applied to message
}

interface QueryResult {
	capturedBy: string;
	entries: RuntimeLogEntry[];
	totalDropped: number;
	nextSince: number;
}

function query(opts: QueryOptions, capturedBy: string): QueryResult {
	let result = opts.since !== undefined
		? entries.filter((e) => e.seq > (opts.since as number))
		: [...entries];

	if (opts.filter !== undefined) {
		// Plain substring search (4th arg = true). Pattern matching here was
		// surprising in practice - Lua magic chars in messages would silently
		// not match (e.g. filter="MARK-EDIT" against "MARK-EDIT-001" fails
		// because '-' means "0+" in Lua patterns). Substring search matches
		// most users' mental model of "filter messages containing this text".
		const needle = opts.filter;
		result = result.filter((e) => {
			const [start] = string.find(e.message, needle, 1, true);
			return start !== undefined;
		});
	}

	if (opts.tail !== undefined && result.size() > opts.tail) {
		// roblox-ts arrays don't expose .slice; manual tail copy.
		const tailed: RuntimeLogEntry[] = [];
		const start = result.size() - opts.tail;
		for (let i = start; i < result.size(); i++) {
			tailed.push(result[i]);
		}
		result = tailed;
	}

	const last = entries.size() > 0 ? entries[entries.size() - 1] : undefined;
	return {
		capturedBy,
		entries: result,
		totalDropped,
		nextSince: last ? last.seq : (opts.since ?? 0),
	};
}

export = {
	install,
	detectPeer,
	query,
};
