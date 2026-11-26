import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrWakePayload } from "../_shared/hook-events.ts";
import { initCursor } from "./diff.ts";
import type { Exec } from "./gh.ts";
import { prKey } from "./ref.ts";
import {
	ACTIVE_AFTER_MS,
	COALESCE_MS,
	DEFAULT_BASE_POLL_MS,
	DEFAULT_EXPIRY_MS,
	describeEvent,
	expiryMs,
	pollInterval,
	resetPollers,
	startPoller,
	tick,
	type PollerDeps,
} from "./poller.ts";
import {
	acquireLock,
	getRelease,
	getSubscription,
	lockPath,
	registry,
	releaseLock,
	resetRegistry,
	type Subscription,
} from "./registry.ts";
import { rmSync, writeFileSync } from "node:fs";
import type { Snapshot } from "./snapshot.ts";

const ref = { owner: "AutumnsGrove", repo: "pi-extensions", number: 32 };

const included = (status: number, body: unknown): string =>
	`HTTP/2.0 ${status} OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`;

class FakeGh {
	pull: Record<string, unknown> = {
		number: 32,
		title: "feat",
		state: "open",
		merged: false,
		draft: false,
		user: { login: "AutumnsGrove" },
		head: { sha: "aaa", ref: "feat" },
		base: { ref: "main" },
	};
	checks: unknown[] = [];
	statuses: unknown[] = [];
	issueComments: unknown[] = [];
	reviewComments: unknown[] = [];
	reviews: unknown[] = [];
	/** The `gh` login `/user` answers with. */
	login = "AutumnsGrove";
	/** Status code to fail the pull request with, or null. */
	fail: number | null = null;
	calls: string[] = [];

	exec: Exec = async (_command, args) => {
		const path = args.at(-1) ?? "";
		this.calls.push(path);
		if (path === "user") return { stdout: included(200, { login: this.login }), code: 0 };
		if (this.fail !== null && path.includes("/pulls/32")) {
			return { stdout: included(this.fail, { message: "boom" }), code: 1 };
		}
		if (path.includes("/pulls/32/reviews")) return { stdout: included(200, this.reviews), code: 0 };
		if (path.includes("/pulls/32/comments")) return { stdout: included(200, this.reviewComments), code: 0 };
		if (path.includes("/issues/32/comments")) return { stdout: included(200, this.issueComments), code: 0 };
		if (path.includes("check-runs")) return { stdout: included(200, { check_runs: this.checks }), code: 0 };
		if (path.includes("/status?")) return { stdout: included(200, { statuses: this.statuses }), code: 0 };
		if (path.includes("/rules/branches/")) return { stdout: included(200, []), code: 0 };
		if (path.includes("/protection/")) {
			return { stdout: included(404, { message: "Branch not protected" }), code: 1 };
		}
		if (path.includes("/pulls/32")) return { stdout: included(200, this.pull), code: 0 };
		return { stdout: included(404, { message: `no fake for ${path}` }), code: 1 };
	};

	snapshot(): Snapshot {
		return {
			pull: {
				number: 32,
				title: String(this.pull.title),
				url: "u",
				state: this.pull.state === "closed" ? "closed" : "open",
				merged: this.pull.merged === true,
				draft: false,
				headSha: String((this.pull.head as { sha: string }).sha),
				headRef: "feat",
				baseRef: "main",
				authorBot: false,
			},
			checks: this.checks.map((check) => {
				const record = check as Record<string, unknown>;
				return {
					key: `check:${record.id}`,
					name: String(record.name),
					status: record.status as "completed",
					conclusion: (record.conclusion as string) ?? null,
					...(record.html_url ? { url: String(record.html_url) } : {}),
				};
			}),
			comments: [],
			reviews: [],
		};
	}
}

interface Harness {
	server: FakeGh;
	sub: Subscription;
	deps: PollerDeps;
	delivered: string[];
	wakes: PrWakePayload[];
	persisted: () => number;
}

let savedDir: string | undefined;

function setup(overrides: { checks?: unknown[]; issueComments?: unknown[]; lock?: boolean } = {}): Harness {
	resetRegistry();
	resetPollers();
	savedDir = process.env.PI_PR_SUBSCRIBE_STATE_DIR;
	process.env.PI_PR_SUBSCRIBE_STATE_DIR = `/tmp/pi-pr-subscribe-test-${process.pid}`;
	const server = new FakeGh();
	server.checks = overrides.checks ?? [];
	server.issueComments = overrides.issueComments ?? [];
	const delivered: string[] = [];
	const wakes: PrWakePayload[] = [];
	let persisted = 0;
	registry().exec = server.exec;
	registry().deliver = (delivery) => {
		delivered.push(delivery.text);
		wakes.push(delivery.wake);
	};
	registry().persist = () => {
		persisted += 1;
	};
	registry().paint = () => {};
	const snapshot = server.snapshot();
	const sub: Subscription = {
		ref,
		sessionId: "session-1",
		cwd: "/tmp",
		cursor: initCursor(snapshot),
		checks: snapshot.checks,
		state: "open",
		createdAt: Date.now(),
		consecutiveErrors: 0,
		notifiedErrors: [],
		catchUp: false,
		ended: false,
		pending: [],
		pendingLogs: new Map(),
	};
	if (overrides.lock) {
		const acquired = acquireLock(ref, "session-1");
		if (!acquired.ok) throw new Error("expected to acquire the test lock");
		sub.lock = acquired.lock;
	}
	registry().subs.set(prKey(ref), sub);
	const deps: PollerDeps = { cwd: "/tmp", basePollMs: 20_000, coalesceMs: COALESCE_MS, now: () => Date.now() };
	return { server, sub, deps, delivered, wakes, persisted: () => persisted };
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	for (const sub of registry().subs.values()) {
		if (sub.timer) clearTimeout(sub.timer);
		if (sub.flushTimer) clearTimeout(sub.flushTimer);
	}
	resetRegistry();
	resetPollers();
	if (savedDir === undefined) delete process.env.PI_PR_SUBSCRIBE_STATE_DIR;
	else process.env.PI_PR_SUBSCRIBE_STATE_DIR = savedDir;
});

describe("polling", () => {
	it("delivers a new comment once, after the coalesce window", async () => {
		const h = setup();
		h.server.issueComments = [{ id: 10, body: "hello", created_at: "2026-11-15T21:00:00Z" }];
		await tick(h.sub, h.deps);
		expect(h.delivered).toEqual([]);
		expect(h.persisted()).toBeGreaterThan(0);
		vi.advanceTimersByTime(COALESCE_MS);
		expect(h.delivered).toHaveLength(1);
		expect(h.delivered[0]).toContain("hello");
		expect(h.delivered[0]).toContain('event="comment.created"');

		await tick(h.sub, h.deps);
		vi.advanceTimersByTime(COALESCE_MS);
		expect(h.delivered).toHaveLength(1);
	});

	it("keeps the seen ids and the check map on the cursor", async () => {
		const h = setup({ checks: [{ id: 1, name: "review", status: "completed", conclusion: "success" }] });
		await tick(h.sub, h.deps);
		expect(h.sub.cursor.headSha).toBe("aaa");
		expect(h.sub.cursor.checks["check:1"]).toEqual({ status: "completed", conclusion: "success" });
		expect(h.sub.checks).toHaveLength(1);
	});

	it("drops per-run check pings when the settle lands in the same batch", async () => {
		const h = setup({ checks: [{ id: 1, name: "review", status: "in_progress", conclusion: null }] });
		h.server.checks = [{ id: 1, name: "review", status: "completed", conclusion: "failure" }];
		await tick(h.sub, h.deps);
		vi.advanceTimersByTime(COALESCE_MS);
		expect(h.delivered).toHaveLength(1);
		expect(h.delivered[0]).toContain('event="checks.settled"');
		expect(h.delivered[0]).not.toContain('event="check.completed"');
		expect(h.delivered[0]).toContain("failure");
	});

	it("includes a failed log tail when the verdict is not ready yet", async () => {
		const h = setup({ checks: [{ id: 1, name: "review", status: "in_progress", conclusion: null }] });
		h.server.checks = [
			{
				id: 1,
				name: "review",
				status: "completed",
				conclusion: "failure",
				html_url: "https://github.com/o/r/actions/runs/1/job/77",
			},
			{ id: 2, name: "test", status: "in_progress", conclusion: null },
		];
		h.deps.logTail = async (jobId) => (jobId === "77" ? "Error: boom" : undefined);
		await tick(h.sub, h.deps);
		vi.advanceTimersByTime(COALESCE_MS);
		expect(h.delivered[0]).toContain('event="check.completed"');
		expect(h.delivered[0]).toContain("Error: boom");
	});

	it("delivers immediately, and ends, on a merge", async () => {
		const h = setup();
		h.server.pull = { ...h.server.pull, state: "closed", merged: true };
		await tick(h.sub, h.deps);
		expect(h.delivered).toHaveLength(1);
		expect(h.delivered[0]).toContain('event="pr.merged"');
		expect(h.sub.ended).toBe(true);
		expect(getSubscription(ref)).toBeUndefined();
		// The watch ended itself, and that is a release — just never a done one.
		expect(getRelease(ref)).toMatchObject({ done: false, reason: "merged" });
	});

	it("records a close as a release that is not done", async () => {
		const h = setup();
		h.server.pull = { ...h.server.pull, state: "closed", merged: false };
		await tick(h.sub, h.deps);
		expect(h.delivered[0]).toContain('event="pr.closed"');
		expect(getRelease(ref)).toMatchObject({ done: false, reason: "closed" });
	});

	it("labels the first poll after a resume", async () => {
		const h = setup();
		h.sub.catchUp = true;
		h.server.issueComments = [{ id: 10, body: "missed this", created_at: "2026-11-15T21:00:00Z" }];
		await tick(h.sub, h.deps);
		vi.advanceTimersByTime(COALESCE_MS);
		expect(h.delivered[0]).toContain("While you were away");
		expect(h.sub.catchUp).toBe(false);
	});

	it("backs off and reports a persistent failure once", async () => {
		const h = setup();
		h.server.fail = 500;
		await tick(h.sub, h.deps);
		await tick(h.sub, h.deps);
		expect(h.delivered).toEqual([]);
		await tick(h.sub, h.deps);
		vi.advanceTimersByTime(COALESCE_MS);
		expect(h.delivered).toHaveLength(1);
		expect(h.delivered[0]).toContain('event="subscription.error"');
		expect(h.sub.consecutiveErrors).toBe(3);
		expect(h.sub.lastErrorKind).toBe("server");
	});

	it("does not repeat the same error class after a success", async () => {
		const h = setup();
		h.server.fail = 500;
		for (let index = 0; index < 3; index += 1) await tick(h.sub, h.deps);
		vi.advanceTimersByTime(COALESCE_MS);
		h.server.fail = null;
		await tick(h.sub, h.deps);
		expect(h.sub.consecutiveErrors).toBe(0);
		expect(h.sub.notifiedErrors).toEqual([]);
	});

	it("keeps the cursor put when the lock changed hands, then delivers on take-back", async () => {
		const h = setup({ lock: true });
		h.server.issueComments = [{ id: 10, body: "while asleep", created_at: "2026-11-20T21:00:00Z" }];
		// Another session took the PR while this one was suspended.
		const path = lockPath(ref);
		const taken = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		writeFileSync(path, JSON.stringify({ ...taken, sessionId: "session-2" }));

		await tick(h.sub, h.deps);
		expect(h.sub.paused).toBe(true);
		expect(h.sub.blockedBy).toContain("taken over");
		expect(h.delivered).toEqual([]);
		// Nothing was committed: the next owner can diff the same window.
		expect(h.sub.cursor.commentIds).not.toContain("10");

		// The other session stops; take the lock back and resume.
		rmSync(path);
		const again = acquireLock(ref, "session-1");
		if (!again.ok) throw new Error("expected to reclaim the lock");
		h.sub.lock = again.lock;
		h.sub.blockedBy = undefined;
		startPoller(h.sub, h.deps);
		await tick(h.sub, h.deps);
		vi.advanceTimersByTime(COALESCE_MS);
		expect(h.delivered.at(-1)).toContain("while asleep");
		releaseLock(again.lock);
	});

	it("does not wedge when a request never settles", async () => {
		const h = setup();
		const healthy = h.server.exec;
		registry().exec = () => new Promise(() => {});
		const pending = tick(h.sub, h.deps);
		// Past the client's local timeout, the request is abandoned.
		await vi.advanceTimersByTimeAsync(40_000);
		await pending;
		expect(h.sub.lastErrorKind).toBe("network");

		// The next tick polls again instead of early-returning forever.
		registry().exec = healthy;
		h.server.issueComments = [{ id: 10, body: "after the nap", created_at: "2026-11-20T21:00:00Z" }];
		await tick(h.sub, h.deps);
		vi.advanceTimersByTime(COALESCE_MS);
		expect(h.delivered.at(-1)).toContain("after the nap");
	});

	it("holds a batch while a question is open, then sends it", async () => {
		const h = setup();
		h.server.issueComments = [{ id: 10, body: "hello", created_at: "2026-11-15T21:00:00Z" }];
		let blocked = true;
		registry().blocked = () => blocked;
		await tick(h.sub, h.deps);
		vi.advanceTimersByTime(COALESCE_MS);
		expect(h.delivered).toEqual([]);
		expect(registry().deferred).toHaveLength(1);
		blocked = false;
	});
});

describe("expiry", () => {
	it("expires after the quiet window, delivers a notice, and stops polling", async () => {
		const h = setup({ lock: true });
		h.sub.createdAt = Date.now() - (DEFAULT_EXPIRY_MS + 60_000);
		await tick(h.sub, h.deps);

		expect(h.delivered).toHaveLength(1);
		expect(h.delivered[0]).toContain('event="subscription.expired"');
		expect(h.delivered[0]).toContain("/subscribe");
		expect(h.sub.expiredAt).toBeDefined();
		expect(h.sub.paused).toBe(true);
		expect(h.sub.timer).toBeUndefined();
		// It is no longer watching, so it does not hold the PR.
		expect(h.sub.lock).toBeUndefined();
		// The cursor survives for the resume.
		expect(getSubscription(ref)).toBeDefined();
		expect(h.sub.cursor.headSha).toBe("aaa");
	});

	it("does not expire inside the window, or when the PR just spoke", async () => {
		const h = setup();
		h.sub.createdAt = Date.now() - (DEFAULT_EXPIRY_MS - 60_000);
		await tick(h.sub, h.deps);
		expect(h.sub.expiredAt).toBeUndefined();

		const old = setup();
		old.sub.createdAt = Date.now() - (DEFAULT_EXPIRY_MS + 60_000);
		old.sub.lastEventAt = Date.now() - 60_000;
		await tick(old.sub, old.deps);
		expect(old.sub.expiredAt).toBeUndefined();
	});

	it("honors PI_PR_EXPIRY_HOURS", () => {
		expect(expiryMs({})).toBe(DEFAULT_EXPIRY_MS);
		expect(expiryMs({ PI_PR_EXPIRY_HOURS: "2" })).toBe(2 * 60 * 60_000);
		expect(expiryMs({ PI_PR_EXPIRY_HOURS: "nope" })).toBe(DEFAULT_EXPIRY_MS);
		expect(expiryMs({ PI_PR_EXPIRY_HOURS: "0" })).toBe(DEFAULT_EXPIRY_MS);
	});

	it("resumes from the kept cursor after expiry", async () => {
		const h = setup();
		h.sub.createdAt = Date.now() - (DEFAULT_EXPIRY_MS + 60_000);
		await tick(h.sub, h.deps);
		expect(h.sub.expiredAt).toBeDefined();

		// What `/subscribe <n>` does: clear the expiry, set catch-up, poll again.
		h.sub.expiredAt = undefined;
		h.sub.catchUp = true;
		h.server.issueComments = [{ id: 10, body: "missed it", created_at: "2026-11-15T21:00:00Z" }];
		startPoller(h.sub, h.deps);
		await tick(h.sub, h.deps);
		vi.advanceTimersByTime(COALESCE_MS);
		expect(h.delivered.at(-1)).toContain("While you were away");
		expect(h.delivered.at(-1)).toContain("missed it");
	});
});

describe("wake signals", () => {
	it("marks an all-green batch informational", async () => {
		const h = setup({ checks: [{ id: 1, name: "test", status: "in_progress", conclusion: null }] });
		h.server.checks = [{ id: 1, name: "test", status: "completed", conclusion: "success" }];
		await tick(h.sub, h.deps);
		vi.advanceTimersByTime(COALESCE_MS);
		expect(h.wakes).toHaveLength(1);
		expect(h.wakes[0]).toMatchObject({
			owner: "AutumnsGrove",
			repo: "pi-extensions",
			pullNumber: 32,
			informational: true,
		});
		expect(h.wakes[0]?.eventTypes).toContain("checks.settled");
		expect(h.wakes[0]?.summary).toContain("checks settled");
	});

	it("marks a failure or a comment as needing attention", async () => {
		const failed = setup({ checks: [{ id: 1, name: "test", status: "in_progress", conclusion: null }] });
		failed.server.checks = [{ id: 1, name: "test", status: "completed", conclusion: "failure" }];
		await tick(failed.sub, failed.deps);
		vi.advanceTimersByTime(COALESCE_MS);
		expect(failed.wakes[0]?.informational).toBe(false);

		const commented = setup();
		commented.server.issueComments = [{ id: 10, body: "please fix", created_at: "2026-11-15T21:00:00Z" }];
		await tick(commented.sub, commented.deps);
		vi.advanceTimersByTime(COALESCE_MS);
		expect(commented.wakes[0]).toMatchObject({
			informational: false,
			eventTypes: ["comment.created"],
		});
	});

	it("emits one wake per delivery, not per event", async () => {
		const h = setup({ checks: [{ id: 1, name: "a", status: "in_progress", conclusion: null }] });
		h.server.checks = [
			{ id: 1, name: "a", status: "completed", conclusion: "success" },
			{ id: 2, name: "b", status: "completed", conclusion: "success" },
		];
		await tick(h.sub, h.deps);
		vi.advanceTimersByTime(COALESCE_MS);
		expect(h.delivered).toHaveLength(1);
		expect(h.wakes).toHaveLength(1);
	});

	it("marks an expiry notice, and delivers it immediately", async () => {
		const h = setup();
		h.sub.createdAt = Date.now() - (DEFAULT_EXPIRY_MS + 60_000);
		await tick(h.sub, h.deps);
		expect(h.wakes).toHaveLength(1);
		expect(h.wakes[0]).toMatchObject({ informational: false, eventTypes: ["subscription.expired"] });
	});

	it("never wakes for a head move on its own", async () => {
		const h = setup();
		h.server.pull = { ...h.server.pull, head: { sha: "bbb", ref: "feat" } };
		await tick(h.sub, h.deps);
		vi.advanceTimersByTime(COALESCE_MS);
		expect(h.delivered).toEqual([]);
		expect(h.wakes).toEqual([]);
		// The cursor moved, so the next poll does not re-report the same push.
		expect(h.sub.cursor.headSha).toBe("bbb");
		expect(h.persisted()).toBeGreaterThan(0);
	});

	it("keeps the new head's checks loud, and drops the head move from that batch", async () => {
		const h = setup();
		h.server.pull = { ...h.server.pull, head: { sha: "bbb", ref: "feat" } };
		h.server.checks = [
			{ id: 3, name: "test", status: "completed", conclusion: "failure" },
			{ id: 4, name: "slow", status: "in_progress", conclusion: null },
		];
		await tick(h.sub, h.deps);
		vi.advanceTimersByTime(COALESCE_MS);
		expect(h.wakes[0]).toMatchObject({ informational: false, eventTypes: ["check.completed"] });
		expect(h.delivered[0]).not.toContain("The head moved");
		expect(h.delivered[0]).toContain('Check "test" finished: failure');
	});

	it("keeps the echo of the session's own post quiet", async () => {
		const h = setup();
		h.sub.ownPostAt = Date.now();
		h.server.issueComments = [
			{
				id: 21,
				body: "on it",
				user: { login: "AutumnsGrove" },
				created_at: new Date().toISOString(),
			},
		];
		await tick(h.sub, h.deps);
		vi.advanceTimersByTime(COALESCE_MS);
		expect(h.delivered).toEqual([]);
		expect(h.wakes).toEqual([]);
		expect(h.sub.cursor.commentIds).toContain("21");
	});

	it("still delivers a comment from someone else at the same moment", async () => {
		const h = setup();
		h.sub.ownPostAt = Date.now();
		h.server.issueComments = [
			{
				id: 22,
				body: "one more thing",
				user: { login: "pi-review-autumnsgrove[bot]", type: "Bot" },
				created_at: new Date().toISOString(),
			},
		];
		await tick(h.sub, h.deps);
		vi.advanceTimersByTime(COALESCE_MS);
		expect(h.wakes[0]).toMatchObject({ informational: false, eventTypes: ["comment.created"] });
	});

	it("does not ask for the login unless the session posted", async () => {
		const h = setup();
		h.server.issueComments = [{ id: 23, body: "hello", created_at: "2026-11-15T21:00:00Z" }];
		await tick(h.sub, h.deps);
		expect(h.server.calls).not.toContain("user");

		const posted = setup();
		posted.sub.ownPostAt = Date.now();
		await tick(posted.sub, posted.deps);
		await tick(posted.sub, posted.deps);
		// One request for the session: the answer cannot change under it.
		expect(posted.server.calls.filter((call) => call === "user")).toHaveLength(1);
	});

	it("forgets a post hint that has aged out", async () => {
		const h = setup();
		h.sub.ownPostAt = Date.now() - 7 * 60_000;
		h.server.issueComments = [
			{ id: 24, body: "on it", user: { login: "AutumnsGrove" }, created_at: new Date().toISOString() },
		];
		await tick(h.sub, h.deps);
		vi.advanceTimersByTime(COALESCE_MS);
		expect(h.wakes[0]).toMatchObject({ eventTypes: ["comment.created"] });
		expect(h.sub.ownPostAt).toBeUndefined();
		expect(h.server.calls).not.toContain("user");
	});

	it("keeps a comment loud when it lands with a head move", async () => {
		const h = setup();
		h.server.pull = { ...h.server.pull, head: { sha: "bbb", ref: "feat" } };
		h.server.issueComments = [{ id: 10, body: "one more thing", created_at: "2026-11-15T21:00:00Z" }];
		await tick(h.sub, h.deps);
		vi.advanceTimersByTime(COALESCE_MS);
		expect(h.wakes[0]).toMatchObject({ informational: false, eventTypes: ["comment.created"] });
	});
});

describe("pollInterval", () => {
	const sub = (): Subscription => ({
		ref,
		sessionId: "s",
		cwd: "/tmp",
		cursor: initCursor({ pull: { number: 1, title: "", url: "", state: "open", merged: false, draft: false, headSha: "a", headRef: "", baseRef: "", authorBot: false }, checks: [], comments: [], reviews: [] }),
		checks: [],
		state: "open",
		createdAt: Date.now(),
		consecutiveErrors: 0,
		notifiedErrors: [],
		catchUp: false,
		ended: false,
		pending: [],
		pendingLogs: new Map(),
	});

	it("polls fast with pending checks, slower when settled, slowest when quiet", () => {
		const deps: PollerDeps = { cwd: "/tmp", basePollMs: DEFAULT_BASE_POLL_MS };
		const pending = sub();
		pending.checks = [{ key: "a", name: "a", status: "in_progress", conclusion: null }];
		expect(pollInterval(pending, deps, 10_000)).toBe(20_000);

		// Ten minutes after an event, a settled PR still polls at the base rate.
		const settled = sub();
		settled.checks = [{ key: "a", name: "a", status: "completed", conclusion: "success" }];
		settled.lastEventAt = 10_000;
		expect(pollInterval(settled, deps, 10_000 + ACTIVE_AFTER_MS - 1)).toBe(20_000);
		expect(pollInterval(settled, deps, 10_000 + ACTIVE_AFTER_MS + 1)).toBe(60_000);

		settled.lastEventAt = 1;
		expect(pollInterval(settled, deps, 2 * 60 * 60_000)).toBe(300_000);
	});

	it("backs off even when no event ever fired", () => {
		const deps: PollerDeps = { cwd: "/tmp", basePollMs: DEFAULT_BASE_POLL_MS };
		const quiet = sub();
		quiet.checks = [{ key: "a", name: "a", status: "completed", conclusion: "success" }];
		quiet.createdAt = 1;
		expect(quiet.lastEventAt).toBeUndefined();
		expect(pollInterval(quiet, deps, 2 * 60 * 60_000)).toBe(300_000);
		expect(pollInterval(quiet, deps, ACTIVE_AFTER_MS + 2)).toBe(60_000);
	});
});

describe("describeEvent", () => {
	it("names the last thing that happened", () => {
		expect(
			describeEvent({ type: "comment.created", comment: { id: "1", kind: "issue", author: "x", bot: false, body: "" } })
		).toBe("comment by x");
		expect(
			describeEvent({ type: "review.submitted", review: { id: "1", bot: true, author: "bot[bot]", state: "APPROVED", body: "" } })
		).toBe("review by bot[bot]");
		expect(describeEvent({ type: "checks.settled", headSha: "a", state: "success", total: 1, failed: [], definition: "all", missingRequired: [] })).toBe("checks success");
		expect(describeEvent(undefined)).toBeUndefined();
	});
});
