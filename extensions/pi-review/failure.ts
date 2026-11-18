/**
 * What a review run that did not submit actually did.
 *
 * A missing artifact used to mean one thing ("the job failed or timed out"),
 * which read the same for a provider 429, a model that ended in prose, and a
 * run that hit the output limit. The runner classifies the final assistant
 * message here so the workflow can name the cause and decide whether a retry,
 * a recovery, or a failure comment is the right response.
 */

import { type AssistantMessage, isRetryableAssistantError } from "@earendil-works/pi-ai";

export type ReviewFailureKind =
	| "provider"
	| "incomplete"
	| "aborted"
	| "budget"
	| "post"
	| "no-artifact";

export interface FailureClassification {
	kind: ReviewFailureKind;
	/** Whether the same request could succeed later without a change. */
	retryable: boolean;
	/** One-line cause, safe to show in a comment. */
	detail: string;
}

/** At least this much prose is worth posting as a recovered review. */
export const MIN_RECOVERY_CHARS = 400;

export function assistantText(message: AssistantMessage | undefined): string {
	if (!message) return "";
	const parts: string[] = [];
	for (const part of message.content) {
		if (part.type === "text") parts.push(part.text);
	}
	return parts.join("\n").trim();
}

/**
 * Classify the final assistant message. A run with no error and no tool result
 * is the `incomplete` case: the model ended its turn without `submit_review`.
 */
export function classifySettlement(message: AssistantMessage | undefined): FailureClassification {
	if (!message) {
		return {
			kind: "incomplete",
			retryable: false,
			detail: "the run ended without an assistant message or a submitted review",
		};
	}
	if (message.stopReason === "error") {
		const retryable = isRetryableAssistantError(message);
		return {
			kind: "provider",
			retryable,
			detail:
				message.errorMessage?.trim() ||
				(retryable
					? "the model provider returned a transient error"
					: "the model provider rejected the request"),
		};
	}
	if (message.stopReason === "aborted") {
		return {
			kind: "aborted",
			retryable: false,
			detail: message.errorMessage?.trim() || "the review run was aborted",
		};
	}
	if (message.stopReason === "length") {
		return {
			kind: "budget",
			retryable: false,
			detail: message.errorMessage?.trim() || "the response reached the model's output limit",
		};
	}
	return {
		kind: "incomplete",
		retryable: false,
		detail: "the run ended without calling submit_review",
	};
}

/** A prose answer long enough to stand on its own as a COMMENT review. */
export function isSubstantiveReview(text: string): boolean {
	return text.trim().length >= MIN_RECOVERY_CHARS;
}

/** Header that makes a recovered review honest about how it arrived. */
export function recoverySummary(text: string): string {
	return [
		"_Submitted by recovery: the run ended without calling `submit_review`, so pi-review posted its final answer as a COMMENT review._",
		"",
		text.trim(),
	].join("\n");
}
