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
 * review, a failure, an error, or a close is something a person or the agent
 * has to look at.
 *
 * A head move is not in that list because it is never delivered at all: the
 * agent already knows which commits it pushed, and a push that came from
 * somewhere else still reaches it through the checks that follow, whose verdict
 * names the new SHA. `head.updated` drives the cursor and the widget; it does
 * not wake anything.
 */

import type { PrReadyToMergePayload, PrWakePayload } from "../_shared/hook-events.ts";
import type { PrEvent } from "./diff.ts";
import type { PrRef } from "./ref.ts";

const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

/** A batch is informational only when every event is a pass or an all-green settle. */
export function isInformational(events: PrEvent[]): boolean {
	if (events.length === 0) return false;
	return events.every((event) => {
		if (event.type === "check.completed") return PASSING_CONCLUSIONS.has(event.conclusion);
		if (event.type === "checks.settled") return event.state === "success" && event.failed.length === 0;
		return false;
	});
}

/** The distinct event types in a batch, in delivery order. */
export function wakeEventTypes(events: PrEvent[]): string[] {
	return [...new Set(events.map((event) => event.type))];
}

const shortSha = (sha: string): string => (sha.length > 7 ? sha.slice(0, 7) : sha);

/** One compact line per event, for a classifier or a log. Not user-facing prose. */
function describe(event: PrEvent): string {
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
			return `new commits, head ${shortSha(event.to)}`;
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
export function wakeSummary(events: PrEvent[]): string {
	const lines = events.map((event) => describe(event));
	const text = lines.join("; ");
	return text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY - 1)}…` : text;
}

export function wakePayload(ref: PrRef, events: PrEvent[]): PrWakePayload {
	return {
		owner: ref.owner,
		repo: ref.repo,
		pullNumber: ref.number,
		eventTypes: wakeEventTypes(events),
		informational: isInformational(events),
		summary: wakeSummary(events),
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
