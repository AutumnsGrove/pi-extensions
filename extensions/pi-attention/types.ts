/**
 * Attention types.
 *
 * Everything that crosses a boundary is plain data: the state machine takes
 * events and returns a state, the model layer takes a request and returns
 * answers, the log takes a record. That keeps the decision path replayable.
 */

import type { PrWakePayload } from "../_shared/hook-events.ts";

export type AttentionState = "working" | "needs_you" | "waiting" | "ready" | "idle";

export interface AttentionConfig {
	enabled: boolean;
	/** Ordered decision-model cascade. Empty means rules only. */
	models: string[];
	timeoutSeconds: number;
	/** Probability at or above which a turn needs the user. */
	needsYouAt: number;
	/** Probability at or above which "nothing to do" may be believed. */
	nothingToDoAt: number;
	/** Append a JSONL verdict record for every decided turn. */
	log: boolean;
}

export interface AttentionUpdate {
	state: AttentionState;
	reason: string;
	/** What moved it: a rule, a PR signal, or the decision model. */
	source: "rule" | "signal" | "model";
	confidence?: number;
}

/** One PR batch, as the wake event described it. */
export interface WakeSignal {
	payload: PrWakePayload;
	receivedAt: number;
}

/** Facts about the turn that is settling. */
export interface TurnFacts {
	/** Did this turn start from a PR wake? */
	wake?: WakeSignal;
	/** Tool calls made since the agent started. */
	toolCalls: number;
	/** The assistant's last text output, clipped. */
	lastText?: string;
	/** A deliberate done release arrived during the turn. */
	released: boolean;
	/** The release reason, when there was one. */
	releaseReason?: string;
	/** A blocking prompt was open at some point during the turn. */
	prompted: boolean;
	/** The run ended because it was aborted. */
	aborted: boolean;
}

export interface VerdictRecord {
	at: number;
	/** Session the decision belongs to, so its transcript can be found again. */
	session?: string;
	cwd?: string;
	state: AttentionState;
	source: AttentionUpdate["source"];
	reason: string;
	confidence?: number;
	model?: string;
	answers?: Record<string, unknown>;
	durationMs?: number;
	error?: string;
	/** The thresholds in force, so a later comparison knows what produced this. */
	thresholds?: { needsYouAt: number; nothingToDoAt: number };
	/** Compact inputs, so a verdict can be replayed. */
	input: {
		pull?: string;
		informational?: boolean;
		eventTypes?: string[];
		wakeSummary?: string;
		lastText?: string;
		toolCalls: number;
	};
}
