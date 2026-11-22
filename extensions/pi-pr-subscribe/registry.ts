/**
 * The subscription registry, and the one-session-per-PR lock.
 *
 * State lives on `globalThis` so a `/reload` keeps every poller running: the
 * module is re-evaluated, but the subscriptions, their cursors, and their
 * pending deliveries are the same objects. The delivery function is looked up
 * from the registry at call time for exactly that reason — after a reload it
 * points at the new `pi`.
 *
 * The lock is a file, because a second pi process is not prevented by
 * `globalThis`. A PR's events go to one session at a time; a second session
 * subscribes successfully and is told it will not receive events. The holder
 * refreshes the heartbeat on every poll, and a stale heartbeat (or a dead pid)
 * releases the lock so a crashed session cannot wedge a PR forever.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { join } from "node:path";
import type { Cursor, ErrorKind, PrEvent } from "./diff.ts";
import type { Exec } from "./gh.ts";
import { prKey, type PrRef } from "./ref.ts";
import type { CheckEntry, PullState } from "./snapshot.ts";
import type { PrWakePayload } from "../_shared/hook-events.ts";

export const LOCK_STALE_MS = 5 * 60_000;
export const MAX_SUBSCRIPTIONS = 5;

export interface LockInfo {
	pid: number;
	host: string;
	sessionId: string;
	startedAt: number;
	heartbeatAt: number;
	path?: string;
}

export interface Subscription {
	ref: PrRef;
	sessionId: string;
	cwd: string;
	cursor: Cursor;
	/** Last snapshot's checks, for the widget and `/subscribe`. */
	checks: CheckEntry[];
	title?: string;
	state: PullState;
	draft?: boolean;
	author?: string;
	required?: string[];
	createdAt: number;
	lastPollAt?: number;
	nextPollAt?: number;
	/** Human phrase for the widget, e.g. "review by pi-review[bot]". */
	lastEvent?: string;
	lastEventAt?: number;
	lastError?: string;
	lastErrorKind?: ErrorKind;
	consecutiveErrors: number;
	notifiedErrors: ErrorKind[];
	/** First poll after a resume reports "while you were away". */
	catchUp: boolean;
	/** Set when the subscription expired after a long silence. Kept so it can resume. */
	expiredAt?: number;
	lock?: LockInfo;
	/** True once the lock is held by another session. */
	blockedBy?: string;
	/** Timers are off; the session-level retry may resume it. */
	paused?: boolean;
	ended: boolean;
	timer?: ReturnType<typeof setTimeout>;
	flushTimer?: ReturnType<typeof setTimeout>;
	pending: PrEvent[];
	pendingLogs: Map<string, string>;
	/**
	 * Heads this batch proved are the session's own pushes, cleared when the
	 * batch is delivered. Never persisted: it describes a wake, not a watch.
	 */
	ownHeads?: Set<string>;
}

export interface RegistryState {
	subs: Map<string, Subscription>;
	/** Last deliberate release per PR, so a done release is visible afterwards. */
	releases: Map<string, ReleaseInfo>;
	/** Batches held while a `pi-q-n-a` form is open. */
	deferred: Delivery[];
	/** Set by the extension on every session start, so a reload can swap it. */
	deliver: ((delivery: Delivery) => void) | undefined;
	exec: Exec | undefined;
	paint: (() => void) | undefined;
	persist: (() => void) | undefined;
	blocked: (() => boolean) | undefined;
}

/** One delivery: the message the agent gets and the signal consumers get with it. */
export interface Delivery {
	text: string;
	wake: PrWakePayload;
}

const REGISTRY_KEY = Symbol.for("pi-extensions.pr-subscribe");

type RegistryHolder = typeof globalThis & { [REGISTRY_KEY]?: RegistryState };

/**
 * A new session and a `/reload` both re-evaluate this module while keeping
 * `globalThis`, so the object under the key can be older than the code reading
 * it. Every field therefore has to survive being absent, not just on the first
 * call: `??=` on the holder only ever initializes once per process.
 *
 * The failure this prevents is silent until it is not — a registry from a build
 * without `releases` made a deliberate done release throw
 * `Cannot read properties of undefined (reading 'set')` *after* the watch had
 * already been stopped, so the tool reported an error and recorded nothing.
 */
export function registry(): RegistryState {
	const holder = globalThis as RegistryHolder;
	holder[REGISTRY_KEY] ??= {
		subs: new Map(),
		releases: new Map(),
		deferred: [],
		deliver: undefined,
		exec: undefined,
		paint: undefined,
		persist: undefined,
		blocked: undefined,
	};
	const state = holder[REGISTRY_KEY];
	state.subs ??= new Map();
	state.releases ??= new Map();
	state.deferred ??= [];
	return state;
}

/** Tests only: drop the global registry. */
export function resetRegistry(): void {
	// Delete rather than empty: a test that starts from a half-shaped object is
	// exactly the bug above, and it must not be reachable from a fresh test.
	delete (globalThis as RegistryHolder)[REGISTRY_KEY];
}

export function listSubscriptions(sessionId?: string): Subscription[] {
	const subs = [...registry().subs.values()].filter((sub) => !sub.ended);
	if (sessionId === undefined) return subs;
	return subs.filter((sub) => sub.sessionId === sessionId);
}

export function getSubscription(ref: PrRef): Subscription | undefined {
	return registry().subs.get(prKey(ref));
}

export function addSubscription(sub: Subscription): void {
	registry().subs.set(prKey(sub.ref), sub);
}

export function removeSubscription(ref: PrRef): void {
	registry().subs.delete(prKey(ref));
}

// ---------------------------------------------------------------------------
// Deliberate releases
// ---------------------------------------------------------------------------

/**
 * Why a subscription ended on purpose.
 *
 * `done` is the agent's own verdict that the PR is finished; `false` covers a
 * plain unsubscribe, a merge, a close, and an expiry. Keeping the record after
 * the subscription is gone is what makes a deliberate release visible in
 * `/subscribe status` and distinguishable from a stray one.
 */
export interface ReleaseInfo {
	ref: PrRef;
	done: boolean;
	reason?: string;
	at: number;
}

export const MAX_RELEASE_REASON = 300;

export function normalizeReleaseReason(reason: string | undefined): string | undefined {
	if (typeof reason !== "string") return undefined;
	const collapsed = reason.replace(/\s+/g, " ").trim();
	if (!collapsed) return undefined;
	return collapsed.length > MAX_RELEASE_REASON
		? `${collapsed.slice(0, MAX_RELEASE_REASON - 1)}…`
		: collapsed;
}

export function recordRelease(ref: PrRef, info: { done: boolean; reason?: string; at?: number }): ReleaseInfo {
	const reason = normalizeReleaseReason(info.reason);
	const release: ReleaseInfo = {
		ref,
		done: info.done,
		...(reason ? { reason } : {}),
		at: info.at ?? Date.now(),
	};
	registry().releases.set(prKey(ref), release);
	return release;
}

export function getRelease(ref: PrRef): ReleaseInfo | undefined {
	return registry().releases.get(prKey(ref));
}

export function listReleases(): ReleaseInfo[] {
	return [...registry().releases.values()].sort((a, b) => b.at - a.at);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface PersistedSubscription {
	owner: string;
	repo: string;
	number: number;
	cursor: Cursor;
	required?: string[];
	cwd: string;
	sessionId: string;
	createdAt: number;
	/** An expired subscription keeps its cursor but does not poll until resumed. */
	expiredAt?: number;
}

/** Serializable state for `pi.appendEntry`. Pending events are not persisted. */
export function persistedSubscriptions(sessionId?: string): PersistedSubscription[] {
	return listSubscriptions(sessionId).map((sub) => ({
		owner: sub.ref.owner,
		repo: sub.ref.repo,
		number: sub.ref.number,
		cursor: sub.cursor,
		...(sub.required ? { required: sub.required } : {}),
		cwd: sub.cwd,
		sessionId: sub.sessionId,
		createdAt: sub.createdAt,
		...(sub.expiredAt ? { expiredAt: sub.expiredAt } : {}),
	}));
}

export function isPersistedRelease(value: unknown): value is ReleaseInfo {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	const ref = record.ref as Record<string, unknown> | undefined;
	return (
		typeof ref === "object" &&
		ref !== null &&
		typeof ref.owner === "string" &&
		typeof ref.repo === "string" &&
		typeof ref.number === "number" &&
		typeof record.done === "boolean" &&
		typeof record.at === "number"
	);
}

export function isPersistedSubscription(value: unknown): value is PersistedSubscription {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.owner === "string" &&
		typeof record.repo === "string" &&
		typeof record.number === "number" &&
		typeof record.cursor === "object" &&
		record.cursor !== null &&
		typeof (record.cursor as { headSha?: unknown }).headSha === "string"
	);
}

export function subscriptionFromPersisted(
	value: PersistedSubscription,
	fallbackSessionId: string
): Subscription {
	return {
		ref: { owner: value.owner, repo: value.repo, number: value.number },
		sessionId: value.sessionId || fallbackSessionId,
		cwd: value.cwd,
		cursor: value.cursor,
		checks: [],
		state: value.cursor.state,
		...(value.required ? { required: value.required } : {}),
		createdAt: value.createdAt ?? Date.now(),
		...(value.expiredAt ? { expiredAt: value.expiredAt } : {}),
		consecutiveErrors: 0,
		notifiedErrors: [],
		catchUp: true,
		ended: false,
		pending: [],
		pendingLogs: new Map(),
	};
}

// ---------------------------------------------------------------------------
// Lock file
// ---------------------------------------------------------------------------

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.PI_PR_SUBSCRIBE_STATE_DIR?.trim();
	if (override) return override.replace(/^~(?=$|\/)/, homedir());
	return join(homedir(), ".pi", "agent", "pr-subscribe");
}

const safeName = (value: string): string => value.replace(/[^A-Za-z0-9_.-]+/g, "-");

export function lockPath(ref: PrRef, env: NodeJS.ProcessEnv = process.env): string {
	return join(stateDir(env), `${safeName(ref.owner)}-${safeName(ref.repo)}-${ref.number}.lock.json`);
}

const pidAlive = (pid: number): boolean => {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to someone else.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};

export function readLock(ref: PrRef, env: NodeJS.ProcessEnv = process.env): LockInfo | undefined {
	const path = lockPath(ref, env);
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockInfo>;
		if (
			typeof parsed.pid !== "number" ||
			typeof parsed.sessionId !== "string" ||
			typeof parsed.heartbeatAt !== "number"
		) {
			return undefined;
		}
		return {
			pid: parsed.pid,
			host: typeof parsed.host === "string" ? parsed.host : "",
			sessionId: parsed.sessionId,
			startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : parsed.heartbeatAt,
			heartbeatAt: parsed.heartbeatAt,
			path,
		};
	} catch {
		return undefined;
	}
}

export function isLockStale(lock: LockInfo, now = Date.now()): boolean {
	// A lock from another machine cannot be checked by pid; only the heartbeat.
	if (lock.host && lock.host !== hostname()) return now - lock.heartbeatAt > LOCK_STALE_MS;
	if (!pidAlive(lock.pid)) return true;
	return now - lock.heartbeatAt > LOCK_STALE_MS;
}

export type AcquireResult =
	| { ok: true; lock: LockInfo }
	| { ok: false; holder: LockInfo };

export function acquireLock(
	ref: PrRef,
	sessionId: string,
	now = Date.now(),
	env: NodeJS.ProcessEnv = process.env
): AcquireResult {
	const path = lockPath(ref, env);
	const existing = readLock(ref, env);
	if (existing && !isLockStale(existing, now)) {
		return { ok: false, holder: existing };
	}
	const lock: LockInfo = {
		pid: process.pid,
		host: hostname(),
		sessionId,
		startedAt: existing?.sessionId === sessionId ? existing.startedAt : now,
		heartbeatAt: now,
		path,
	};
	try {
		mkdirSync(stateDir(env), { recursive: true });
		writeFileSync(path, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
	} catch {
		// A read-only home should not stop the watch: the in-process registry is
		// still correct, only cross-process exclusion is lost.
	}
	return { ok: true, lock };
}

/**
 * Refresh the heartbeat, unless the lock is no longer ours.
 *
 * A suspended laptop stops heartbeating; after five minutes another session may
 * legitimately take the lock. Writing our heartbeat over theirs would give two
 * sessions the same PR, so an ownership check comes first and `undefined` means
 * "we lost it".
 */
export function touchLock(lock: LockInfo, now = Date.now()): LockInfo | undefined {
	const next = { ...lock, heartbeatAt: now };
	if (!next.path) return next;
	const current = readLockByPath(next.path);
	if (current && (current.pid !== next.pid || current.sessionId !== next.sessionId)) return undefined;
	try {
		writeFileSync(next.path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	} catch {
		// Ignore: the heartbeat is an optimization, not a correctness barrier.
	}
	return next;
}

export function releaseLock(lock: LockInfo | undefined): void {
	if (!lock?.path || !existsSync(lock.path)) return;
	// Only delete a lock this process still believes it owns.
	const current = readLockByPath(lock.path);
	if (current && (current.pid !== process.pid || current.sessionId !== lock.sessionId)) return;
	try {
		unlinkSync(lock.path);
	} catch {
		// Already gone.
	}
}

function readLockByPath(path: string): LockInfo | undefined {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockInfo>;
		if (typeof parsed.pid !== "number" || typeof parsed.sessionId !== "string") return undefined;
		return {
			pid: parsed.pid,
			host: typeof parsed.host === "string" ? parsed.host : "",
			sessionId: parsed.sessionId,
			startedAt: typeof parsed.startedAt === "number" ? parsed.startedAt : 0,
			heartbeatAt: typeof parsed.heartbeatAt === "number" ? parsed.heartbeatAt : 0,
			path,
		};
	} catch {
		return undefined;
	}
}
