/**
 * Job registry for pi-background.
 *
 * Jobs are plain detached Node child processes. stdout and stderr are wired
 * straight to a file descriptor at `<tmp>/pi-bg/<id>.log`, so the kernel moves
 * the bytes and a job keeps writing while the agent does something else.
 *
 * This module deliberately knows nothing about pi. `index.ts` owns the tool,
 * command, widget, and notification wiring; everything here is testable with
 * plain Node.
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readSync,
	statSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { stripAnsi } from "./format.ts";

/** Seconds a foreground command may run before we move it to the background. */
export const DEFAULT_AUTO_BACKGROUND_SECONDS = 120;
/** Reject new jobs once this many are running. */
export const MAX_RUNNING_JOBS = 16;
/** A single job log larger than this is stopped to protect the disk. */
export const MAX_LOG_BYTES = 128 * 1024 * 1024;
/** Finished jobs are dropped from the registry after this long. */
export const FINISHED_JOB_RETENTION_MS = 10 * 60 * 1000;
/** How often foreground output is read from the log and forwarded to pi. */
export const FOREGROUND_POLL_MS = 150;
/** Ignore a deadline shorter than this; it is almost certainly a mistake. */
const MIN_DEADLINE_MS = 1000;

export type JobStatus = "running" | "completed" | "failed" | "killed";
export type JobEventType = "start" | "exit" | "detach" | "kill";

export interface JobSummary {
	id: string;
	command: string;
	cwd: string;
	logPath: string;
	status: JobStatus;
	startedAt: number;
	endedAt?: number;
	exitCode?: number | null;
	signal?: NodeJS.Signals | null;
	/** Session that started the job, so sibling sessions do not adopt it. */
	ownerSessionId?: string;
	/** True once the job is meant to outlive the tool call that started it. */
	detached: boolean;
	/** Set when the job is stopped or exits for a reason other than its exit code. */
	reason?: string;
	/** The agent asked for this job's output after it finished. */
	read: boolean;
	/** A completion message has already been delivered. */
	notified: boolean;
	/** Deliver a completion message when this job exits. */
	notifyOnExit: boolean;
}

export interface Job extends JobSummary {
	pid?: number;
	offset: number;
	decoder: StringDecoder;
	spawnError?: string;
	/** Agent tool calls currently blocked in `jobs attach` on this job. */
	waiters: number;
	exitPromise: Promise<void>;
	child?: ChildProcess;
	/** Resolves the foreground race early without stopping the process. */
	requestDetach?: () => void;
}

export interface JobEvent {
	type: JobEventType;
	job: Job;
}

export interface StartJobOptions {
	command: string;
	cwd: string;
	env?: NodeJS.ProcessEnv;
	/** Custom shell executable, normally pi's `shellPath` setting. */
	shellPath?: string;
	/** Deliver a completion message when the job exits. */
	notifyOnExit?: boolean;
	ownerSessionId?: string;
}

interface Registry {
	jobs: Map<string, Job>;
	listeners: Set<(event: JobEvent) => void>;
}

const REGISTRY_KEY = Symbol.for("pi-background.registry");

function registry(): Registry {
	const holder = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Registry };
	holder[REGISTRY_KEY] ??= { jobs: new Map(), listeners: new Set() };
	return holder[REGISTRY_KEY];
}

/** Test hook: drop every job and listener. */
export function resetRegistry(): void {
	const reg = registry();
	reg.jobs.clear();
	reg.listeners.clear();
}

export function onJobEvent(listener: (event: JobEvent) => void): () => void {
	const reg = registry();
	reg.listeners.add(listener);
	return () => reg.listeners.delete(listener);
}

function emit(type: JobEventType, job: Job): void {
	for (const listener of registry().listeners) {
		try {
			listener({ type, job });
		} catch {
			// A broken listener must not break job tracking.
		}
	}
}

export function resolveLogDir(): string {
	return process.env.PI_BG_LOG_DIR?.trim() || join(tmpdir(), "pi-bg");
}

export function createJobId(): string {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
	let id = "b";
	for (const byte of randomBytes(8)) id += alphabet[byte % alphabet.length];
	return id;
}

export function getJob(id: string): Job | undefined {
	return registry().jobs.get(id);
}

/** Strip process handles before a job crosses into UI, transcript, or JSON. */
export function summarize(job: Job): JobSummary {
	return {
		id: job.id,
		command: job.command,
		cwd: job.cwd,
		logPath: job.logPath,
		status: job.status,
		startedAt: job.startedAt,
		endedAt: job.endedAt,
		exitCode: job.exitCode,
		signal: job.signal,
		ownerSessionId: job.ownerSessionId,
		detached: job.detached,
		reason: job.reason,
		read: job.read,
		notified: job.notified,
		notifyOnExit: job.notifyOnExit,
	};
}

export function listJobs(): JobSummary[] {
	return [...registry().jobs.values()]
		.sort((a, b) => b.startedAt - a.startedAt)
		.map(summarize);
}

export function runningJobs(): Job[] {
	return [...registry().jobs.values()].filter((job) => job.status === "running");
}

export function terminalJobs(): Job[] {
	return [...registry().jobs.values()].filter((job) => job.status !== "running");
}

export function clearFinishedJobs(ownerSessionId?: string): number {
	let removed = 0;
	for (const [id, job] of registry().jobs) {
		if (job.status === "running") continue;
		if (ownerSessionId && job.ownerSessionId && job.ownerSessionId !== ownerSessionId) continue;
		registry().jobs.delete(id);
		removed += 1;
	}
	return removed;
}

/**
 * Drop finished jobs older than `maxAgeMs` so a long session cannot accumulate
 * an unbounded list. Runs on the same tick as the widget refresh.
 */
export function pruneFinishedJobs(maxAgeMs = FINISHED_JOB_RETENTION_MS, now = Date.now()): number {
	let removed = 0;
	for (const [id, job] of registry().jobs) {
		if (job.status === "running") continue;
		if (job.endedAt === undefined || now - job.endedAt < maxAgeMs) continue;
		registry().jobs.delete(id);
		removed += 1;
	}
	return removed;
}

/** Retention override in seconds, or the default. */
export function resolveRetentionMs(): number {
	const value = Number(process.env.PI_BG_RETENTION);
	return Number.isFinite(value) && value > 0 ? value * 1000 : FINISHED_JOB_RETENTION_MS;
}

/** POSIX shell used for jobs, matching pi's `/bin/bash -c` default. */
function shellConfig(customShellPath?: string): { shell: string; args: string[] } {
	const envShell = process.env.PI_BG_SHELL?.trim();
	const resolved = envShell || customShellPath;
	if (resolved) {
		const shell = resolved.startsWith("~") ? join(homedir(), resolved.slice(1)) : resolved;
		return { shell, args: ["-c"] };
	}
	if (process.platform === "win32") {
		if (process.env.SHELL) return { shell: process.env.SHELL, args: ["-c"] };
		return { shell: "bash.exe", args: ["-c"] };
	}
	if (existsSync("/bin/bash")) return { shell: "/bin/bash", args: ["-c"] };
	return { shell: process.env.SHELL || "/bin/sh", args: ["-c"] };
}

function killTree(pid: number, signal: NodeJS.Signals): void {
	try {
		// The child is a process-group leader, so the negative pid reaches
		// everything it started (npm, tsc, watchers, …).
		if (process.platform !== "win32") process.kill(-pid, signal);
		else process.kill(pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// Already gone.
		}
	}
}

/** Legacy WSL bash takes the script on stdin rather than as an argument. */
function usesStdinTransport(shell: string): boolean {
	return process.platform === "win32" && /windows[\\/]+system32[\\/]+bash\.exe$/i.test(shell);
}

export function startJob(options: StartJobOptions): Job {
	const reg = registry();
	const backgroundCount = runningJobs().filter((job) => job.notifyOnExit).length;
	if (backgroundCount >= MAX_RUNNING_JOBS) {
		throw new Error(
			`Too many background jobs (${backgroundCount}/${MAX_RUNNING_JOBS}). Stop one with jobs({ action: "kill", id }) first.`
		);
	}

	const logDir = resolveLogDir();
	mkdirSync(logDir, { recursive: true });
	const id = createJobId();
	const logPath = join(logDir, `${id}.log`);
	const command = options.command;
	const startedAt = Date.now();

	let resolveExit: () => void = () => {};
	const exitPromise = new Promise<void>((resolve) => {
		resolveExit = resolve;
	});

	const job: Job = {
		id,
		command,
		cwd: options.cwd,
		logPath,
		status: "running",
		startedAt,
		detached: Boolean(options.notifyOnExit),
		ownerSessionId: options.ownerSessionId,
		read: false,
		notified: false,
		notifyOnExit: Boolean(options.notifyOnExit),
		offset: 0,
		decoder: new StringDecoder("utf8"),
		waiters: 0,
		exitPromise,
	};

	const finalize = (status: JobStatus, exitCode?: number | null, signal?: NodeJS.Signals | null): void => {
		if (job.status !== "running" && job.status !== "killed") return;
		job.status = job.status === "killed" ? "killed" : status;
		job.exitCode = exitCode;
		job.signal = signal;
		job.endedAt = Date.now();
		resolveExit();
		emit("exit", job);
	};

	let child: ChildProcess;
	let logFd: number | undefined;
	try {
		logFd = openSync(logPath, "a");
		const config = shellConfig(options.shellPath);
		const stdinMode = usesStdinTransport(config.shell);
		child = spawn(config.shell, stdinMode ? ["-s"] : [...config.args, command], {
			cwd: options.cwd,
			detached: process.platform !== "win32",
			env: options.env ?? { ...process.env },
			stdio: [stdinMode ? "pipe" : "ignore", logFd, logFd],
			windowsHide: true,
		});
		if (stdinMode) {
			child.stdin?.on("error", () => {});
			child.stdin?.end(command);
		}
	} catch (error) {
		job.spawnError = error instanceof Error ? error.message : String(error);
		job.status = "failed";
		job.endedAt = Date.now();
		job.exitCode = 127;
		job.notifyOnExit = false;
		job.notified = true;
		resolveExit();
		// Nothing to notify about when the spawn itself failed; the caller
		// reports the error in the tool result.
		reg.jobs.set(id, job);
		emit("start", job);
		emit("exit", job);
		return job;
	} finally {
		if (logFd !== undefined) {
			try {
				closeSync(logFd);
			} catch {
				// Ignore.
			}
		}
	}

	job.child = child;
	job.pid = child.pid;
	reg.jobs.set(id, job);

	child.once("error", (error) => {
		job.spawnError = error.message;
		finalize("failed", 127, null);
	});
	// `exit` rather than `close`: a daemonized grandchild that inherited the
	// log fd would otherwise keep the job open forever.
	child.once("exit", (code, signal) => {
		if (job.status === "killed") {
			finalize("killed", code, signal);
			return;
		}
		finalize(code === 0 ? "completed" : "failed", code, signal);
	});

	// Detached jobs must not keep pi's event loop alive when the session ends.
	child.unref();
	emit("start", job);
	return job;
}

export function killJob(id: string, signal: NodeJS.Signals = "SIGTERM"): boolean {
	const job = getJob(id);
	if (!job || job.status !== "running" || job.pid === undefined) return false;

	job.status = "killed";
	job.reason = job.reason ?? "killed";
	emit("kill", job);
	killTree(job.pid, signal);

	// Give the process tree a moment to exit, then insist.
	const pid = job.pid;
	const timer = setTimeout(() => {
		if (job.status === "running" || job.exitCode === undefined) killTree(pid, "SIGKILL");
	}, 3000);
	timer.unref?.();
	return true;
}

/** Stop a job because its log crossed the disk budget. */
export function enforceLogLimits(): void {
	for (const job of runningJobs()) {
		let size = 0;
		try {
			size = statSync(job.logPath).size;
		} catch {
			continue;
		}
		if (size <= MAX_LOG_BYTES) continue;
		job.reason = `output exceeded ${Math.round(MAX_LOG_BYTES / 1024 / 1024)} MB`;
		killJob(job.id);
	}
}

/**
 * Read bytes appended since the last call. Returns decoded text, never more
 * than `maxBytes` per call; the caller polls again for the rest.
 */
export function readNewOutput(job: Job, maxBytes = 256 * 1024): string {
	let size: number;
	try {
		size = statSync(job.logPath).size;
	} catch {
		return "";
	}
	if (size <= job.offset) return "";

	const length = Math.min(size - job.offset, maxBytes);
	const buffer = Buffer.allocUnsafe(length);
	let fd: number | undefined;
	try {
		fd = openSync(job.logPath, "r");
		const read = readSync(fd, buffer, 0, buffer.length, job.offset);
		job.offset += read;
		return job.decoder.write(buffer.subarray(0, read));
	} catch {
		return "";
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// Ignore.
			}
		}
	}
}

function readFileInto(fd: number, buffer: Buffer, position: number): number {
	return readSync(fd, buffer, 0, buffer.length, position);
}

export interface TailResult {
	text: string;
	bytes: number;
	truncated: boolean;
}

/** Read the last `maxBytes` of a job log and return at most `maxLines` lines. */
export function readTail(job: Job, maxLines = 60, maxBytes = 64 * 1024): TailResult {
	let size = 0;
	try {
		size = statSync(job.logPath).size;
	} catch {
		return { text: "", bytes: 0, truncated: false };
	}
	const start = Math.max(0, size - maxBytes);
	const length = size - start;
	const buffer = Buffer.allocUnsafe(length);
	let fd: number | undefined;
	let text = "";
	try {
		fd = openSync(job.logPath, "r");
		const read = readFileInto(fd, buffer, start);
		text = buffer.subarray(0, read).toString("utf8");
	} catch {
		text = "";
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// Ignore.
			}
		}
	}

	const lines = text.split("\n");
	// A trailing newline produces one empty final element.
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const selected = maxLines > 0 ? lines.slice(-maxLines) : lines;
	if (start > 0) {
		// Drop the partial first line when we started mid-file.
		selected.shift();
	}
	return {
		text: selected.join("\n"),
		bytes: length,
		truncated: start > 0 || lines.length > selected.length,
	};
}

/** Last non-empty, ANSI-stripped line, suitable for a widget. */
export function lastLine(job: Job, maxLength = 90): string | undefined {
	const tail = readTail(job, 20, 8 * 1024);
	const lines = tail.text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = stripAnsi(lines[i] ?? "")
			.replace(/\s+$/, "")
			.trim();
		if (!line) continue;
		return line.length > maxLength ? `${line.slice(0, maxLength - 1)}…` : line;
	}
	return undefined;
}

export function markRead(id: string): void {
	const job = getJob(id);
	// Reading a still-running job does not suppress its future completion
	// message: the agent should hear about the result it has not seen yet.
	if (job && job.status !== "running") job.read = true;
}

/** Wait for a job to exit, streaming ticks through `onTick`. */
export async function waitForJob(
	job: Job,
	timeoutMs: number,
	onTick?: (job: Job) => void,
	signal?: AbortSignal
): Promise<"exited" | "timeout" | "aborted"> {
	if (job.status !== "running") return "exited";
	if (signal?.aborted) return "aborted";

	onTick?.(job);
	const interval = onTick
		? setInterval(() => {
				try {
					onTick(job);
				} catch {
					// Ignore a rendering failure.
				}
			}, Math.min(1000, Math.max(200, Math.floor(timeoutMs / 10))))
		: undefined;
	interval?.unref?.();

	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<"timeout">((resolve) => {
		timer = setTimeout(() => resolve("timeout"), Math.max(0, timeoutMs));
	});
	let resolveAbort: () => void = () => {};
	const onAbort = (): void => resolveAbort();
	const aborted = new Promise<"aborted">((resolve) => {
		resolveAbort = () => resolve("aborted");
		signal?.addEventListener("abort", onAbort, { once: true });
	});

	try {
		return await Promise.race([job.exitPromise.then(() => "exited" as const), timeout, aborted]);
	} finally {
		if (interval) clearInterval(interval);
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

/** Detach every foreground command currently owned by this extension. */
export function detachAllForeground(ownerSessionId?: string): number {
	let detached = 0;
	for (const job of registry().jobs.values()) {
		if (job.status !== "running" || !job.requestDetach) continue;
		if (ownerSessionId && job.ownerSessionId && job.ownerSessionId !== ownerSessionId) continue;
		job.requestDetach();
		detached += 1;
	}
	return detached;
}

/** Stop every running job owned by `sessionId` (session shutdown). */
export function killAllJobs(sessionId?: string): number {
	let killed = 0;
	for (const job of runningJobs()) {
		if (sessionId && job.ownerSessionId && job.ownerSessionId !== sessionId) continue;
		// Detach hooks are irrelevant once we are shutting down; resolving them
		// simply lets a foreground tool call finish promptly.
		job.requestDetach?.();
		if (killJob(job.id)) killed += 1;
	}
	return killed;
}

export interface ForegroundOptions {
	command: string;
	cwd: string;
	env?: NodeJS.ProcessEnv;
	/** Custom shell executable, normally pi's `shellPath` setting. */
	shellPath?: string;
	signal?: AbortSignal;
	onData: (data: Buffer) => void;
	/** Deadline before the job is detached (or killed for sleep-like commands). */
	deadlineMs: number;
	/** `sleep 30` should be killed, not hidden in the background. */
	allowDetach: boolean;
	ownerSessionId?: string;
	/** Called once when a running job is moved to the background. */
	onDetach?: (job: Job) => void;
}

export interface ForegroundResult {
	exitCode: number | null;
	/** Set when the command outlived its deadline and kept running. */
	detachedJob?: Job;
}

/**
 * Run a command in the foreground for up to `deadlineMs`, streaming output to
 * pi. When the deadline passes the process is not killed: it keeps writing to
 * its log and the tool call returns, which is the whole point of the extension.
 */
export async function runForeground(options: ForegroundOptions): Promise<ForegroundResult> {
	if (options.signal?.aborted) throw new Error("aborted");
	const deadlineMs = Math.max(MIN_DEADLINE_MS, options.deadlineMs);
	const job = startJob({
		command: options.command,
		cwd: options.cwd,
		env: options.env,
		shellPath: options.shellPath,
		notifyOnExit: false,
		ownerSessionId: options.ownerSessionId,
	});

	const pump = (): void => {
		// Bound each tick so a command that floods its log cannot starve the
		// timer and the transcript; the next tick picks up the rest.
		let chunk = readNewOutput(job);
		for (let reads = 0; chunk && reads < 16; reads += 1) {
			options.onData(Buffer.from(chunk, "utf8"));
			chunk = readNewOutput(job);
		}
	};

	let aborted = false;
	let detached = false;
	let settled = false;
	let resolveDetach: () => void = () => {};
	const detachPromise = new Promise<"detach">((resolve) => {
		resolveDetach = () => {
			if (detached || settled || job.status !== "running") return;
			detached = true;
			job.detached = true;
			job.notifyOnExit = true;
			job.requestDetach = undefined;
			emit("detach", job);
			options.onDetach?.(job);
			resolve("detach");
		};
	});
	job.requestDetach = resolveDetach;

	const onAbort = (): void => {
		if (job.status !== "running") return;
		aborted = true;
		killJob(job.id);
	};
	options.signal?.addEventListener("abort", onAbort, { once: true });

	const poller = setInterval(() => {
		if (settled) return;
		pump();
	}, FOREGROUND_POLL_MS);
	// First pump immediately so fast commands do not wait for a tick.
	pump();

	const deadline = setTimeout(() => {
		if (job.status !== "running") return;
		if (options.allowDetach) {
			resolveDetach();
			return;
		}
		// A sleep-like command is not useful in the background; kill it and
		// report a timeout like pi's native bash tool does.
		job.reason = "timeout";
		killJob(job.id);
	}, deadlineMs);

	let outcome: "exit" | "detach";
	try {
		outcome = await Promise.race([
			job.exitPromise.then(() => "exit" as const),
			detachPromise,
		]);
	} finally {
		settled = true;
		clearInterval(poller);
		clearTimeout(deadline);
		options.signal?.removeEventListener("abort", onAbort);
		job.requestDetach = undefined;
		// Drain whatever arrived between the last poll and now.
		pump();
	}

	if (aborted) throw new Error("aborted");

	if (outcome === "detach") {
		return { exitCode: 0, detachedJob: job };
	}

	if (!options.allowDetach && job.reason === "timeout") {
		throw new Error(`timeout:${Math.round(deadlineMs / 1000)}`);
	}

	return { exitCode: job.exitCode ?? (job.status === "completed" ? 0 : 1) };
}

/** True for commands Claude Code declines to auto-background. */
export function isSleepCommand(command: string): boolean {
	return /^\s*sleep(?:\s|$)/.test(command);
}
