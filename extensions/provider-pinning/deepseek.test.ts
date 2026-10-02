import { describe, expect, it } from "vitest";
import {
	beijingDate,
	deepseekBadge,
	deepseekPeriod,
	formatRemaining,
	isChinesePublicHoliday,
	isDeepseekProvider,
	nextDeepseekTransition,
} from "./deepseek.ts";

const at = (iso: string): Date => new Date(iso);

describe("isDeepseekProvider", () => {
	it("matches the first-party provider and its tags", () => {
		expect(isDeepseekProvider("DeepSeek")).toBe(true);
		expect(isDeepseekProvider("deepseek")).toBe(true);
		expect(isDeepseekProvider("deepseek/fp8")).toBe(true);
	});

	it("rejects other providers and lookalikes", () => {
		expect(isDeepseekProvider("Morph")).toBe(false);
		expect(isDeepseekProvider("deepseek2")).toBe(false);
		expect(isDeepseekProvider(undefined)).toBe(false);
		expect(isDeepseekProvider("")).toBe(false);
	});
});

describe("beijingDate", () => {
	// Beijing is UTC+8 all year; a late-UTC instant belongs to the next day.
	it("shifts the UTC instant into the Beijing civil date", () => {
		expect(beijingDate(at("2026-10-01T02:00:00Z"))).toBe("2026-10-01");
		expect(beijingDate(at("2026-10-01T20:00:00Z"))).toBe("2026-10-02");
	});
});

describe("isChinesePublicHoliday", () => {
	it("knows the official 2026 blocks", () => {
		expect(isChinesePublicHoliday(at("2026-10-02T03:00:00Z"))).toBe(true); // National Day
		expect(isChinesePublicHoliday(at("2026-02-20T03:00:00Z"))).toBe(true); // Spring Festival
		expect(isChinesePublicHoliday(at("2026-10-08T03:00:00Z"))).toBe(false); // work resumes
	});
});

describe("deepseekPeriod", () => {
	it("is peak inside the two weekday windows", () => {
		expect(deepseekPeriod(at("2026-10-08T02:00:00Z"))).toBe("peak"); // Thu 02:00 UTC
		expect(deepseekPeriod(at("2026-10-08T07:00:00Z"))).toBe("peak"); // Thu 07:00 UTC
	});

	it("is off-peak at the edges, between windows, and on weekends", () => {
		expect(deepseekPeriod(at("2026-10-08T00:59:00Z"))).toBe("off-peak");
		expect(deepseekPeriod(at("2026-10-08T04:00:00Z"))).toBe("off-peak");
		expect(deepseekPeriod(at("2026-10-08T05:00:00Z"))).toBe("off-peak");
		expect(deepseekPeriod(at("2026-10-08T10:00:00Z"))).toBe("off-peak");
		expect(deepseekPeriod(at("2026-10-03T02:00:00Z"))).toBe("off-peak"); // Saturday
	});

	it("treats Chinese public holidays as off-peak in full", () => {
		// Thursday 1 Oct 2026, inside a normal peak window but a holiday.
		expect(deepseekPeriod(at("2026-10-01T02:00:00Z"))).toBe("off-peak");
	});
});

describe("nextDeepseekTransition", () => {
	it("finds the window start and end on a normal day", () => {
		expect(nextDeepseekTransition(at("2026-10-08T00:00:00Z"))?.toISOString()).toBe(
			"2026-10-08T01:00:00.000Z"
		);
		expect(nextDeepseekTransition(at("2026-10-08T02:00:00Z"))?.toISOString()).toBe(
			"2026-10-08T04:00:00.000Z"
		);
		expect(nextDeepseekTransition(at("2026-10-08T04:00:00Z"))?.toISOString()).toBe(
			"2026-10-08T06:00:00.000Z"
		);
		expect(nextDeepseekTransition(at("2026-10-08T07:00:00Z"))?.toISOString()).toBe(
			"2026-10-08T10:00:00.000Z"
		);
	});

	it("skips the weekend to the next Monday peak", () => {
		expect(nextDeepseekTransition(at("2026-10-09T11:00:00Z"))?.toISOString()).toBe(
			"2026-10-12T01:00:00.000Z"
		);
	});

	it("skips an entire Chinese holiday block", () => {
		// Off-peak on the eve of Golden Week; the next peak is after 7 October.
		expect(nextDeepseekTransition(at("2026-09-30T11:00:00Z"))?.toISOString()).toBe(
			"2026-10-08T01:00:00.000Z"
		);
	});
});

describe("formatRemaining", () => {
	it("renders days, hours and minutes", () => {
		expect(formatRemaining(0)).toBe("0m");
		expect(formatRemaining(45 * 60_000)).toBe("45m");
		expect(formatRemaining(2 * 3_600_000 + 5 * 60_000)).toBe("2h5m");
		expect(formatRemaining(2 * 86_400_000 + 3 * 3_600_000)).toBe("2d3h");
	});
});

describe("deepseekBadge", () => {
	it("names the period and the time until it flips", () => {
		expect(deepseekBadge(at("2026-10-08T02:00:00Z"))).toBe("DS peak 2h0m");
		expect(deepseekBadge(at("2026-10-08T07:30:00Z"))).toBe("DS peak 2h30m");
		expect(deepseekBadge(at("2026-10-08T11:00:00Z"))).toBe("DS off-peak 14h0m");
	});
});
