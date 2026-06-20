// Async-job registry for long-running execute_luau. The poll loop already runs
// each request in its own task.spawn coroutine, and plugin modules are
// singletons that persist across poll cycles — so a job started by
// /api/execute-luau-async can keep running while later /api/get-job-status polls
// read its state here. This removes the false-timeout class: every individual
// MCP call returns fast; the heavy work happens between polls.

import { Job } from "../types";

const jobs = new Map<string, Job>();
const MAX_JOBS = 50;

// Maps a running coroutine to its job id, so the global _G.__mcp helpers can find
// "which job am I in" via coroutine.running() — concurrency-safe across jobs.
const threadJobs = new Map<thread, string>();

// Keep the registry bounded: once it grows past MAX_JOBS, drop the oldest
// finished jobs (never running ones).
function prune(): void {
	if (jobs.size() <= MAX_JOBS) return;
	const finished: Job[] = [];
	for (const [, j] of jobs) {
		if (j.status !== "running") finished.push(j);
	}
	finished.sort((a, b) => (a.finishedAt ?? 0) < (b.finishedAt ?? 0));
	let toRemove = jobs.size() - MAX_JOBS;
	for (const j of finished) {
		if (toRemove <= 0) break;
		jobs.delete(j.id);
		toRemove--;
	}
}

function create(): Job {
	const job: Job = {
		id: game.GetService("HttpService").GenerateGUID(false),
		status: "running",
		startedAt: tick(),
	};
	jobs.set(job.id, job);
	prune();
	return job;
}

function get(id: string): Job | undefined {
	return jobs.get(id);
}

function bindThread(co: thread, jobId: string): void {
	threadJobs.set(co, jobId);
}

function unbindThread(co: thread): void {
	threadJobs.delete(co);
}

// Called by _G.__mcp.progress(done, total, msg) from server-generated code.
function reportProgress(co: thread, done: number, total?: number, message?: string, stage?: string): void {
	const jobId = threadJobs.get(co);
	if (jobId === undefined) return;
	const job = jobs.get(jobId);
	if (!job || job.status !== "running") return;
	job.progress = done;
	if (total !== undefined) job.total = total;
	if (message !== undefined) job.message = message;
	if (stage !== undefined) job.stage = stage;
}

// Called by _G.__mcp.checkCancelled() so long server-generated loops can bail early.
function isCancelledForThread(co: thread): boolean {
	const jobId = threadJobs.get(co);
	if (jobId === undefined) return false;
	const job = jobs.get(jobId);
	return job?.cancelled === true;
}

export = { create, get, bindThread, unbindThread, reportProgress, isCancelledForThread };
