/**
 * What a delivery means to the rest of the system.
 *
 * `pi-pr-subscribe` is the only place that knows whether a batch needs the
 * agent, and nothing outside it can see that: batches are custom messages, not
 * user input, so `UserPromptSubmit` never fires for them. A delivery therefore
 * publishes a `PrWake` hook event, and a deliberate done release publishes
 * `PrReadyToMerge`.
 *
 * `informational` is the one judgement here, and it errs towards `false`: a
 * passing check is the only thing a wake can be silent about. A comment, a
 * review, a failure, a head move, an error, or a close is something a person or
 * the agent has to look at.
 *
 * The one head move that is not: the session's own push. The agent pushes, CI
 * restarts, and the resulting `head.updated` would otherwise wake it to say
 * "that was me". The caller passes the heads it has verified against the local
 * branch tip, so a push from anywhere else stays a wake.
 */

import type { PrReadyToMergePayload, PrWakePayload } from "../_shared/hook-events.ts";
import type { PrEvent } from "./diff.ts";
import type { PrRef } from "./ref.ts";

const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/**
 * A batch is informational only when every event is a pass, an all-green
 * settle, or a head move onto a tip this session pushed itself.
 */
export function isInformational(
	events: PrEvent[],
	ownHeads: ReadonlySet<string> = new Set(),
): boolean {
	if (events.length === 0) return false;
	return events.every((event) => {
		if (event.type === "check.completed") return PASSING_CONCLUSIONS.has(event.conclusion);
		if (event.type === "checks.settled") return event.state === "success" && event.failed.length === 0;
		if (event.type === "head.updated") return ownHeads.has(event.to);
		return false;
	});
}

/** The distinct event types in a batch, in delivery order. */
export function wakeEventTypes(events: PrEvent[]): string[] {
	return [...new Set(events.map((event) => event.type))];
}

const shortSha = (sha: string): string => (sha.length > 7 ? sha.slice(0, 7) : sha);

/** One compact line per event, for a classifier or a log. Not user-facing prose. */
function describe(event: PrEvent, ownHeads: ReadonlySet<string>): string {
	switch (event.type) {
		case "check.completed":
			return `check "${event.name}" finished: ${event.conclusion}`;
		case "checks.settled": {
			const failed = event.failed.length > 0 ? `, failed: ${event.failed.join(", ")}` : "";
			return `checks settled on ${shortSha(event.headSha)}: ${event.state} (${event.total} total${failed})`;
		}
		case "review.submitted":
			return `review ${event.review.state.toLowerCase()} by ${event.review.author ?? "someone"}`;
		case "comment.created":
			return `${event.comment.kind === "review" ? "inline comment" : "comment"} by ${event.comment.author ?? "someone"}`;
		case "head.updated":
			return ownHeads.has(event.to)
				? `new commits, head ${shortSha(event.to)} (this session's own push)`
				: `new commits, head ${shortSha(event.to)}`;
		case "pr.merged":
			return "pull request merged";
		case "pr.closed":
			return "pull request closed without merging";
		case "subscription.error":
			return `poller error (${event.kind}): ${event.message}`;
		case "subscription.expired":
			return `watch expired after ${Math.round(event.quietMs / 60_000)} minutes of quiet`;
	}
}

export const MAX_SUMMARY = 800;

/** A short description of the batch, capped so a noisy PR cannot bloat a hook payload. */
export function wakeSummary(events: PrEvent[], ownHeads: ReadonlySet<string> = new Set()): string {
	const lines = events.map((event) => describe(event, ownHeads));
	const text = lines.join("; ");
	return text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY - 1)}…` : text;
}

export function wakePayload(
	ref: PrRef,
	events: PrEvent[],
	ownHeads: ReadonlySet<string> = new Set(),
): PrWakePayload {
	return {
		owner: ref.owner,
		repo: ref.repo,
		pullNumber: ref.number,
		eventTypes: wakeEventTypes(events),
		informational: isInformational(events, ownHeads),
		summary: wakeSummary(events, ownHeads),
	};
}

export function readyToMergePayload(ref: PrRef, reason?: string): PrReadyToMergePayload {
	return {
		owner: ref.owner,
		repo: ref.repo,
		pullNumber: ref.number,
		...(reason ? { reason } : {}),
	};
}
