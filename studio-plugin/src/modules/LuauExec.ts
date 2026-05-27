/* eslint-disable */
// Shared execute_luau machinery for edit/server (MetadataHandlers.executeLuau)
// and the play-client peer (ClientBroker.handleExecuteLuau). Three things this
// module owns:
//
//   1. The IIFE wrapper that captures print/warn, runs user code in xpcall,
//      and always returns { ok, value, output } so the ModuleScript itself
//      always returns exactly one value (otherwise `print("hi")` with no
//      return would fail with "Module code did not return exactly one value").
//
//   2. The loadstring-then-ModuleScript-require fallback, with the parse-error
//      recovery hack that pulls the real diagnostic from LogService.
//
//   3. Return-value formatting: tables get HttpService:JSONEncode'd so the
//      caller sees `{"x":1,"y":2}` instead of `table: 0xaddr`; primitives
//      pass through tostring. The encode is pcall'd so cycles or
//      non-serializable values gracefully fall back to tostring.
//
// Before this module existed, the client peer used a stripped-down
// require-only execution path that lacked both the wrapper and the JSON
// formatting, producing two well-known papercuts:
//   - `print("hi")` (no return) failed with "Module code did not return..."
//   - Returning a table yielded `table: 0xaddr` instead of structured data.

const HttpService = game.GetService("HttpService");
const LogService = game.GetService("LogService");

interface WrapperResult {
	ok?: boolean;
	value?: unknown;
	output?: defined;
}

interface ExecuteResult {
	success: boolean;
	returnValue?: string;
	output?: string[];
	error?: string;
	message?: string;
}

const PAYLOAD_INSTANCE_NAME = "__MCPExecLuauPayload";
const PAYLOAD_PATH_PREFIX = `Workspace.${PAYLOAD_INSTANCE_NAME}:`;

// Number of lines the wrapper emits BEFORE the first line of user code.
// Used both inside the wrapper (Luau __mcp_LINE_OFFSET) and on the TS side
// (remapPayloadLines, for compile errors recovered from LogService) so user
// code errors report user-relative line numbers instead of the inflated
// "line 23" the wrapper would otherwise expose. If you reorder buildWrapper's
// prefix lines, update this constant — there's a self-check below.
const WRAPPER_LINE_OFFSET = 23;

// Count source lines so the wrapper can filter traceback frames that fall
// outside the user code range (the wrapper's own preamble/postamble lines).
function countLines(s: string): number {
	let n = 1;
	const size = s.size();
	for (let i = 1; i <= size; i++) {
		if (string.sub(s, i, i) === "\n") n++;
	}
	return n;
}

function buildWrapper(code: string): string {
	// If you reorder the prefix lines below, update WRAPPER_LINE_OFFSET to
	// match the number of lines emitted BEFORE the ${code} substitution.
	// The constant is mirrored inside the wrapper (__mcp_LINE_OFFSET) and
	// used by remapPayloadLines on the TS side.
	const userLines = countLines(code);
	return `return ((function()
\tlocal __mcp_traceback
\tlocal __mcp_remap
\tlocal __mcp_LINE_OFFSET = ${WRAPPER_LINE_OFFSET}
\tlocal __mcp_USER_LINES = ${userLines}
\tlocal __mcp_output = {}
\tlocal __mcp_real_print = print
\tlocal __mcp_real_warn = warn
\tlocal print = function(...)
\t\t__mcp_real_print(...)
\t\tlocal args = {...}
\t\tlocal parts = table.create(#args)
\t\tfor i, a in ipairs(args) do parts[i] = tostring(a) end
\t\ttable.insert(__mcp_output, table.concat(parts, "\\t"))
\tend
\tlocal warn = function(...)
\t\t__mcp_real_warn(...)
\t\tlocal args = {...}
\t\tlocal parts = table.create(#args)
\t\tfor i, a in ipairs(args) do parts[i] = tostring(a) end
\t\ttable.insert(__mcp_output, "[warn] " .. table.concat(parts, "\\t"))
\tend
\tlocal function __mcp_run()
${code}
\tend
\t__mcp_remap = function(s)
\t\t-- Two chunk-name formats can reference our payload:
\t\t--   * "Workspace.__MCPExecLuauPayload:N" — ModuleScript:require fallback path
\t\t--   * "[string \\"return ((function()...\\"]:N" — loadstring() (default in plugin)
\t\t-- Subtract LINE_OFFSET to get the user-relative number, then clamp.
\t\t-- Clamping matters for unclosed constructs ("local x = (") where the
\t\t-- parser keeps reading into wrapper postamble and reports a payload
\t\t-- line past user EOF. Without clamping the message says "user_code:49"
\t\t-- for one-line input, framing the wrapper as user code.
\t\tlocal function __mcp_user_line(payload_n)
\t\t\tlocal user_n = payload_n - __mcp_LINE_OFFSET
\t\t\tif user_n < 1 then return "1" end
\t\t\tif user_n > __mcp_USER_LINES then return tostring(__mcp_USER_LINES) .. " (at end of input)" end
\t\t\treturn tostring(user_n)
\t\tend
\t\ts = string.gsub(s, "__MCPExecLuauPayload:(%d+)", function(num)
\t\t\tlocal n = tonumber(num)
\t\t\tif n then return "user_code:" .. __mcp_user_line(n) end
\t\t\treturn "user_code:" .. num
\t\tend)
\t\ts = string.gsub(s, '%[string "[^"]+"%]:(%d+)', function(num)
\t\t\tlocal n = tonumber(num)
\t\t\tif n then return "user_code:" .. __mcp_user_line(n) end
\t\t\treturn "user_code:" .. num
\t\tend)
\t\treturn s
\tend
\t__mcp_traceback = function(err)
\t\tlocal raw = debug.traceback(tostring(err), 2)
\t\tlocal kept = {}
\t\tfor line in string.gmatch(raw, "[^\\n]+") do
\t\t\t-- Extract referenced line number (either chunk-name format).
\t\t\tlocal num_str = string.match(line, "__MCPExecLuauPayload:(%d+)")
\t\t\t\tor string.match(line, '%[string "[^"]+"%]:(%d+)')
\t\t\tlocal n = num_str and tonumber(num_str)
\t\t\t-- Strip the "in function '__mcp_run'" annotation before doing
\t\t\t-- any filtering, because user-code frames carry that suffix —
\t\t\t-- the entire user payload is hosted inside __mcp_run, so EVERY
\t\t\t-- user frame would otherwise match a naive "__mcp_" filter and
\t\t\t-- get dropped. Strip first, then apply filters.
\t\t\tline = (string.gsub(line, " in function '__mcp_run'", ""))
\t\t\tlocal skip = string.find(line, "MCPPlugin", 1, true)
\t\t\t\tor string.find(line, "__mcp_", 1, true)
\t\t\t\tor string.find(line, "in function 'xpcall'", 1, true)
\t\t\t-- Frame lines pointing at wrapper preamble/postamble (outside
\t\t\t-- user range) are wrapper internals — drop them. Lines without
\t\t\t-- a payload-chunk line number (the traceback header / engine
\t\t\t-- C frames) are kept; remap is a no-op for them.
\t\t\tif n and (n <= __mcp_LINE_OFFSET or n > __mcp_LINE_OFFSET + __mcp_USER_LINES) then
\t\t\t\tskip = true
\t\t\tend
\t\t\tif not skip then
\t\t\t\ttable.insert(kept, __mcp_remap(line))
\t\t\tend
\t\tend
\t\treturn table.concat(kept, "\\n")
\tend
\tlocal ok, errOrValue = xpcall(__mcp_run, __mcp_traceback)
\treturn { ok = ok, value = errOrValue, output = __mcp_output }
end)())`;
}

// TS-side mirror of the Lua __mcp_remap. Used by runViaModuleScript when
// pulling the real compile-error diagnostic out of LogService — that error
// references the payload module's line number directly, and never passes
// through the IIFE's runtime wrapper.
function remapPayloadLines(s: string, userLines: number): string {
	// Mirror of the Lua __mcp_remap inside the wrapper, for paths that
	// don't pass through the IIFE (compile errors recovered from
	// LogService, the immediate loadstring compileError surface). Same
	// two-format coverage plus the same clamp: unclosed user constructs
	// let the parser consume wrapper postamble, so the raw payload line
	// is sometimes well past user EOF — clamp to [1, userLines] and
	// annotate so the error doesn't say "user_code:49" for one-line input.
	const userLine = (payload: number): string => {
		const u = payload - WRAPPER_LINE_OFFSET;
		if (u < 1) return "1";
		if (u > userLines) return `${tostring(userLines)} (at end of input)`;
		return tostring(u);
	};
	let out = s;
	const [a] = string.gsub(out, "__MCPExecLuauPayload:(%d+)", (num: string) => {
		const n = tonumber(num);
		if (n !== undefined) return `user_code:${userLine(n)}`;
		return `user_code:${num}`;
	});
	out = a;
	const [b] = string.gsub(out, '%[string "[^"]+"%]:(%d+)', (num: string) => {
		const n = tonumber(num);
		if (n !== undefined) return `user_code:${userLine(n)}`;
		return `user_code:${num}`;
	});
	out = b;
	return out;
}

function runViaModuleScript(wrapped: string, userLines: number): WrapperResult {
	const m = new Instance("ModuleScript");
	m.Name = PAYLOAD_INSTANCE_NAME;
	const [okSet, setErr] = pcall(() => {
		(m as unknown as { Source: string }).Source = wrapped;
	});
	if (!okSet) {
		m.Destroy();
		// error(..., 0) suppresses the "user_MCPPlugin.rbxmx.MCPPlugin.modules.LuauExec:N:"
		// prefix that error() would otherwise prepend, keeping the visible
		// message focused on the user-actionable error rather than our path.
		error(`ModuleScript Source set failed: ${tostring(setErr)}`, 0);
	}
	m.Parent = game.GetService("Workspace");
	const [okReq, reqResult] = pcall(() => require(m));
	m.Destroy();
	if (!okReq) {
		let errMsg = tostring(reqResult);
		// pcall(require, m) collapses parse/compile failures into the canned
		// engine string. The real diagnostic was emitted to LogService on the
		// next engine frame — give it ~50ms to land then scan backward.
		if (errMsg === "Requested module experienced an error while loading") {
			task.wait(0.05);
			const hist = LogService.GetLogHistory();
			for (let i = hist.size() - 1; i >= 0; i--) {
				const e = hist[i];
				if (
					e.messageType === Enum.MessageType.MessageError &&
					string.sub(e.message, 1, PAYLOAD_PATH_PREFIX.size()) === PAYLOAD_PATH_PREFIX
				) {
					errMsg = e.message;
					break;
				}
			}
		}
		// Compile errors reference the payload module's line number directly
		// — remap + clamp to user-relative line numbers so `local x = 1 +`
		// reports :1: instead of :23:, and reports the clamp annotation
		// when the parser ran off the end of user code into wrapper code.
		error(remapPayloadLines(errMsg, userLines), 0);
	}
	return reqResult as unknown as WrapperResult;
}

function isLoadstringUnavailable(err: unknown): boolean {
	const errStr = tostring(err);
	const [matchStart] = string.find(errStr, "not available", 1, true);
	return matchStart !== undefined;
}

// Returns a string suitable for `returnValue`. Tables get JSON-encoded so
// the caller sees structured data instead of "table: 0xaddr". Anything that
// JSONEncode chokes on (cycles, Roblox userdata) falls back to tostring.
function formatReturnValue(value: unknown): string {
	if (value === undefined) return "";
	if (typeIs(value, "table")) {
		const [ok, encoded] = pcall(() => HttpService.JSONEncode(value));
		if (ok) return encoded as string;
	}
	return tostring(value);
}

function execute(code: string): ExecuteResult {
	if (!code || code === "") {
		return { success: false, error: "code is required" };
	}
	const wrapped = buildWrapper(code);
	const userLines = countLines(code);

	let [success, result] = pcall(() => {
		const [fn, compileError] = loadstring(wrapped);
		if (!fn) {
			if (isLoadstringUnavailable(compileError)) {
				return runViaModuleScript(wrapped, userLines);
			}
			error(`Compile error: ${remapPayloadLines(tostring(compileError), userLines)}`, 0);
		}
		return fn() as unknown as WrapperResult;
	});

	// loadstring can throw (not return nil) when ServerScriptService.
	// LoadStringEnabled is false; treat that as a second-chance fallback.
	if (!success && isLoadstringUnavailable(result)) {
		[success, result] = pcall(() => runViaModuleScript(wrapped, userLines));
	}

	if (!success) {
		return {
			success: false,
			error: tostring(result),
			output: [],
			message: "Code execution failed",
		};
	}

	const r = result as unknown as WrapperResult;
	const capturedOutput = r.output as unknown as string[] | undefined;
	const output = capturedOutput !== undefined ? capturedOutput : ([] as string[]);
	if (r.ok === true) {
		return {
			success: true,
			returnValue: r.value !== undefined ? formatReturnValue(r.value) : undefined,
			output,
			message: "Code executed successfully",
		};
	}
	return {
		success: false,
		error: r.value !== undefined ? tostring(r.value) : "(unknown error)",
		output,
		message: "Code execution failed",
	};
}

export = { execute };
