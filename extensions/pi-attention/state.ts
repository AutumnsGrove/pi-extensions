/**
 * The deterministic half: which turn states need no model at all.
 *
 * Rules always win. A failure, a human comment, a requested-changes review, a
 * subscription error, a prompt, or a done release is decided here, so a
 * classifier can never talk itself into "nothing to do" about them — PR text is
 * attacker-writable and a decision model can be nudged.
 *
 * Only one case is left to the model: an informational wake (passing checks)
 * where the agent still did something. Did it report something worth reading,
 * or was the work invisible and the turn a no-op?
 */

import type { AttentionUpdate, TurnFacts } from "./types.ts";

export type RuleOutcome =
	| { kind: "decided"; update: AttentionUpdate }
	| { kind: "model"; reason: string };

const decided = (update: AttentionUpdate): RuleOutcome => ({ kind: "decided", update });

/** Turn facts with nothing meaningful still become `idle`. */
export function decideRules(facts: TurnFacts): RuleOutcome {
	if (facts.released) {
		return decided({
			state: "ready",
			source: "signal",
			reason: facts.releaseReason
				? `released as done: ${facts.releaseReason}`
				: "released as done",
		});
	}

	if (facts.aborted) {
		return decided({ state: "idle", source: "rule", reason: "you aborted the run" });
	}

	const wake = facts.wake;
	if (wake) {
		const { payload } = wake;
		if (!payload.informational) {
			return decided({
				state: "needs_you",
				source: "rule",
				reason: "the pull request needs you",
			});
		}
		if (facts.toolCalls === 0) {
			return decided({
				state: "waiting",
				source: "rule",
				reason: "passing checks, nothing to do",
			});
		}
		// Passing checks, but the agent ran tools. Whether that was work worth
		// reporting is exactly what the decision model is for.
		return { kind: "model", reason: "an informational wake with work" };
	}

	return decided({ state: "idle", source: "rule", reason: "settled with nothing outstanding" });
}

/** Does this update differ from the last one? Repeated identical states are noise. */
export function isSameUpdate(
	previous: AttentionUpdate | undefined,
	next: AttentionUpdate,
): boolean {
	return (
		previous !== undefined &&
		previous.state === next.state &&
		previous.reason === next.reason &&
		previous.source === next.source
	);
}
