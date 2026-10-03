import { describe, expect, it } from "vitest";
import {
	collectStatsRecords,
	DEFAULT_PREVIEW_LINES,
	estimateTokens,
	EXPAND_HINT,
	extractThinkingRuns,
	formatDuration,
	formatHeader,
	formatTokens,
	messageKey,
	ThinkingStatsTracker,
} from "./stats.ts";

describe("DEFAULT_PREVIEW_LINES", () => {
	it("shows eight lines of thinking by default", () => {
		expect(DEFAULT_PREVIEW_LINES).toBe(8);
	});
});

describe("extractThinkingRuns", () => {
	it("returns nothing for undefined or empty content", () => {
		expect(extractThinkingRuns(undefined)).toEqual([]);
		expect(extractThinkingRuns([])).toEqual([]);
	});

	it("ignores non-thinking blocks and blank thinking", () => {
		expect(
			extractThinkingRuns([
				{ type: "text" },
				{ type: "thinking", thinking: "   " },
			])
		).toEqual([]);
	});

	it("joins consecutive thinking blocks with a blank line", () => {
		expect(
			extractThinkingRuns([
				{ type: "thinking", thinking: " first " },
				{ type: "thinking", thinking: "second" },
			])
		).toEqual(["first\n\nsecond"]);
	});

	it("splits runs separated by other content", () => {
		expect(
			extractThinkingRuns([
				{ type: "thinking", thinking: "one" },
				{ type: "text" },
				{ type: "thinking", thinking: "two" },
			])
		).toEqual(["one", "two"]);
	});
});

describe("estimateTokens", () => {
	it("is zero for empty text and at least one otherwise", () => {
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("   ")).toBe(0);
		expect(estimateTokens("hi")).toBe(1);
	});

	it("approximates four characters per token", () => {
		expect(estimateTokens("abcdefgh")).toBe(2);
	});
});

describe("formatDuration", () => {
	it("handles sub-second, second, minute and hour scales", () => {
		expect(formatDuration(400)).toBe("<1s");
		expect(formatDuration(1_200)).toBe("1.2s");
		expect(formatDuration(12_400)).toBe("12s");
		expect(formatDuration(65_000)).toBe("1m 5s");
		expect(formatDuration(120_000)).toBe("2m");
		expect(formatDuration(7_380_000)).toBe("2h 3m");
	});
});

describe("formatTokens", () => {
	it("formats raw, thousands and millions", () => {
		expect(formatTokens(834)).toBe("834");
		expect(formatTokens(3_400)).toBe("3.4k");
		expect(formatTokens(15_000)).toBe("15k");
		expect(formatTokens(1_200_000)).toBe("1.2M");
	});
});

describe("formatHeader", () => {
	it("uses the streaming verb with an estimate marker", () => {
		expect(
			formatHeader({
				streaming: true,
				expanded: false,
				stats: { durationMs: 12_000, tokens: 3_400, estimated: true },
			})
		).toBe("▸ Thinking for 12s, ~3.4k tokens");
		// The keybinding hint is rendered separately, right-aligned.
		expect(EXPAND_HINT).toBe("ctrl+o to expand");
	});

	it("uses the past verb and an expanded chevron", () => {
		expect(
			formatHeader({
				streaming: false,
				expanded: true,
				stats: { durationMs: 60_000, tokens: 100_000 },
			})
		).toBe("▾ Thought for 1m, 100k tokens");
	});

	it("falls back to a bare label without stats", () => {
		expect(
			formatHeader({ streaming: true, expanded: false, stats: undefined })
		).toContain("Thinking…");
	});

	it("omits the duration when only tokens are known", () => {
		expect(
			formatHeader({
				streaming: false,
				expanded: true,
				stats: { durationMs: 0, tokens: 500 },
			})
		).toBe("▾ Thought · 500 tokens");
	});
});

describe("messageKey", () => {
	it("uses the stable message start timestamp", () => {
		expect(
			messageKey({ timestamp: 10, responseId: "r", content: [1, 2] })
		).toBe("10");
	});

	it("is stable for the same message shape", () => {
		const a = { timestamp: 5, responseId: "x", content: [1] };
		const b = { timestamp: 5, responseId: "x", content: [1] };
		expect(messageKey(a)).toBe(messageKey(b));
	});

	it("does not change when content blocks are appended while streaming", () => {
		const early = { timestamp: 5, responseId: "r", content: [1] };
		const late = { timestamp: 5, responseId: "r", content: [1, 2, 3] };
		expect(messageKey(late)).toBe(messageKey(early));
	});

	it("falls back to the response id without a timestamp", () => {
		expect(messageKey({ responseId: "abc" })).toBe("abc");
	});
});

describe("collectStatsRecords", () => {
	it("keeps only well-formed thinking-stats entries", () => {
		const records = collectStatsRecords([
			{ type: "custom", customType: "other", data: { key: "x" } },
			{ type: "message" },
			{
				type: "custom",
				customType: "thinking-stats",
				data: { key: "k", durationMs: 1000, tokens: 10, estimated: true },
			},
			{ type: "custom", customType: "thinking-stats", data: { tokens: 5 } },
		]);

		expect(records).toEqual([
			{ key: "k", durationMs: 1000, tokens: 10, estimated: true },
		]);
	});
});

describe("ThinkingStatsTracker", () => {
	const message = (timestamp: number) => ({
		timestamp,
		responseId: "r",
		content: [{}],
	});

	it("measures duration from first to last changed token", () => {
		let clock = 1_000;
		const tracker = new ThinkingStatsTracker(() => clock);

		const first = tracker.observe(message(1), true, "a", 0);
		expect(first.durationMs).toBe(0);

		clock = 2_500;
		const growing = tracker.observe(message(1), true, "ab", 0);
		expect(growing.durationMs).toBe(1_500);

		clock = 6_000;
		const done = tracker.observe(message(1), false, "abc", 42);
		expect(done).toEqual({ durationMs: 1_500, tokens: 42, estimated: false });

		// A later re-render reuses the stored value.
		clock = 99_999;
		expect(tracker.observe(message(1), false, "abc", 42)).toEqual(done);
	});

	it("closes the active run at the last changed thinking token", () => {
		let clock = 0;
		const tracker = new ThinkingStatsTracker(() => clock);

		clock = 100;
		tracker.observe(message(2), true, "x", 0);
		clock = 500;
		tracker.observe(message(2), true, "xy", 0);
		clock = 900;
		tracker.observe(message(2), true, "xyz", 0);

		// A later end render with unchanged text does not extend the duration.
		clock = 5_000;
		const finished = tracker.observe(message(2), false, "xyz", 0);
		expect(finished.durationMs).toBe(800);
	});

	it("seeds and clears persisted stats", () => {
		const tracker = new ThinkingStatsTracker();
		tracker.seed([{ key: "3", durationMs: 5, tokens: 7 }]);
		expect(
			tracker.observe(message(3), false, "x", 0)
		).toEqual({ durationMs: 5, tokens: 7, estimated: undefined });
		tracker.clear();
		expect(
			tracker.observe(message(3), false, "", 0)
		).toEqual({ durationMs: 0, tokens: 0, estimated: true });
	});
});
