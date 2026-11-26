/**
 * The poll loop.
 *
 * One timer per subscription, one API client per session, and a cursor that is
 * only replaced after a successful diff. A failed tick leaves the cursor where
 * it was, so the next successful tick re-reports everything: at-least-once is
 * the right failure mode for a notification.
 *
 * Interval: fast while checks are pending, slower once they settle, slowest
 * once the PR has been quiet for an hour. `PI_PR_POLL` (seconds) overrides the
 * base, which is what the tests use to keep a poll cheap.
 *
 * Coalescing: events that arrive together are delivered as one message after a
 * short window, and a per-run `check.completed` is dropped when `checks.settled`
 * lands in the same window. One push should not become a dozen turns.
 *
 * Everything the loop calls back into pi goes through the registry, so a
 * `/reload` can replace `pi.exec` and `pi.sendMessage` under a running poller.
 */

import {
	diffSnapshot,
	isTerminal,
	OWN_POST_WINDOW_MS,
	type Cursor,
	type ErrorKind,
	type OwnPost,
	type PrEvent,
} from "./diff.ts";
import {
	GhApi,
	GhApiError,
	fetchJobLog,
	fetchSnapshot,
	requiredChecks,
	viewerLogin,
	type Exec,
} from "./gh.ts";
import { formatBatch } from "./format.ts";
import { prKey } from "./ref.ts";
import { checkSummary, oldestFirst, type Snapshot } from "./snapshot.ts";
import { wakePayload } from "./wake.ts";
import {
	recordRelease,
	releaseLock,
	removeSubscription,
	registry,
	touchLock,
	type Delivery,
	type Subscription,
} from "./registry.ts";

export const DEFAULT_BASE_POLL_MS = 20_000;
export const COALESCE_MS = 5_000;
/** Keep the fast rate for this long after any event, so a push is noticed quickly. */
export const ACTIVE_AFTER_MS = 10 * 60_000;
export const QUIET_AFTER_MS = 60 * 60_000;
export const MAX_POLL_MS = 300_000;
export const MAX_LOG_FETCHES = 3;
/**
 * A subscription that sees nothing for this long ends itself, so an agent that
 * forgets to release cannot hold a paid runner up forever. The cursor is kept,
 * and `/subscribe <n>` resumes it with the usual catch-up.
 */
export const DEFAULT_EXPIRY_MS = 6 * 60 * 60_000;

/** `PI_PR_EXPIRY_HOURS` overrides the quiet window; silence or garbage keeps the default. */
export function expiryMs(env: NodeJS.ProcessEnv = process.env): number {
	const hours = Number(env.PI_PR_EXPIRY_HOURS);
	return Number.isFinite(hours) && hours > 0 ? hours * 60 * 60_000 : DEFAULT_EXPIRY_MS;
}

const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "error"]);

export interface PollerDeps {
	/** Defaults for a new API client; the client itself is per session. */
	cwd: string;
	basePollMs?: number;
	coalesceMs?: number;
	/** Quiet window before the subscription expires. Defaults to six hours. */
	expiryMs?: number;
	now?: () => number;
	/** Injected in tests; production uses `fetchJobLog`. */
	logTail?: (jobId: string) => Promise<string | undefined>;
}

const apis = new Map<string, GhApi>();
/** When a poll started. A stale entry is treated as abandoned, not as a lock. */
const inFlight = new Map<string, number>();
const inFlightTokens = new Map<string, symbol>();
export const WEDGED_INFLIGHT_MS = 120_000;

/** One client per session, so ETags survive across polls and reloads. */
export function apiFor(sessionId: string, deps: PollerDeps, exec?: Exec): GhApi {
	const existing = apis.get(sessionId);
	if (existing && !exec) return existing;
	const client = new GhApi({
		exec:
			exec ??
			((command, args, options) => {
				const runner = registry().exec;
				if (!runner) throw new Error("pi.exec is not available");
				return runner(command, args, options);
			}),
		cwd: deps.cwd,
		now: deps.now,
	});
	apis.set(sessionId, client);
	return client;
}

/** Tests only. */
export function resetPollers(): void {
	apis.clear();
	inFlight.clear();
	inFlightTokens.clear();
}

export function apiForget(sessionId: string): void {
	apis.delete(sessionId);
}

const now = (deps: PollerDeps): number => deps.now?.() ?? Date.now();

/**
 * Pending checks poll at the base rate. A PR that settled keeps that rate for
 * ten minutes, because a push is exactly when the user is watching and a
 * one-minute blind spot after every commit is noticeable. After that it drops to
 * three times the base, and to fifteen times once the PR has been quiet an hour.
 */
export function pollInterval(sub: Subscription, deps: PollerDeps, at = now(deps)): number {
	const base = deps.basePollMs ?? DEFAULT_BASE_POLL_MS;
	const summary = checkSummary(sub.checks);
	if (summary.pending > 0) return base;
	// Subscribe counts as activity: a PR that never produced an event must still
	// back off, or a forgotten subscription spawns gh every 20 s forever.
	const sinceEvent = at - (sub.lastEventAt ?? sub.createdAt);
	if (sinceEvent < ACTIVE_AFTER_MS) return base;
	if (sinceEvent < QUIET_AFTER_MS) return Math.min(base * 3, MAX_POLL_MS);
	return Math.min(base * 15, MAX_POLL_MS);
}

export function startPoller(sub: Subscription, deps: PollerDeps): void {
	if (sub.ended) return;
	sub.paused = false;
	schedule(sub, deps, 0);
}

/** Stop the timer without ending the subscription, so it can be resumed. */
export function pausePoller(sub: Subscription): void {
	sub.paused = true;
	if (sub.timer) clearTimeout(sub.timer);
	sub.timer = undefined;
	if (sub.flushTimer) clearTimeout(sub.flushTimer);
	sub.flushTimer = undefined;
	inFlight.delete(prKey(sub.ref));
}

export function stopPoller(sub: Subscription): void {
	sub.ended = true;
	if (sub.timer) clearTimeout(sub.timer);
	sub.timer = undefined;
	if (sub.flushTimer) clearTimeout(sub.flushTimer);
	sub.flushTimer = undefined;
	inFlight.delete(prKey(sub.ref));
	inFlightTokens.delete(prKey(sub.ref));
}

function schedule(sub: Subscription, deps: PollerDeps, delay: number): void {
	if (sub.ended || sub.paused) return;
	if (sub.timer) clearTimeout(sub.timer);
	sub.nextPollAt = now(deps) + delay;
	sub.timer = setTimeout(() => {
		sub.timer = undefined;
		void tick(sub, deps);
	}, delay);
	sub.timer.unref?.();
}

/** One poll. Never throws; failures become a delayed retry and an error event. */
export async function tick(sub: Subscription, deps: PollerDeps): Promise<void> {
	const key = prKey(sub.ref);
	const startedAt = inFlight.get(key);
	// A poll that has been "running" for longer than any request could is
	// abandoned. Without this an interrupted request wedges the subscription
	// permanently: the guard stays set and every later tick returns early.
	if (startedAt !== undefined && now(deps) - startedAt < WEDGED_INFLIGHT_MS) {
		if (!sub.ended && !sub.paused) schedule(sub, deps, pollInterval(sub, deps));
		return;
	}
	if (sub.ended || sub.paused) return;
	const token = Symbol(key);
	inFlight.set(key, now(deps));
	inFlightTokens.set(key, token);
	try {
		await pollOnce(sub, deps);
		schedule(sub, deps, sub.nextPollAt ? Math.max(0, sub.nextPollAt - now(deps)) : 0);
	} finally {
		// An abandoned poll must not clear a newer one's guard.
		if (inFlightTokens.get(key) === token) {
			inFlight.delete(key);
			inFlightTokens.delete(key);
		}
	}
}

async function pollOnce(sub: Subscription, deps: PollerDeps): Promise<void> {
	const at = now(deps);
	// Expiry is checked before the read: a silent PR should stop costing `gh`
	// calls, and the notice is the last thing this subscription delivers.
	const quiet = at - (sub.lastEventAt ?? sub.createdAt);
	const limit = deps.expiryMs ?? DEFAULT_EXPIRY_MS;
	if (limit > 0 && quiet >= limit) {
		if (sub.lock) {
			// A silent subscription still holds the PR. Tell the truth if the lock
			// moved: the notice is worth delivering, the timer is not.
			if (!touchLock(sub.lock, at)) {
				sub.lock = undefined;
				sub.blockedBy = "another session (the lock was taken over)";
				pausePoller(sub);
				paint(deps);
				return;
			}
		}
		queueEvents(sub, [{ type: "subscription.expired", quietMs: quiet }], deps);
		expire(sub, deps, quiet);
		return;
	}
	const api = apiFor(sub.sessionId, deps);
	let snapshot: Snapshot;
	try {
		snapshot = await fetchSnapshot(api, sub.ref, { since: sub.cursor.commentSince });

		// Required checks are read once and refreshed only when the head moves.
		if (sub.required === undefined || sub.cursor.headSha !== snapshot.pull.headSha) {
			try {
				const required = await requiredChecks(api, sub.ref, snapshot.pull.baseRef);
				if (required?.length) sub.required = required;
			} catch {
				// No admin scope is normal; every check then counts.
			}
		}

		const result = diffSnapshot(snapshot, sub.cursor, {
			required: sub.required,
			now: at,
			ownPost: await ownPostHint(api, sub, at),
		});

		// The ownership check comes before anything is committed. Diffing is pure,
		// so a tick that lost the lock can walk away with the cursor exactly where
		// it was: the next owner re-diffs the same window, and events are late
		// rather than lost.
		if (sub.lock) {
			const touched = touchLock(sub.lock, at);
			if (!touched) {
				sub.lock = undefined;
				sub.blockedBy = "another session (the lock was taken over)";
				pausePoller(sub);
				paint(deps);
				return;
			}
			sub.lock = touched;
		}

		sub.cursor = advanceSince(result.cursor, snapshot);
		sub.checks = snapshot.checks;
		sub.state = snapshot.pull.state;
		sub.title = snapshot.pull.title;
		sub.draft = snapshot.pull.draft;
		sub.author = snapshot.pull.author;
		sub.consecutiveErrors = 0;
		sub.lastError = undefined;
		sub.lastErrorKind = undefined;
		sub.notifiedErrors = [];
		sub.lastPollAt = at;

		if (result.events.length > 0) {
			await attachLogs(sub, result.events, deps);
			queueEvents(sub, result.events, deps);
			registry().persist?.();
		} else if (result.dirty) {
			registry().persist?.();
		}

		const terminal = result.events.filter(isTerminal);
		if (terminal.length > 0) {
			flush(sub, deps, { force: true });
			end(sub, deps, terminal.at(-1)?.type === "pr.merged" ? "merged" : "closed");
			return;
		}

		sub.nextPollAt = at + pollInterval(sub, deps, at);
		paint(deps);
	} catch (error) {
		handleError(sub, deps, error);
	}
}

/**
 * The hint that reads a just-posted comment as the echo it is, or nothing.
 *
 * The session records when each of its `gh` posts returned (`ownPostAts`); this
 * prunes the ones that have aged past the window and, while any is left, asks
 * GitHub for the login the posts carry. An empty list is dropped here rather
 * than trusted: a subscription resumed a day later must not silence anything.
 */
async function ownPostHint(api: GhApi, sub: Subscription, at: number): Promise<OwnPost | undefined> {
	if (!sub.ownPostAts || sub.ownPostAts.length === 0) return undefined;
	const live = sub.ownPostAts.filter((postAt) => at - postAt <= OWN_POST_WINDOW_MS);
	if (live.length === 0) {
		sub.ownPostAts = undefined;
		return undefined;
	}
	if (live.length !== sub.ownPostAts.length) sub.ownPostAts = live;
	const login = await viewerLogin(api);
	return login ? { ats: live, login } : undefined;
}

/** Keep the issue-comment watermark on the newest comment seen, never behind. */
function advanceSince(cursor: Cursor, snapshot: Snapshot): Cursor {
	const newest = oldestFirst(snapshot.comments)
		.filter((comment) => comment.kind === "issue" && comment.createdAt)
		.map((comment) => comment.createdAt as string)
		.sort()
		.at(-1);
	if (!newest) return cursor;
	if (cursor.commentSince && cursor.commentSince >= newest) return cursor;
	return { ...cursor, commentSince: newest };
}

async function attachLogs(sub: Subscription, events: PrEvent[], deps: PollerDeps): Promise<void> {
	let fetches = 0;
	for (const event of events) {
		if (event.type !== "check.completed" || !event.logJobId) continue;
		if (!FAILED.has(event.conclusion) || fetches >= MAX_LOG_FETCHES) continue;
		fetches += 1;
		try {
			const text = await (deps.logTail ?? ((jobId) => fetchJobLog(sub.ref, jobId, { cwd: sub.cwd })))(
				event.logJobId
			);
			if (text) sub.pendingLogs.set(event.logJobId, text);
		} catch {
			// The URL is in the event; a missing tail is not worth failing the tick.
		}
	}
}

function queueEvents(sub: Subscription, events: PrEvent[], deps: PollerDeps): void {
	sub.pending.push(...events);
	const coalesce = deps.coalesceMs ?? COALESCE_MS;
	if (sub.flushTimer) return;
	sub.flushTimer = setTimeout(() => {
		sub.flushTimer = undefined;
		flush(sub, deps);
	}, coalesce);
	sub.flushTimer.unref?.();
	sub.lastEvent = describeEvent(events.at(-1));
	sub.lastEventAt = now(deps);
	paint(deps);
}

export function describeEvent(event: PrEvent | undefined): string | undefined {
	if (!event) return undefined;
	switch (event.type) {
		case "comment.created":
			return `${event.comment.kind === "review" ? "inline comment" : "comment"} by ${event.comment.author ?? "someone"}`;
		case "review.submitted":
			return `review by ${event.review.author ?? "someone"}`;
		case "check.completed":
			return `check ${event.name} ${event.conclusion}`;
		case "checks.settled":
			return `checks ${event.state}`;
		case "head.updated":
			return "new commits";
		case "pr.merged":
			return "merged";
		case "pr.closed":
			return "closed";
		case "subscription.error":
			return `error (${event.kind})`;
		case "subscription.expired":
			return "expired (no activity)";
	}
}

/**
 * Deliver what is queued. A settle in the batch swallows the per-run pings,
 * and a head move is dropped: it is bookkeeping (the cursor reset, the widget's
 * "new commits") and never a reason to spend a turn.
 */
export function flush(sub: Subscription, deps: PollerDeps, options: { force?: boolean } = {}): void {
	if (sub.flushTimer) {
		clearTimeout(sub.flushTimer);
		sub.flushTimer = undefined;
	}
	if (sub.pending.length === 0) return;
	const settled = sub.pending.some((event) => event.type === "checks.settled");
	const events = (settled ? sub.pending.filter((event) => event.type !== "check.completed") : sub.pending).filter(
		(event) => event.type !== "head.updated"
	);
	const batch = { ref: sub.ref, events, catchUp: sub.catchUp, logTails: sub.pendingLogs, now: now(deps) };
	sub.pending = [];
	sub.pendingLogs = new Map();
	sub.catchUp = false;
	// A push on its own leaves nothing to say. The cursor, the widget, and the
	// check tracking already moved; the checks that follow are the next wake.
	if (events.length === 0) return;
	deliver({ text: formatBatch(batch), wake: wakePayload(sub.ref, events) });
}

/** Flush every subscription (after a `pi-q-n-a` form closes). */
export function flushAll(subs: Subscription[], deps: PollerDeps): void {
	for (const sub of subs) flush(sub, deps);
}

function deliver(delivery: Delivery): void {
	const state = registry();
	if (!state.deliver) return;
	if (state.blocked?.()) {
		state.deferred.push(delivery);
		return;
	}
	state.deliver(delivery);
}

function paint(deps: PollerDeps): void {
	registry().paint?.();
}

function handleError(sub: Subscription, deps: PollerDeps, error: unknown): void {
	const at = now(deps);
	sub.consecutiveErrors += 1;
	if (error instanceof GhApiError) {
		sub.lastError = error.message;
		sub.lastErrorKind = error.kind;
	} else {
		sub.lastError = error instanceof Error ? error.message : String(error);
		sub.lastErrorKind = "network";
	}
	const kind: ErrorKind = sub.lastErrorKind ?? "unknown";
	const persistent = kind === "auth" || kind === "not-found";
	const threshold = persistent ? 2 : 3;
	if (sub.consecutiveErrors >= threshold && !sub.notifiedErrors.includes(kind)) {
		sub.notifiedErrors.push(kind);
		queueEvents(sub, [{ type: "subscription.error", kind, message: sub.lastError ?? kind }], deps);
	}
	if (kind === "not-found" && sub.consecutiveErrors >= 5) {
		flush(sub, deps, { force: true });
		end(sub, deps);
		return;
	}
	const base = deps.basePollMs ?? DEFAULT_BASE_POLL_MS;
	const retryAfter = error instanceof GhApiError ? error.retryAfterMs : undefined;
	const backoff = Math.min(base * 2 ** Math.min(sub.consecutiveErrors, 5), MAX_POLL_MS);
	sub.nextPollAt = at + Math.max(retryAfter ?? 0, backoff);
	schedule(sub, deps, Math.max(retryAfter ?? 0, backoff));
	paint(deps);
}

/**
 * End a subscription here and now.
 *
 * `reason` is set only when the PR itself ended the watch. It is recorded as a
 * release that is not `done`, so `/subscribe status` can say why the watch
 * stopped and a later `unsubscribe_pr_activity({ done: true })` is answered
 * with the truth instead of a bare "Not subscribed".
 */
function end(sub: Subscription, deps: PollerDeps, reason?: string): void {
	sub.ended = true;
	if (sub.timer) clearTimeout(sub.timer);
	sub.timer = undefined;
	if (sub.lock) releaseLock(sub.lock);
	removeSubscription(sub.ref);
	if (reason) recordRelease(sub.ref, { done: false, reason });
	registry().persist?.();
	paint(deps);
}

/**
 * Stop polling after a long silence but keep the subscription and its cursor.
 * It leaves the lock, because it is no longer watching and another session
 * (plus the user) should be free to take the PR.
 */
function expire(sub: Subscription, deps: PollerDeps, quietMs: number): void {
	const at = now(deps);
	sub.expiredAt = at;
	if (sub.lock) releaseLock(sub.lock);
	sub.lock = undefined;
	sub.blockedBy = undefined;
	queueEventsFlush(sub, deps);
	pausePoller(sub);
	sub.lastEvent = `expired after ${Math.round(quietMs / 60_000)} minutes of quiet`;
	sub.lastEventAt = at;
	registry().persist?.();
	paint(deps);
}

/** Deliver what the expiry notice queued, without waiting for the coalesce window. */
function queueEventsFlush(sub: Subscription, deps: PollerDeps): void {
	if (sub.flushTimer) clearTimeout(sub.flushTimer);
	sub.flushTimer = undefined;
	if (sub.pending.length > 0) flush(sub, deps);
}
