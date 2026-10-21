/**
 * Reviewer seam.
 *
 * JEV and an LLM both implement this interface, which is what makes the
 * JEV-vs-LLM benchmark a replay of recorded `ReviewState` through two
 * providers instead of a rewrite.
 */

import type { ReviewState, Verdict } from "../types.ts";

export interface VerdictProvider {
	readonly id: string;
	review(state: ReviewState, signal?: AbortSignal): Promise<Verdict>;
}

export function verdictError(
	provider: string,
	error: string,
	model?: string,
	durationMs = 0,
): Verdict {
	return {
		decision: "ask",
		confidence: 0,
		reasons: [error],
		provider,
		model,
		durationMs,
		error,
	};
}

/** Race a promise against a timeout without leaking an unhandled rejection. */
export async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	label: string,
): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out`)), Math.max(1, timeoutMs));
		if (timer.unref) timer.unref();
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** Truncate a string for a classifier's limited context window. */
export function clip(value: unknown, max = 2000): string {
	if (typeof value !== "string") return "";
	return value.length > max ? value.slice(0, max) : value;
}

/** Compact, stable state for the classifier. */
export function reviewStateForModel(state: ReviewState): Record<string, unknown> {
	const input: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(state.input)) {
		if (typeof value === "string") input[key] = clip(value, 4000);
		else if (typeof value === "number" || typeof value === "boolean") input[key] = value;
		else input[key] = clip(JSON.stringify(value), 2000);
	}
	return {
		tool: state.tool,
		action: input,
		cwd: state.cwd,
		mode: state.mode,
		user_intent: state.userIntent ? clip(state.userIntent, 2000) : null,
		recent_commands: (state.recentCommands ?? []).slice(-6).map((command) => clip(command, 300)),
	};
}
