/**
 * The producer side of the hooks bus.
 *
 * Extensions that know something the hook engine cannot observe — `pi-pr-subscribe`
 * knows whether a wake demands action, `pi-attention` knows whether a session
 * needs you — publish it as a hook event through this channel. `hooks` picks it
 * up, fans it out to configured hooks and to every in-process handler, and gives
 * it the same envelope as a pi event.
 *
 * The channel is a plain `pi.events` channel so a consumer can listen directly
 * without the hooks engine loaded (pi-attention does exactly that). Event names
 * still have to be in `HOOK_EVENTS`; the engine ignores anything else.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const HOOK_EVENT_CHANNEL = "pi-hooks:emit";

/** What a producer sends: the hook event name plus its event-specific fields. */
export interface HookEventEmission {
	event: string;
	input: Record<string, unknown>;
}

/** The signal a PR delivery turns into. See `pi-pr-subscribe/wake.ts`. */
export type PrWakePayload = {
	owner: string;
	repo: string;
	pullNumber: number;
	eventTypes: string[];
	/**
	 * True only when the batch holds nothing that demands action: passing checks
	 * and all-green settles, with no failures, comments or reviews, no
	 * subscription error, and no head update except one this session pushed
	 * itself. When in doubt, false.
	 */
	informational: boolean;
	/** One short, human-readable line describing the batch, for classifiers. */
	summary: string;
};

/** The signal a deliberate done release turns into. */
export type PrReadyToMergePayload = {
	owner: string;
	repo: string;
	pullNumber: number;
	reason?: string;
};

/**
 * Emit a hook event. Safe to call with the hooks engine absent: nothing listens
 * and nothing happens.
 */
export function emitHookEvent(
	pi: ExtensionAPI,
	event: string,
	input: Record<string, unknown>,
): void {
	try {
		pi.events.emit(HOOK_EVENT_CHANNEL, { event, input });
	} catch {
		// A producer must never fail its own work because a hook broke.
	}
}

/** Is an emission well formed? Used by the engine before dispatching. */
export function isHookEventEmission(value: unknown): value is HookEventEmission {
	if (!value || typeof value !== "object") return false;
	const record = value as { event?: unknown; input?: unknown };
	return (
		typeof record.event === "string" &&
		!!record.input &&
		typeof record.input === "object" &&
		!Array.isArray(record.input)
	);
}
