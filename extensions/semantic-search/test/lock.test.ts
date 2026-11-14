import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withFileLock } from "../src/index/lock.ts";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function lockPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "semsearch-lock-"));
	dirs.push(dir);
	return join(dir, "index.db.lock");
}

describe("withFileLock", () => {
	it("serializes concurrent runs", async () => {
		const path = lockPath();
		let active = 0;
		let maxActive = 0;
		const run = () =>
			withFileLock(path, async () => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				await new Promise((resolve) => setTimeout(resolve, 20));
				active -= 1;
			});

		await Promise.all([run(), run(), run()]);
		expect(maxActive).toBe(1);
	});

	it("recovers a lock left behind by a dead process", async () => {
		const path = lockPath();
		writeFileSync(path, JSON.stringify({ pid: 2147483646, token: "dead", at: 0 }));

		let ran = false;
		await withFileLock(
			path,
			async () => {
				ran = true;
			},
			{ timeoutMs: 1000 }
		);
		expect(ran).toBe(true);
	});

	it("keeps serializing when several waiters recover the same stale lock", async () => {
		const path = lockPath();
		writeFileSync(path, JSON.stringify({ pid: 2147483646, token: "stale", at: 0 }));
		let active = 0;
		let maxActive = 0;
		const run = () =>
			withFileLock(path, async () => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				await new Promise((resolve) => setTimeout(resolve, 20));
				active -= 1;
			});

		// Every waiter judges the same stale file. Only the one that unlinks that
		// exact token may acquire; a loser must not delete the winner's fresh lock.
		await Promise.all([run(), run(), run()]);
		expect(maxActive).toBe(1);
	});

	it("gives up with an actionable error while another process holds it", async () => {
		const path = lockPath();
		writeFileSync(
			path,
			JSON.stringify({ pid: process.pid, token: "alive", at: Date.now() })
		);

		await expect(
			withFileLock(path, async () => undefined, { timeoutMs: 80, pollMs: 10 })
		).rejects.toThrow(/another pi process/);
	});

	it("releases the lock even when the run throws", async () => {
		const path = lockPath();
		await expect(
			withFileLock(path, async () => {
				throw new Error("boom");
			})
		).rejects.toThrow("boom");
		// A second acquisition must not need the stale timeout.
		await withFileLock(path, async () => undefined, { timeoutMs: 500 });
	});

	it("times out instead of spinning when the lock cannot be removed", async () => {
		const path = lockPath();
		// A directory in place of the lock file: open('wx') is EEXIST forever and
		// readFile fails, so recovery can never succeed. This must hit the
		// deadline rather than spin the event loop.
		mkdirSync(path);
		await expect(
			withFileLock(path, async () => undefined, { timeoutMs: 100, pollMs: 10 })
		).rejects.toThrow(/another pi process/);
	});

	it("runs immediately when no lock path is configured", async () => {
		await expect(
			withFileLock(undefined, async () => "done")
		).resolves.toBe("done");
	});
});
