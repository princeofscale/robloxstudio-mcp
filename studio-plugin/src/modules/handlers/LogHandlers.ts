import RuntimeLogBuffer from "../RuntimeLogBuffer";

function getRuntimeLogs(requestData: Record<string, unknown>): unknown {
	const since = requestData.since as number | undefined;
	const tail = requestData.tail as number | undefined;
	const filter = requestData.filter as string | undefined;
	// This is the buffer that captured the LogService event, not necessarily
	// the script-origin peer. Ordinary playtests share/reflect logs across
	// edit/server/client LogService buffers.
	const capturedBy = RuntimeLogBuffer.detectPeer();
	return RuntimeLogBuffer.query({ since, tail, filter }, capturedBy);
}

export = { getRuntimeLogs };
