// Async execute_luau handlers. execute_luau_async registers a job, spawns the
// real LuauExec.execute in a coroutine, and returns the jobId immediately;
// get_job_status / get_job_result poll the registry. This keeps every MCP call
// fast (no long-poll timeout) while heavy Luau runs between polls. Cancellation
// is best-effort — Luau coroutines can't be force-killed, so we flag the job and
// discard its result on completion.

import LuauExec from "../LuauExec";
import JobRegistry from "../JobRegistry";

function executeLuauAsync(requestData: Record<string, unknown>) {
	const code = requestData.code as string;
	if (!code || code === "") return { error: "Code is required" };

	const job = JobRegistry.create();
	task.spawn(() => {
		const result = LuauExec.execute(code);
		const j = JobRegistry.get(job.id);
		if (!j) return;
		if (j.cancelled === true) {
			j.status = "cancelled";
			j.finishedAt = tick();
			return;
		}
		j.success = result.success;
		j.returnValue = result.returnValue;
		j.output = result.output;
		j.error = result.error;
		j.message = result.message;
		j.status = result.success ? "done" : "error";
		j.finishedAt = tick();
	});

	return { jobId: job.id, status: "running", estimatedKind: "long" };
}

function getJobStatus(requestData: Record<string, unknown>) {
	const jobId = requestData.jobId as string;
	if (!jobId || jobId === "") return { error: "jobId is required" };
	const j = JobRegistry.get(jobId);
	if (!j) return { error: "Unknown jobId", jobId };
	const elapsed = (j.finishedAt ?? tick()) - j.startedAt;
	return {
		jobId: j.id,
		status: j.status,
		elapsed,
		message: j.message,
		done: j.status !== "running",
	};
}

function getJobResult(requestData: Record<string, unknown>) {
	const jobId = requestData.jobId as string;
	if (!jobId || jobId === "") return { error: "jobId is required" };
	const j = JobRegistry.get(jobId);
	if (!j) return { error: "Unknown jobId", jobId };
	if (j.status === "running") {
		return { jobId: j.id, status: "running", done: false };
	}
	return {
		jobId: j.id,
		status: j.status,
		done: true,
		success: j.success,
		returnValue: j.returnValue,
		output: j.output,
		error: j.error,
		message: j.message,
		elapsed: (j.finishedAt ?? tick()) - j.startedAt,
	};
}

function cancelJob(requestData: Record<string, unknown>) {
	const jobId = requestData.jobId as string;
	if (!jobId || jobId === "") return { error: "jobId is required" };
	const j = JobRegistry.get(jobId);
	if (!j) return { error: "Unknown jobId", jobId };
	if (j.status === "running") {
		j.cancelled = true;
		return {
			jobId: j.id,
			status: "cancelling",
			note: "Luau coroutines cannot be force-killed; the result will be discarded on completion.",
		};
	}
	return { jobId: j.id, status: j.status, note: "Job already finished." };
}

export = { executeLuauAsync, getJobStatus, getJobResult, cancelJob };
