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
	type Cursor,
	type ErrorKind,
	type PrEvent,
} from "./diff.ts";
import {
	GhApi,
	GhApiError,
	fetchJobLog,
	fetchSnapshot,
	requiredChecks,
	type Exec,
} from "./gh.ts";
import { formatBatch } from "./format.ts";
import { prKey } from "./ref.ts";
import { checkSummary, oldestFirst, type Snapshot } from "./snapshot.ts";
import {
	releaseLock,
	removeSubscription,
	registry,
	touchLock,
	type Subscription,
} from "./registry.ts";

export const DEFAULT_BASE_POLL_MS = 20_000;
export const COALESCE_MS = 5_000;
/** Keep the fast rate for this long after any event, so a push is noticed quickly. */
export const ACTIVE_AFTER_MS = 10 * 60_000;
export const QUIET_AFTER_MS = 60 * 60_000;
export const MAX_POLL_MS = 300_000;
export const MAX_LOG_FETCHES = 3;

const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "error"]);

export interface PollerDeps {
	/** Defaults for a new API client; the client itself is per session. */
	cwd: string;
	basePollMs?: number;
	coalesceMs?: number;
	now?: () => number;
	/** Injected in tests; production uses `fetchJobLog`. */
	logTail?: (jobId: string) => Promise<string | undefined>;
}

const apis = new Map<string, GhApi>();
const inFlight = new Set<string>();

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
	schedule(sub, deps, 0);
}

export function stopPoller(sub: Subscription): void {
	sub.ended = true;
	if (sub.timer) clearTimeout(sub.timer);
	sub.timer = undefined;
	if (sub.flushTimer) clearTimeout(sub.flushTimer);
	sub.flushTimer = undefined;
	inFlight.delete(prKey(sub.ref));
}

function schedule(sub: Subscription, deps: PollerDeps, delay: number): void {
	if (sub.ended) return;
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
	if (sub.ended || inFlight.has(key)) {
		schedule(sub, deps, pollInterval(sub, deps));
		return;
	}
	inFlight.add(key);
	try {
		await pollOnce(sub, deps);
		schedule(sub, deps, sub.nextPollAt ? Math.max(0, sub.nextPollAt - now(deps)) : 0);
	} finally {
		inFlight.delete(key);
	}
}

async function pollOnce(sub: Subscription, deps: PollerDeps): Promise<void> {
	const at = now(deps);
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

		const result = diffSnapshot(snapshot, sub.cursor, { required: sub.required, now: at });
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
		if (sub.lock) sub.lock = touchLock(sub.lock, at);

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
			end(sub, deps);
			return;
		}

		sub.nextPollAt = at + pollInterval(sub, deps, at);
		paint(deps);
	} catch (error) {
		handleError(sub, deps, error);
	}
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
	}
}

/** Deliver what is queued. A settle in the batch swallows the per-run pings. */
export function flush(sub: Subscription, deps: PollerDeps, options: { force?: boolean } = {}): void {
	if (sub.flushTimer) {
		clearTimeout(sub.flushTimer);
		sub.flushTimer = undefined;
	}
	if (sub.pending.length === 0) return;
	const settled = sub.pending.some((event) => event.type === "checks.settled");
	const events = settled ? sub.pending.filter((event) => event.type !== "check.completed") : sub.pending;
	const text = formatBatch({
		ref: sub.ref,
		events,
		catchUp: sub.catchUp,
		logTails: sub.pendingLogs,
		now: now(deps),
	});
	sub.pending = [];
	sub.pendingLogs = new Map();
	sub.catchUp = false;
	deliver(text);
}

/** Flush every subscription (after a `pi-q-n-a` form closes). */
export function flushAll(subs: Subscription[], deps: PollerDeps): void {
	for (const sub of subs) flush(sub, deps);
}

function deliver(text: string): void {
	const state = registry();
	if (!state.deliver) return;
	if (state.blocked?.()) {
		state.deferred.push(text);
		return;
	}
	state.deliver(text);
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

function end(sub: Subscription, deps: PollerDeps): void {
	sub.ended = true;
	if (sub.timer) clearTimeout(sub.timer);
	sub.timer = undefined;
	if (sub.lock) releaseLock(sub.lock);
	removeSubscription(sub.ref);
	registry().persist?.();
	paint(deps);
}
