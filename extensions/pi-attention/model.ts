/**
 * The decision-model half: one request, two questions, no chat completion.
 *
 * The model sees a compact state (the PR wake and the agent's last message) and
 * answers a bool and a choice. Neither answer is trusted blindly: `needsYouAt`
 * must be met to report, and `nothingToDoAt` must be met before a turn may be
 * silent. Anything else — a missing answer, a refused request, a timeout, an
 * unreachable model — becomes `needs_you`, so an outage gets a sound rather
 * than silence.
 */

import type { ClassifierAnswer, ClassifierQuestion, JsonObject } from "@earendil-works/pi-ai";
import type { AttentionConfig, AttentionUpdate, TurnFacts } from "./types.ts";
import type { DecideResult } from "../_shared/classifier.ts";
import { boolAnswer, choiceAnswer, clip } from "../_shared/classifier.ts";

export const MAX_LAST_TEXT = 2000;

export function attentionQuestions(): Record<string, ClassifierQuestion> {
	return {
		needs_you: {
			type: "bool",
			instructions:
				"This turn requires the user to read or do something now. A failed check the agent already fixed, a CI pass with nothing to report, or a routine status line does not count as something to do.",
			criteria: {
				true: "The user should look at this",
				false: "Nothing for the user to do",
			},
		},
		outcome: {
			type: "choice",
			instructions: "What did this turn produce, from the user's point of view?",
			criteria: {
				nothing_to_do: "No user-visible outcome; the turn changed nothing worth reading",
				reported: "The agent reported something the user should read",
				blocked: "The agent is blocked, asking, or needs a decision",
			},
		},
	};
}

export interface AttentionStateInput {
	ref: string;
	wakeSummary: string;
	lastText: string;
	toolCalls: number;
}

export function attentionState(facts: TurnFacts, ref: string): JsonObject {
	const summary = facts.wake?.payload.summary ?? "";
	const text = clip(facts.lastText ?? "", MAX_LAST_TEXT);
	return {
		pull_request: ref,
		pr_event: summary,
		agent_last_message: text,
		tool_calls: facts.toolCalls,
	};
}

export interface Interpretation {
	update: AttentionUpdate;
	model: string;
}

/**
 * Turn the answers into a state. `undefined` means the model left out an answer
 * it was required to give — treated as a failure, not as "nothing to do".
 */
export function interpretAttention(
	answers: Record<string, ClassifierAnswer>,
	config: AttentionConfig,
	model: string,
	durationMs: number,
): Interpretation | undefined {
	const needsYou = boolAnswer(answers, "needs_you");
	const outcome = choiceAnswer(answers, "outcome");
	if (needsYou === undefined) return undefined;

	const confidence = needsYou;
	if (needsYou >= config.needsYouAt) {
		return {
			model,
			update: {
				state: "needs_you",
				source: "model",
				confidence,
				reason: `the model says this needs you (${needsYou.toFixed(2)}${outcome ? `, ${outcome.choice} ${outcome.probability.toFixed(2)}` : ""}, ${durationMs}ms)`,
			},
		};
	}

	if (outcome?.choice === "nothing_to_do" && outcome.probability >= config.nothingToDoAt) {
		return {
			model,
			update: {
				state: "waiting",
				source: "model",
				confidence: outcome.probability,
				reason: `nothing to do (${outcome.probability.toFixed(2)}, ${durationMs}ms)`,
			},
		};
	}

	// Neither threshold was met: fail loud rather than go quiet.
	return {
		model,
		update: {
			state: "needs_you",
			source: "model",
			confidence: 1 - needsYou,
			reason: `not confident enough to stay silent (${needsYou.toFixed(2)}${outcome ? `, ${outcome.choice} ${outcome.probability.toFixed(2)}` : ""}, ${durationMs}ms)`,
		},
	};
}

/** The failure state: a model outage is something the user should hear about. */
export function failedUpdate(result: DecideResult): AttentionUpdate {
	const detail = result.ok ? "" : (result.errors.at(-1) ?? "no model answered");
	return {
		state: "needs_you",
		source: "model",
		reason: `the decision model could not answer (${detail})`,
	};
}
