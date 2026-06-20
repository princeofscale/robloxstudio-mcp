// Async-job registry for long-running execute_luau. The poll loop already runs
// each request in its own task.spawn coroutine, and plugin modules are
// singletons that persist across poll cycles — so a job started by
// /api/execute-luau-async can keep running while later /api/get-job-status polls
// read its state here. This removes the false-timeout class: every individual
// MCP call returns fast; the heavy work happens between polls.

import { Job } from "../types";

const jobs = new Map<string, Job>();
const MAX_JOBS = 50;

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

export = { create, get };
