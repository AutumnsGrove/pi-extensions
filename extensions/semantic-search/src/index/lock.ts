/**
 * Cross-process lock for index runs.
 *
 * `indexer.ts` serializes runs inside one process. Two `pi` sessions in two
 * terminals can still index the same domain database at once, and `vec0` has no
 * upsert: interleaved runs would delete each other's rows mid-batch. A lock file
 * next to the database serializes whole runs; the database also sets
 * `busy_timeout` so the remaining short writes wait instead of failing.
 *
 * The holder rewrites its mtime as a heartbeat, so a crashed process (or a kill
 * -9) is detected by age, not only by pid.
 */

import {
	closeSync,
	openSync,
	readFileSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";

export interface FileLockOptions {
	/** Give up after this long. Default 120s. */
	timeoutMs?: number;
	/** Consider the lock abandoned when the heartbeat is older than this. */
	staleMs?: number;
	/** Poll interval while waiting. */
	pollMs?: number;
	/** Re-check this between polls and give up when aborted. */
	signal?: AbortSignal;
}

interface LockContents {
	pid: number;
	token: string;
	at: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_STALE_MS = 60_000;
const DEFAULT_POLL_MS = 200;
const HEARTBEAT_MS = 10_000;

function readLock(path: string): LockContents | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		return {
			pid: typeof parsed.pid === "number" ? parsed.pid : 0,
			token: typeof parsed.token === "string" ? parsed.token : "",
			at: typeof parsed.at === "number" ? parsed.at : 0,
		};
	} catch {
		return undefined;
	}
}

function pidAlive(pid: number): boolean {
	if (pid <= 0) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to another user.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function isStaleContents(path: string, contents: LockContents, staleMs: number): boolean {
	if (!pidAlive(contents.pid)) {
		return true;
	}
	try {
		return Date.now() - statSync(path).mtimeMs > staleMs;
	} catch {
		// Vanished between the read and the stat: the next attempt wins.
		return true;
	}
}

/**
 * Remove a lock file judged stale — but only the exact file we judged. Two
 * waiters can both see the same stale token; the winner unlinks it and acquires
 * its own lock, and the loser must not delete that fresh lock. Re-reading and
 * comparing the token makes the delete a compare-and-delete.
 */
function recoverStaleLock(path: string, staleMs: number): void {
	const judged = readLock(path);
	if (!judged || !isStaleContents(path, judged, staleMs)) {
		return;
	}
	const current = readLock(path);
	if (!current || current.token !== judged.token) {
		// A peer already recovered and re-acquired; leave its lock alone.
		return;
	}
	try {
		unlinkSync(path);
	} catch {
		// Unremovable (permissions, a directory in its place): the caller's next
		// attempt or its timeout handles it.
	}
}

function tryAcquire(path: string, contents: LockContents): boolean {
	let fd: number;
	try {
		fd = openSync(path, "wx");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			return false;
		}
		throw error;
	}
	try {
		writeSync(fd, JSON.stringify(contents));
	} finally {
		closeSync(fd);
	}
	return true;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(new Error("indexing aborted"));
		};
		if (signal?.aborted) {
			clearTimeout(timer);
			reject(new Error("indexing aborted"));
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function release(path: string, token: string): void {
	const contents = readLock(path);
	if (contents?.token !== token) {
		// Someone else recovered the lock after we were declared stale; leave it.
		return;
	}
	try {
		unlinkSync(path);
	} catch {
		// Already gone.
	}
}

/**
 * Run `fn` while holding `lockPath`. Without a path (in-memory stores in tests)
 * it runs immediately, so callers do not need to branch.
 */
export async function withFileLock<T>(
	lockPath: string | undefined,
	fn: () => Promise<T>,
	options: FileLockOptions = {}
): Promise<T> {
	if (!lockPath) {
		return fn();
	}
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
	const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
	const token = randomUUID();
	const contents: LockContents = { pid: process.pid, token, at: Date.now() };
	const deadline = Date.now() + timeoutMs;

	for (;;) {
		if (tryAcquire(lockPath, contents)) {
			break;
		}
		recoverStaleLock(lockPath, staleMs);
		if (Date.now() >= deadline) {
			throw new Error(
				`another pi process is indexing this repository (${lockPath}); retry in a moment`
			);
		}
		// Always yield: a stale lock we cannot unlink must end in the timeout
		// above, not in an empty spin.
		await sleep(pollMs, options.signal);
	}

	const heartbeat = setInterval(() => {
		try {
			const now = new Date();
			utimesSync(lockPath, now, now);
		} catch {
			// The lock was recovered by a peer; the run still finishes safely
			// because the database serializes individual writes.
		}
	}, HEARTBEAT_MS);
	heartbeat.unref?.();

	try {
		return await fn();
	} finally {
		clearInterval(heartbeat);
		release(lockPath, token);
	}
}
