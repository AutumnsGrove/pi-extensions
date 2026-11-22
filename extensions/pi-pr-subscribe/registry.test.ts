import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initCursor } from "./diff.ts";
import {
	LOCK_STALE_MS,
	MAX_RELEASE_REASON,
	acquireLock,
	getRelease,
	isLockStale,
	isPersistedRelease,
	isPersistedSubscription,
	listReleases,
	listSubscriptions,
	lockPath,
	normalizeReleaseReason,
	persistedSubscriptions,
	readLock,
	recordRelease,
	registry,
	releaseLock,
	resetRegistry,
	stateDir,
	subscriptionFromPersisted,
	touchLock,
	type Subscription,
} from "./registry.ts";
import type { Snapshot } from "./snapshot.ts";

const ref = { owner: "AutumnsGrove", repo: "pi-extensions", number: 32 };
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-pr-subscribe-"));
	process.env.PI_PR_SUBSCRIBE_STATE_DIR = dir;
	resetRegistry();
});

afterEach(() => {
	resetRegistry();
	delete process.env.PI_PR_SUBSCRIBE_STATE_DIR;
	rmSync(dir, { recursive: true, force: true });
});

const snapshot = (): Snapshot => ({
	pull: {
		number: 32,
		title: "feat",
		url: "u",
		state: "open",
		merged: false,
		draft: false,
		headSha: "abc",
		headRef: "b",
		baseRef: "main",
		authorBot: false,
	},
	checks: [],
	comments: [],
	reviews: [],
});

const sub = (): Subscription => ({
	ref,
	sessionId: "session-1",
	cwd: "/tmp",
	cursor: initCursor(snapshot()),
	checks: [],
	state: "open",
	createdAt: 1,
	consecutiveErrors: 0,
	notifiedErrors: [],
	catchUp: false,
	ended: false,
	pending: [],
	pendingLogs: new Map(),
});

describe("lock", () => {
	it("lives under the state dir and is acquired once", () => {
		expect(stateDir()).toBe(dir);
		const first = acquireLock(ref, "session-1", 1000);
		expect(first.ok).toBe(true);
		expect(readLock(ref)).toMatchObject({ pid: process.pid, sessionId: "session-1" });

		const second = acquireLock(ref, "session-2", 2000);
		expect(second.ok).toBe(false);
		if (!second.ok) expect(second.holder.sessionId).toBe("session-1");
	});

	it("is released only by its owner", () => {
		const acquired = acquireLock(ref, "session-1", 1000);
		if (!acquired.ok) throw new Error("expected a lock");
		releaseLock({ ...acquired.lock, sessionId: "someone-else" });
		expect(readLock(ref)).toBeDefined();
		releaseLock(acquired.lock);
		expect(readLock(ref)).toBeUndefined();
	});

	it("expires a stale heartbeat or a dead pid", () => {
		const acquired = acquireLock(ref, "session-1", 1000);
		if (!acquired.ok) throw new Error("expected a lock");
		const stale = { ...acquired.lock, heartbeatAt: 1000 - LOCK_STALE_MS - 1 };
		writeFileSync(lockPath(ref), JSON.stringify(stale));
		expect(isLockStale(stale, 1000)).toBe(true);
		expect(acquireLock(ref, "session-2", 1000).ok).toBe(true);

		const dead = { ...acquired.lock, pid: 999_999, heartbeatAt: 1000 };
		writeFileSync(lockPath(ref), JSON.stringify(dead));
		expect(isLockStale(dead, 1000)).toBe(true);
		expect(acquireLock(ref, "session-3", 1000).ok).toBe(true);
	});

	it("refreshes the heartbeat on touch", () => {
		const acquired = acquireLock(ref, "session-1", 1000);
		if (!acquired.ok) throw new Error("expected a lock");
		const touched = touchLock(acquired.lock, 9000);
		expect(touched?.heartbeatAt).toBe(9000);
		expect(JSON.parse(readFileSync(lockPath(ref), "utf8")).heartbeatAt).toBe(9000);
	});

	it("refuses to heartbeat a lock another session took", () => {
		const acquired = acquireLock(ref, "session-1", 1000);
		if (!acquired.ok) throw new Error("expected a lock");
		writeFileSync(lockPath(ref), JSON.stringify({ ...acquired.lock, pid: process.pid, sessionId: "session-2" }));
		expect(touchLock(acquired.lock, 9000)).toBeUndefined();
		expect(JSON.parse(readFileSync(lockPath(ref), "utf8")).sessionId).toBe("session-2");
	});

	it("treats an unreadable lock file as no lock", () => {
		writeFileSync(lockPath(ref), "not json");
		expect(readLock(ref)).toBeUndefined();
	});
});

describe("registry", () => {
	it("lists only live subscriptions for a session", () => {
		const one = sub();
		const two = { ...sub(), sessionId: "session-2", ref: { ...ref, number: 33 } };
		const ended = { ...sub(), ended: true, ref: { ...ref, number: 34 } };
		registry().subs.set("a", one);
		registry().subs.set("b", two);
		registry().subs.set("c", ended);
		expect(listSubscriptions("session-1")).toEqual([one]);
		expect(listSubscriptions("session-2")).toEqual([two]);
		expect(listSubscriptions()).toHaveLength(2);
	});

	it("persists and restores a subscription", () => {
		const original = sub();
		registry().subs.set("a", original);
		const persisted = persistedSubscriptions("session-1");
		expect(persisted).toHaveLength(1);
		expect(isPersistedSubscription(persisted[0])).toBe(true);

		const restored = subscriptionFromPersisted(persisted[0]!, "session-9");
		expect(restored.ref).toEqual(ref);
		expect(restored.cursor).toEqual(original.cursor);
		expect(restored.catchUp).toBe(true);
		expect(restored.pending).toEqual([]);
	});

	it("rejects a persisted shape without a cursor", () => {
		expect(isPersistedSubscription({ owner: "o", repo: "r", number: 1 })).toBe(false);
		expect(isPersistedSubscription({ owner: "o", repo: "r", number: 1, cursor: {} })).toBe(false);
		expect(isPersistedSubscription(null)).toBe(false);
	});

	it("keeps an expiry timestamp through persist and restore", () => {
		registry().subs.set("a", { ...sub(), expiredAt: 99 });
		const persisted = persistedSubscriptions("session-1");
		expect(persisted[0]?.expiredAt).toBe(99);
		expect(subscriptionFromPersisted(persisted[0]!, "session-1").expiredAt).toBe(99);
	});
});

describe("releases", () => {
	it("records a done release with a collapsed, capped reason", () => {
		const release = recordRelease(ref, { done: true, reason: `  green,   reviews\naddressed  ` });
		expect(release).toMatchObject({ done: true, reason: "green, reviews addressed" });
		expect(getRelease(ref)).toEqual(release);
		expect(listReleases()).toHaveLength(1);
	});

	it("records a plain unsubscribe as not done, and keeps both per PR", () => {
		recordRelease(ref, { done: true, reason: "done", at: 2 });
		const later = recordRelease(ref, { done: false, at: 3 });
		expect(getRelease(ref)).toBe(later);
		expect(getRelease(ref)?.reason).toBeUndefined();
		const other = recordRelease({ ...ref, number: 33 }, { done: false, at: 1 });
		expect(listReleases().map((release) => release.ref.number)).toEqual([32, 33]);
		expect(other.done).toBe(false);
	});

	it("normalizes whitespace, empty, and long reasons", () => {
		expect(normalizeReleaseReason(undefined)).toBeUndefined();
		expect(normalizeReleaseReason("   \n ")).toBeUndefined();
		const long = "x".repeat(MAX_RELEASE_REASON + 50);
		const capped = normalizeReleaseReason(long) ?? "";
		expect(capped).toHaveLength(MAX_RELEASE_REASON);
		expect(capped.endsWith("…")).toBe(true);
	});

	it("heals a registry an older module instance left on globalThis", () => {
		// A new session or a `/reload` re-evaluates this module but keeps the
		// object under `Symbol.for(...)`, so the field can predate the code that
		// reads it: `releases` arrived after the first release of the extension.
		const state = registry() as { releases?: unknown };
		delete state.releases;
		expect(() => recordRelease(ref, { done: true, reason: "green" })).not.toThrow();
		expect(getRelease(ref)).toMatchObject({ done: true, reason: "green" });
	});

	it("validates a persisted release", () => {
		expect(isPersistedRelease({ ref, done: true, at: 1 })).toBe(true);
		expect(isPersistedRelease({ ref, at: 1 })).toBe(false);
		expect(isPersistedRelease({ ref, done: true })).toBe(false);
		expect(isPersistedRelease(null)).toBe(false);
	});
});
