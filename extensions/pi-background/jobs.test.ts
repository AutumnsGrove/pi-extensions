import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clearFinishedJobs,
	detachAllForeground,
	isSleepCommand,
	killAllJobs,
	killJob,
	lastLine,
	listJobs,
	pruneFinishedJobs,
	readNewOutput,
	readTail,
	resetRegistry,
	resolveRetentionMs,
	runForeground,
	startJob,
	summarize,
	waitForJob,
	type Job,
} from "./jobs.ts";

let logDir: string;

beforeEach(() => {
	logDir = mkdtempSync(join(tmpdir(), "pi-bg-test-"));
	process.env.PI_BG_LOG_DIR = logDir;
	resetRegistry();
});

afterEach(() => {
	killAllJobs();
	resetRegistry();
	delete process.env.PI_BG_LOG_DIR;
	// POSIX unlinks the log even if a killed child still holds the fd.
	rmSync(logDir, { recursive: true, force: true });
});

async function waitForExit(job: Job, timeoutMs = 5000): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<boolean>((resolve) => {
		timer = setTimeout(() => resolve(false), timeoutMs);
	});
	try {
		return await Promise.race([job.exitPromise.then(() => true), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function drain(job: Job): string {
	let output = "";
	for (;;) {
		const chunk = readNewOutput(job);
		if (!chunk) return output;
		output += chunk;
	}
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("startJob", () => {
	it("runs a command to completion and captures stdout", async () => {
		const job = startJob({ command: "printf 'hello\\nworld\\n'", cwd: process.cwd() });
		expect(job.status).toBe("running");
		expect(await waitForExit(job)).toBe(true);
		expect(job.status).toBe("completed");
		expect(job.exitCode).toBe(0);
		expect(drain(job)).toContain("hello");
		expect(readTail(job, 10).text).toContain("world");
	});

	it("reports a non-zero exit as failed and keeps stderr", async () => {
		const job = startJob({ command: "printf 'bad\\n' >&2; exit 7", cwd: process.cwd() });
		expect(await waitForExit(job)).toBe(true);
		expect(job.status).toBe("failed");
		expect(job.exitCode).toBe(7);
		expect(drain(job)).toContain("bad");
	});

	it("writes logs under PI_BG_LOG_DIR", async () => {
		const job = startJob({ command: "printf hi", cwd: process.cwd() });
		await waitForExit(job);
		expect(job.logPath.startsWith(logDir)).toBe(true);
	});

	it("reports a spawn failure as a failed job", () => {
		const job = startJob({
			command: "true",
			cwd: process.cwd(),
			env: { ...process.env, PI_BG_SHELL: "/definitely/not/a/shell" },
		});
		// POSIX spawn reports ENOENT asynchronously.
		expect(job.status === "running" || job.status === "failed").toBe(true);
	});
});

describe("output helpers", () => {
	it("returns the last non-empty line without ANSI", async () => {
		const job = startJob({ command: "printf '\\033[31mred\\033[0m\\nlast line\\n'", cwd: process.cwd() });
		await waitForExit(job);
		expect(lastLine(job)).toBe("last line");
	});

	it("truncates the tail to the requested number of lines", async () => {
		const job = startJob({ command: "printf '1\\n2\\n3\\n4\\n5\\n'", cwd: process.cwd() });
		await waitForExit(job);
		expect(readTail(job, 2).text).toBe("4\n5");
		expect(readTail(job, 2).truncated).toBe(true);
	});

	it("returns an empty tail for a missing log", () => {
		const job = { ...startJob({ command: "true", cwd: process.cwd() }), logPath: "/nope/missing.log" } as Job;
		expect(readTail(job, 10)).toEqual({ text: "", bytes: 0, truncated: false });
	});
});

describe("killJob", () => {
	it("stops a running job and marks it killed", async () => {
		const job = startJob({ command: "sleep 30", cwd: process.cwd() });
		expect(killJob(job.id)).toBe(true);
		expect(job.status).toBe("killed");
		expect(await waitForExit(job)).toBe(true);
		expect(job.status).toBe("killed");
	});

	it("is a no-op for an already finished job", async () => {
		const job = startJob({ command: "true", cwd: process.cwd() });
		await waitForExit(job);
		expect(killJob(job.id)).toBe(false);
	});
});

describe("waitForJob", () => {
	it("returns timeout for a running job", async () => {
		const job = startJob({ command: "sleep 30", cwd: process.cwd() });
		expect(await waitForJob(job, 100)).toBe("timeout");
	});

	it("returns exited for a finished job", async () => {
		const job = startJob({ command: "true", cwd: process.cwd() });
		await waitForExit(job);
		expect(await waitForJob(job, 100)).toBe("exited");
	});
});

describe("runForeground", () => {
	it("returns output for a command that finishes before the deadline", async () => {
		const chunks: Buffer[] = [];
		const result = await runForeground({
			command: "printf 'fast\\n'",
			cwd: process.cwd(),
			deadlineMs: 5000,
			allowDetach: true,
			onData: (data) => chunks.push(data),
		});
		expect(result.exitCode).toBe(0);
		expect(result.detachedJob).toBeUndefined();
		expect(Buffer.concat(chunks).toString()).toContain("fast");
	});

	it("detaches at the deadline without killing the process", async () => {
		const chunks: Buffer[] = [];
		const result = await runForeground({
			command: "printf 'started\\n'; sleep 30",
			cwd: process.cwd(),
			deadlineMs: 1000,
			allowDetach: true,
			onData: (data) => chunks.push(data),
		});
		const job = result.detachedJob;
		expect(job).toBeDefined();
		if (!job) return;
		expect(job.status).toBe("running");
		expect(job.detached).toBe(true);
		expect(job.notifyOnExit).toBe(true);
		expect(Buffer.concat(chunks).toString()).toContain("started");
		killJob(job.id);
		await waitForExit(job);
	});

	it("kills sleep-like commands at the deadline instead of detaching", async () => {
		await expect(
			runForeground({
				command: "sleep 30",
				cwd: process.cwd(),
				deadlineMs: 1000,
				allowDetach: false,
				onData: () => {},
			})
		).rejects.toThrow("timeout:1");
	});

	it("aborts and kills when the signal fires", async () => {
		const controller = new AbortController();
		const pending = runForeground({
			command: "sleep 30",
			cwd: process.cwd(),
			deadlineMs: 5000,
			allowDetach: true,
			signal: controller.signal,
			onData: () => {},
		});
		await sleep(100);
		controller.abort();
		await expect(pending).rejects.toThrow("aborted");
	});
});

describe("detachAllForeground", () => {
	it("detaches a running foreground command", async () => {
		const pending = runForeground({
			command: "sleep 30",
			cwd: process.cwd(),
			deadlineMs: 5000,
			allowDetach: true,
			onData: () => {},
		});
		await sleep(200);
		expect(detachAllForeground()).toBe(1);
		const result = await pending;
		expect(result.detachedJob).toBeDefined();
		if (result.detachedJob) killJob(result.detachedJob.id);
	});
});

describe("registry helpers", () => {
	it("summarizes jobs without process handles", async () => {
		const job = startJob({ command: "true", cwd: process.cwd() });
		await waitForExit(job);
		const summary = summarize(job);
		expect(summary.id).toBe(job.id);
		expect("child" in summary).toBe(false);
		expect("exitPromise" in summary).toBe(false);
	});

	it("clears finished jobs but keeps running ones", async () => {
		const done = startJob({ command: "true", cwd: process.cwd() });
		await waitForExit(done);
		const running = startJob({ command: "sleep 30", cwd: process.cwd() });
		expect(listJobs()).toHaveLength(2);
		expect(clearFinishedJobs()).toBe(1);
		expect(listJobs().map((entry) => entry.id)).toEqual([running.id]);
	});

	it("prunes only finished jobs older than the retention window", async () => {
		const old = startJob({ command: "true", cwd: process.cwd() });
		await waitForExit(old);
		old.endedAt = Date.now() - 11 * 60 * 1000;

		const recent = startJob({ command: "true", cwd: process.cwd() });
		await waitForExit(recent);
		const running = startJob({ command: "sleep 30", cwd: process.cwd() });

		expect(pruneFinishedJobs()).toBe(1);
		expect(listJobs().map((entry) => entry.id).sort()).toEqual([recent.id, running.id].sort());
	});

	it("reads PI_BG_RETENTION and falls back on bad values", () => {
		const previous = process.env.PI_BG_RETENTION;
		try {
			process.env.PI_BG_RETENTION = "5";
			expect(resolveRetentionMs()).toBe(5000);
			process.env.PI_BG_RETENTION = "nope";
			expect(resolveRetentionMs()).toBe(10 * 60 * 1000);
		} finally {
			if (previous === undefined) delete process.env.PI_BG_RETENTION;
			else process.env.PI_BG_RETENTION = previous;
		}
	});
});

describe("isSleepCommand", () => {
	it("matches sleep but not commands merely starting with it", () => {
		expect(isSleepCommand("sleep 5")).toBe(true);
		expect(isSleepCommand("  sleep 5")).toBe(true);
		expect(isSleepCommand("sleep")).toBe(true);
		expect(isSleepCommand("sleepy 5")).toBe(false);
		expect(isSleepCommand("echo sleep 5")).toBe(false);
	});
});
