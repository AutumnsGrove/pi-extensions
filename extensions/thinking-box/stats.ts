/**
 * Pure formatting and timing logic for the thinking-box extension.
 *
 * This file deliberately imports nothing from pi so the number formatting,
 * run extraction and timing rules can be unit-tested without a terminal.
 */

/** Duration and token count shown for one assistant message's thinking. */
export interface ThinkingStats {
	/** Time spent thinking, in milliseconds. */
	durationMs: number;
	/** Reasoning tokens, from provider usage when available. */
	tokens: number;
	/** True when `tokens` was estimated from text length rather than reported. */
	estimated?: boolean;
}

/** A persisted stats record, keyed to the assistant message it describes. */
export interface ThinkingStatsRecord extends ThinkingStats {
	key: string;
}

/** The slice of an assistant content block we need. */
export interface ThinkingContentBlock {
	type: string;
	thinking?: string;
}

/** The slice of a session entry we need to recover persisted stats. */
export interface StatsEntryLike {
	type?: string;
	customType?: string;
	data?: unknown;
}

/** Number of preview lines shown when a thinking block is collapsed. */
export const DEFAULT_PREVIEW_LINES = 8;

/** Custom entry type used to persist stats across sessions. */
export const STATS_ENTRY_TYPE = "thinking-stats";

/**
 * Extract runs of consecutive thinking blocks the way pi groups them for
 * rendering: each run's blocks are trimmed and joined with a blank line.
 */
export function extractThinkingRuns(
	content: readonly ThinkingContentBlock[] | undefined
): string[] {
	const runs: string[] = [];
	if (!content) return runs;

	for (let i = 0; i < content.length; i++) {
		if (content[i]?.type !== "thinking") continue;

		const blocks: string[] = [];
		for (; i < content.length; i++) {
			const block = content[i];
			if (block?.type !== "thinking") break;
			const text = (block.thinking ?? "").trim();
			if (text) blocks.push(text);
		}
		i--;

		if (blocks.length > 0) runs.push(blocks.join("\n\n"));
	}

	return runs;
}

/**
 * Rough token estimate for providers that do not stream reasoning usage.
 * ~4 characters per token is the common English approximation.
 */
export function estimateTokens(text: string): number {
	const chars = text.trim().length;
	if (chars === 0) return 0;
	return Math.max(1, Math.round(chars / 4));
}

/** Human duration: `0.4s`, `12s`, `1m 5s`, `2h 3m`. */
export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, ms) / 1000;
	if (totalSeconds < 1) return "<1s";
	if (totalSeconds < 10) return `${totalSeconds.toFixed(1)}s`;
	if (totalSeconds < 60) return `${Math.round(totalSeconds)}s`;

	const minutes = Math.floor(totalSeconds / 60);
	const seconds = Math.round(totalSeconds - minutes * 60);
	if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;

	const hours = Math.floor(minutes / 60);
	const remainder = minutes % 60;
	return remainder > 0 ? `${hours}h ${remainder}m` : `${hours}h`;
}

/** Compact token count: `834`, `3.4k`, `15k`, `1.2M`. */
export function formatTokens(tokens: number): string {
	const value = Math.max(0, tokens);
	if (value < 1000) return String(Math.round(value));

	const thousands = value / 1000;
	if (thousands < 10) return `${thousands.toFixed(1)}k`;
	if (thousands < 1000) return `${Math.round(thousands)}k`;

	return `${(value / 1_000_000).toFixed(1)}M`;
}

/** Hint shown on the right of a collapsed box. */
export const EXPAND_HINT = "ctrl+o to expand";

export interface HeaderInput {
	streaming: boolean;
	expanded: boolean;
	stats: ThinkingStats | undefined;
}

/**
 * Header text for a thinking box, e.g.
 *   "▸ Thinking for 12s, ~3.4k tokens"
 *   "▾ Thought for 20s, 15k tokens"
 *
 * The expand hint is rendered separately, right-aligned, so this never
 * includes it.
 */
export function formatHeader(input: HeaderInput): string {
	const stats = input.stats;
	const verb = input.streaming ? "Thinking" : "Thought";

	let label: string;
	if (stats && stats.durationMs > 0) {
		const tokenText = `${stats.estimated ? "~" : ""}${formatTokens(stats.tokens)} tokens`;
		label = `${verb} for ${formatDuration(stats.durationMs)}, ${tokenText}`;
	} else if (stats && stats.tokens > 0) {
		const tokenText = `${stats.estimated ? "~" : ""}${formatTokens(stats.tokens)} tokens`;
		label = `${verb} · ${tokenText}`;
	} else {
		label = input.streaming ? "Thinking…" : "Thought";
	}

	const chevron = input.expanded ? "▾" : "▸";
	return `${chevron} ${label}`;
}

/** The slice of an assistant message needed to key its stats. */
export interface KeyedMessage {
	timestamp?: number;
	responseId?: string;
	content?: readonly unknown[];
}

/**
 * Stable key for an assistant message. Content blocks are appended during
 * streaming, so the block count cannot be part of the key; the start timestamp
 * is set once and survives streaming, completion and session reload.
 */
export function messageKey(message: KeyedMessage): string {
	if (typeof message.timestamp === "number") return String(message.timestamp);
	return message.responseId ?? "unknown";
}

/** Recover persisted stats records from a session branch. */
export function collectStatsRecords(
	entries: readonly StatsEntryLike[] | undefined
): ThinkingStatsRecord[] {
	const records: ThinkingStatsRecord[] = [];
	if (!entries) return records;

	for (const entry of entries) {
		if (entry?.type !== "custom" || entry.customType !== STATS_ENTRY_TYPE) continue;
		const data = entry.data;
		if (!data || typeof data !== "object") continue;

		const record = data as Partial<ThinkingStatsRecord>;
		if (typeof record.key !== "string") continue;

		records.push({
			key: record.key,
			durationMs: Number(record.durationMs) || 0,
			tokens: Number(record.tokens) || 0,
			estimated: record.estimated,
		});
	}

	return records;
}

/**
 * Tracks thinking start/end time for the message currently streaming and
 * remembers the final stats so a later re-render (theme change, reload,
 * scrolling) shows the same numbers.
 */
export class ThinkingStatsTracker {
	private readonly stats = new Map<string, ThinkingStats>();
	private active:
		| { key: string; first: number; last: number; text: string }
		| undefined;

	constructor(private readonly now: () => number = Date.now) {}

	/**
	 * Update and return stats for a message.
	 *
	 * While streaming, the clock runs from the first thinking token to the
	 * latest one. Once complete, the stored value wins; if there is none (the
	 * message finished before this tracker saw it), the active run is closed
	 * and used.
	 */
	observe(
		message: KeyedMessage,
		isStreaming: boolean,
		fullText: string,
		reasoningTokens: number
	): ThinkingStats {
		const key = messageKey(message);
		const reported = reasoningTokens > 0 ? reasoningTokens : 0;

		if (isStreaming) {
			const timestamp = this.now();
			if (!this.active || this.active.key !== key) {
				this.active = { key, first: timestamp, last: timestamp, text: fullText };
			} else if (this.active.text !== fullText) {
				this.active.last = timestamp;
				this.active.text = fullText;
			}

			return {
				durationMs: Math.max(0, this.active.last - this.active.first),
				tokens: reported > 0 ? reported : estimateTokens(fullText),
				estimated: reported <= 0,
			};
		}

		const cached = this.stats.get(key);
		if (cached) return cached;

		let durationMs = 0;
		if (this.active?.key === key) {
			durationMs = Math.max(0, this.active.last - this.active.first);
			this.active = undefined;
		}

		const stats: ThinkingStats = {
			durationMs,
			tokens: reported > 0 ? reported : estimateTokens(fullText),
			estimated: reported <= 0,
		};
		this.stats.set(key, stats);
		return stats;
	}

	/** Load previously persisted stats, e.g. on session start. */
	seed(records: readonly ThinkingStatsRecord[]): void {
		for (const record of records) {
			this.stats.set(record.key, {
				durationMs: record.durationMs,
				tokens: record.tokens,
				estimated: record.estimated,
			});
		}
	}

	/** Drop all in-memory stats (used when switching sessions). */
	clear(): void {
		this.stats.clear();
		this.active = undefined;
	}
}
