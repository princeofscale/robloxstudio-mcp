import RuntimeLogBuffer from "../RuntimeLogBuffer";

function getRuntimeLogs(requestData: Record<string, unknown>): unknown {
	const since = requestData.since as number | undefined;
	const tail = requestData.tail as number | undefined;
	const filter = requestData.filter as string | undefined;
	// Plugin-side peer tag is generic ("edit"|"server"|"client"). The MCP-side
	// aggregator overrides it with the specific instance role (e.g. "client-1")
	// during fan-out for target=all, so this value is only authoritative for
	// the single-peer query path.
	const peer = RuntimeLogBuffer.detectPeer();
	return RuntimeLogBuffer.query({ since, tail, filter }, peer);
}

export = { getRuntimeLogs };
