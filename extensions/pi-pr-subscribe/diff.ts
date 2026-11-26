/**
 * The diff engine: snapshot vs cursor, in, events out.
 *
 * Polling makes dedupe the whole job. Nothing here talks to GitHub or to pi; it
 * takes two plain values and returns the events that have not been reported
 * yet plus the cursor to persist. That is what makes "fire once, across
 * `/reload`, resume, and a session switch" testable with fixtures instead of a
 * live pull request.
 *
 * The rules that matter:
 *
 * - Ids, not timestamps. A late 304, a duplicated page, or a clock skew cannot
 *   double-fire an event, and an edited comment that keeps its id stays quiet.
 * - The first snapshot only seeds the cursor. Pre-existing comments and checks
 *   are not news; `subscription.created` describes them instead.
 * - A new head SHA resets the check picture. Checks for the old SHA can never
 *   settle the new one.
 * - `checks.settled` fires once per head SHA, and only when every check that
 *   counts is terminal. With no checks at all it waits a few polls first, so a
 *   head pushed a second ago is not declared "done" before CI has even created
 *   a run.
 * - A comment the session posted itself is not news. The cursor learns the id
 *   from the `gh` output when it can (`capture.ts`); when the output does not
 *   carry one, the `ownPost` hint does the same job from the other direction:
 *   the session says when it posted and which login it posts as, and a write by
 *   that login inside the window afterwards is the echo of that post.
 */

import {
	oldestFirst,
	type CheckEntry,
	type CommentEntry,
	type PullState,
	type ReviewEntry,
	type Snapshot,
} from "./snapshot.ts";

export interface CheckCursorEntry {
	status: CheckEntry["status"];
	conclusion: string | null;
}

export interface Cursor {
	version: 1;
	headSha: string;
	state: PullState;
	merged: boolean;
	/** Keyed by `check:<id>` / `status:<context>`. */
	checks: Record<string, CheckCursorEntry>;
	/** Head SHA whose checks already settled; suppresses a second verdict. */
	settledSha: string | null;
	/** Consecutive polls that saw no checks at all on the current head. */
	zeroCheckPolls: number;
	/** Seen comment ids, oldest first, capped. */
	commentIds: string[];
	reviewIds: string[];
	/** Ids the session itself posted, so a reply does not wake it. */
	ownIds: string[];
	/** Issue-comment `since` watermark; issue comments page ascending only. */
	commentSince?: string;
	title?: string;
	lastEventAt?: number;
}

export type PrEvent =
	| {
			type: "check.completed";
			key: string;
			name: string;
			conclusion: string;
			url?: string;
			app?: string;
			logJobId?: string;
	  }
	| {
			type: "checks.settled";
			headSha: string;
			state: "success" | "failure";
			total: number;
			failed: string[];
			definition: "required" | "all";
			missingRequired: string[];
	  }
	| { type: "review.submitted"; review: ReviewEntry }
	| { type: "comment.created"; comment: CommentEntry }
	| { type: "head.updated"; from?: string; to: string }
	| { type: "pr.merged"; number: number; url?: string }
	| { type: "pr.closed"; number: number; url?: string }
	| { type: "subscription.error"; kind: ErrorKind; message: string }
	/** The watch was stopped after a long silence. The cursor survives for a resume. */
	| { type: "subscription.expired"; quietMs: number };

export type ErrorKind = "auth" | "not-found" | "rate-limit" | "server" | "network" | "unknown";

/** How many ids a cursor remembers. Far more than one page of either resource. */
export const MAX_SEEN_IDS = 500;

/** Polls with no checks at all before declaring a checkless head settled. */
export const EMPTY_SETTLE_POLLS = 3;

/** First poll for a subscription: seed the cursor, report nothing. */
export function initCursor(snapshot: Snapshot): Cursor {
	const cursor: Cursor = {
		version: 1,
		headSha: snapshot.pull.headSha,
		state: snapshot.pull.state,
		merged: snapshot.pull.merged,
		checks: {},
		settledSha: null,
		zeroCheckPolls: 0,
		commentIds: [],
		reviewIds: [],
		ownIds: [],
		...(snapshot.pull.title ? { title: snapshot.pull.title } : {}),
	};
	for (const check of snapshot.checks) {
		cursor.checks[check.key] = { status: check.status, conclusion: check.conclusion };
	}
	// CI that was already finished when the subscription started is described by
	// `subscription.created`; a second "checks settled" a poll later is noise.
	const finished = snapshot.checks.every(
		(check) => check.status === "completed" && check.conclusion !== null
	);
	if (snapshot.checks.length > 0 && finished) cursor.settledSha = snapshot.pull.headSha;
	cursor.commentIds = oldestFirst(snapshot.comments).map((comment) => comment.id);
	const newestIssueComment = snapshot.comments
		.filter((comment) => comment.kind === "issue" && comment.createdAt)
		.map((comment) => comment.createdAt as string)
		.sort()
		.at(-1);
	cursor.commentSince = newestIssueComment;
	cursor.reviewIds = oldestFirst(snapshot.reviews).map((review) => review.id);
	return cursor;
}

export interface DiffOptions {
	/** Branch-protection contexts, when the token can read them. */
	required?: string[] | undefined;
	/** Test seam for `lastEventAt`. */
	now?: number;
	/** Override for the empty-check settle threshold. */
	emptySettlePolls?: number;
	/** A `gh` post this session just made, so its echo does not wake it. */
	ownPost?: OwnPost | undefined;
}

/** When a session posted to the PR itself, and the login the post carried. */
export interface OwnPost {
	/** Local clock, taken when the posting `gh` call returned. */
	at: number;
	login: string;
}

/**
 * Clock slack before the post: GitHub stamps `created_at` on its own clock, and
 * the two are not guaranteed to agree.
 */
export const OWN_POST_BEFORE_MS = 60_000;
/**
 * Window after the post. It has to outlast a slow poll — a quiet PR is read once
 * every five minutes — because the echo is only visible on the next successful
 * read.
 */
export const OWN_POST_WINDOW_MS = 6 * 60_000;

/**
 * Is this newly seen write the echo of the session's own post?
 *
 * Only the login and the window are consulted: the id would be better, but it
 * is exactly what a wrapper script or a `--jq .id` pipe does not give us. A
 * write the payload does not date is not an echo — the safe direction is still
 * to wake.
 */
function isOwnPostEcho(
	author: string | undefined,
	createdAt: string | undefined,
	ownPost: OwnPost | undefined
): boolean {
	if (!ownPost || !author || !createdAt) return false;
	if (author.toLowerCase() !== ownPost.login.toLowerCase()) return false;
	const created = Date.parse(createdAt);
	if (!Number.isFinite(created)) return false;
	return created >= ownPost.at - OWN_POST_BEFORE_MS && created <= ownPost.at + OWN_POST_WINDOW_MS;
}

export interface DiffResult {
	events: PrEvent[];
	cursor: Cursor;
	/** True when the cursor must be persisted (an event fired or the head moved). */
	dirty: boolean;
}

const FAILURE_CONCLUSIONS = new Set([
	"failure",
	"timed_out",
	"cancelled",
	"action_required",
	"startup_failure",
	"error",
]);

const cloneCursor = (cursor: Cursor): Cursor => ({
	...cursor,
	checks: { ...cursor.checks },
	commentIds: [...cursor.commentIds],
	reviewIds: [...cursor.reviewIds],
	ownIds: [...cursor.ownIds],
});

/** Append ids, drop any that were already known, and cap the tail. */
function remember(seen: string[], additions: string[], cap = MAX_SEEN_IDS): string[] {
	const next = [...seen];
	const known = new Set(seen);
	for (const id of additions) {
		if (known.has(id)) continue;
		known.add(id);
		next.push(id);
	}
	return next.length > cap ? next.slice(next.length - cap) : next;
}

const isFailure = (check: { conclusion: string | null }): boolean =>
	Boolean(check.conclusion && FAILURE_CONCLUSIONS.has(check.conclusion));

/** Job id from an Actions details URL, used to fetch a failed log. */
export function jobIdFromUrl(url: string | undefined): string | undefined {
	if (!url) return undefined;
	const match = /\/job(?:s)?\/(\d+)/.exec(url);
	return match?.[1];
}

function settleVerdict(
	snapshot: Snapshot,
	required: string[] | undefined
): { ready: boolean; definition: "required" | "all"; missingRequired: string[] } {
	const checks = snapshot.checks;
	const allTerminal = checks.every((check) => check.status === "completed" && check.conclusion !== null);
	if (!required || required.length === 0) {
		return { ready: checks.length > 0 && allTerminal, definition: "all", missingRequired: [] };
	}
	const missing = required.filter((name) => !checks.some((check) => check.name === name));
	const requiredEntries = checks.filter((check) => required.includes(check.name));
	const requiredTerminal = requiredEntries.every(
		(check) => check.status === "completed" && check.conclusion !== null
	);
	if (missing.length === 0) {
		return { ready: requiredTerminal, definition: "required", missingRequired: [] };
	}
	// A required context that never appears (renamed, removed, or a stale
	// required list) must not wedge the subscription forever. Once everything
	// that did appear is terminal, settle against every check and say so.
	return {
		ready: allTerminal,
		definition: "all",
		missingRequired: missing,
	};
}

export function diffSnapshot(snapshot: Snapshot, cursor: Cursor, options: DiffOptions = {}): DiffResult {
	const now = options.now ?? Date.now();
	const emptySettlePolls = options.emptySettlePolls ?? EMPTY_SETTLE_POLLS;
	const events: PrEvent[] = [];
	const next = cloneCursor(cursor);
	const pull = snapshot.pull;
	let dirty = false;

	// A new head invalidates every check, the verdict, and the empty-check count.
	if (pull.headSha !== cursor.headSha) {
		events.push({
			type: "head.updated",
			...(cursor.headSha ? { from: cursor.headSha } : {}),
			to: pull.headSha,
		});
		next.checks = {};
		next.settledSha = null;
		next.zeroCheckPolls = 0;
		dirty = true;
	}
	next.headSha = pull.headSha;
	if (pull.title && pull.title !== next.title) next.title = pull.title;

	// --- comments and reviews ------------------------------------------------
	const newCommentIds: string[] = [];
	const own = new Set([...cursor.ownIds, ...cursor.commentIds]);
	for (const comment of oldestFirst(snapshot.comments)) {
		if (own.has(comment.id)) continue;
		own.add(comment.id);
		newCommentIds.push(comment.id);
		// Seen and remembered, but not news: this is the session's own post.
		if (isOwnPostEcho(comment.author, comment.createdAt, options.ownPost)) continue;
		events.push({ type: "comment.created", comment });
	}
	if (newCommentIds.length > 0) {
		next.commentIds = remember(next.commentIds, newCommentIds);
		dirty = true;
	}

	const newReviewIds: string[] = [];
	const seenReviews = new Set([...cursor.ownIds, ...cursor.reviewIds]);
	for (const review of oldestFirst(snapshot.reviews)) {
		if (seenReviews.has(review.id)) continue;
		seenReviews.add(review.id);
		newReviewIds.push(review.id);
		// A bare "commented" placeholder with no body and no state of its own
		// carries nothing; its inline comments arrive separately.
		if (review.state === "COMMENTED" && review.body.trim() === "") continue;
		if (isOwnPostEcho(review.author, review.submittedAt, options.ownPost)) continue;
		events.push({ type: "review.submitted", review });
	}
	if (newReviewIds.length > 0) {
		next.reviewIds = remember(next.reviewIds, newReviewIds);
		dirty = true;
	}

	// --- checks --------------------------------------------------------------
	for (const check of snapshot.checks) {
		const previous = cursor.checks[check.key];
		next.checks[check.key] = { status: check.status, conclusion: check.conclusion };
		const finished = check.status === "completed" && check.conclusion !== null;
		const changed = previous?.status !== check.status || previous.conclusion !== check.conclusion;
		if (!finished || !changed) continue;
		events.push({
			type: "check.completed",
			key: check.key,
			name: check.name,
			conclusion: check.conclusion ?? "",
			...(check.url ? { url: check.url } : {}),
			...(check.app ? { app: check.app } : {}),
			...(jobIdFromUrl(check.url) ? { logJobId: jobIdFromUrl(check.url) } : {}),
		});
		dirty = true;
	}

	if (snapshot.checks.length === 0) {
		next.zeroCheckPolls = next.zeroCheckPolls + 1;
		if (next.zeroCheckPolls >= emptySettlePolls && next.settledSha !== pull.headSha) {
			next.settledSha = pull.headSha;
			events.push({
				type: "checks.settled",
				headSha: pull.headSha,
				state: "success",
				total: 0,
				failed: [],
				definition: options.required && options.required.length > 0 ? "required" : "all",
				missingRequired: [...(options.required ?? [])],
			});
			dirty = true;
		}
	} else {
		next.zeroCheckPolls = 0;
		const verdict = settleVerdict(snapshot, options.required);
		if (verdict.ready && next.settledSha !== pull.headSha) {
			const failed = snapshot.checks.filter(isFailure).map((check) => check.name);
			next.settledSha = pull.headSha;
			events.push({
				type: "checks.settled",
				headSha: pull.headSha,
				state: failed.length > 0 ? "failure" : "success",
				total: snapshot.checks.length,
				failed,
				definition: verdict.definition,
				missingRequired: verdict.missingRequired,
			});
			dirty = true;
		}
	}

	// --- terminal states -----------------------------------------------------
	if (pull.merged && !cursor.merged) {
		events.push({ type: "pr.merged", number: pull.number, ...(pull.url ? { url: pull.url } : {}) });
		dirty = true;
	} else if (pull.state === "closed" && !pull.merged && cursor.state === "open") {
		events.push({ type: "pr.closed", number: pull.number, ...(pull.url ? { url: pull.url } : {}) });
		dirty = true;
	}
	next.state = pull.state;
	next.merged = pull.merged;

	if (events.length > 0) {
		next.lastEventAt = now;
		dirty = true;
	}
	return { events, cursor: next, dirty };
}

/** True once a subscription has nothing left to watch. */
export function isTerminal(event: PrEvent): boolean {
	return event.type === "pr.merged" || event.type === "pr.closed";
}
