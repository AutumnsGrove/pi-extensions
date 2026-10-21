/**
 * Reviewer factory.
 *
 * The configured provider runs first. If it fails and `fallbackToLlm` is on,
 * a chat model gets one chance. If both fail the verdict is `deny` — auto mode
 * fails closed, never open.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ReviewerConfig, ReviewState, Verdict } from "../types.ts";
import { createJevProvider } from "./jev.ts";
import { createLlmProvider } from "./llm.ts";
import type { VerdictProvider } from "./provider.ts";

export interface Reviewer {
	review(state: ReviewState, signal?: AbortSignal): Promise<Verdict>;
}

export function createReviewer(
	ctx: ExtensionContext,
	config: ReviewerConfig,
): Reviewer | undefined {
	if (config.provider === "off") return undefined;

	const primary: VerdictProvider =
		config.provider === "jev" ? createJevProvider(ctx, config) : createLlmProvider(ctx, config);
	const fallback: VerdictProvider | undefined =
		config.provider === "jev" && config.fallbackToLlm
			? createLlmProvider(ctx, config, config.fallbackModel)
			: undefined;

	return {
		async review(state, signal) {
			const first = await primary.review(state, signal);
			if (!first.error) return first;

			if (fallback) {
				const second = await fallback.review(state, signal);
				if (!second.error) {
					return {
						...second,
						reasons: [
							`${primary.id} unavailable: ${first.reasons[0] ?? "error"}`,
							...second.reasons,
						],
					};
				}
				return failed(first, second);
			}

			return failed(first);
		},
	};
}

function failed(...verdicts: Verdict[]): Verdict {
	return {
		decision: "deny",
		confidence: 1,
		reasons: verdicts.flatMap((verdict) => verdict.reasons),
		provider: verdicts.map((verdict) => verdict.provider).join("+"),
		model: verdicts.find((verdict) => verdict.model)?.model,
		durationMs: verdicts.reduce((sum, verdict) => sum + verdict.durationMs, 0),
		error: "reviewer unavailable",
	};
}
