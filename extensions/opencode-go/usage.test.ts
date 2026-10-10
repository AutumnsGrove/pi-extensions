import { describe, expect, it } from "vitest";
import {
	formatBar,
	formatCountdown,
	formatMeterRow,
	formatPercent,
	formatUsd,
	parseGoStatus,
} from "./usage.ts";

const payload = {
	access: {
		endsAt: "2026-11-01T00:00:00.000Z",
		meters: {
			fiveHour: {
				resetsAt: "2026-10-09T12:00:00.000Z",
				limitMicroCents: "1920000000",
				usedMicroCents: "1200000000",
			},
			week: {
				resetsAt: "2026-10-12T00:00:00.000Z",
				limitMicroCents: "9600000000",
				usedMicroCents: "3010000000",
			},
			month: { limitMicroCents: "9600000000", usedMicroCents: "4230000000" },
		},
	},
};

describe("parseGoStatus", () => {
	it("converts micro-cents to dollars and computes percentages", () => {
		const meters = parseGoStatus(payload);
		expect(meters.map((meter) => meter.kind)).toEqual([
			"five_hour",
			"calendar_week",
			"product_period",
		]);
		const fiveHour = meters[0]!;
		expect(fiveHour.usedUsd).toBeCloseTo(12);
		expect(fiveHour.limitUsd).toBeCloseTo(19.2);
		expect(fiveHour.percent).toBeCloseTo(62.5);
		expect(fiveHour.resetsAt).toBe("2026-10-09T12:00:00.000Z");
	});

	it("falls back to access.endsAt for the month reset", () => {
		const month = parseGoStatus(payload)[2]!;
		expect(month.resetsAt).toBe("2026-11-01T00:00:00.000Z");
	});

	it("returns an empty list when the payload has no meters", () => {
		expect(parseGoStatus({})).toEqual([]);
		expect(parseGoStatus(null)).toEqual([]);
	});

	it("clamps percentages to 0-100", () => {
		const meters = parseGoStatus({
			access: {
				meters: { fiveHour: { limitMicroCents: 100, usedMicroCents: 250 } },
			},
		});
		expect(meters[0]!.percent).toBe(100);
	});
});

describe("formatting", () => {
	it("formats dollars with more precision below $1", () => {
		expect(formatUsd(12)).toBe("$12.00");
		expect(formatUsd(19.2)).toBe("$19.20");
		expect(formatUsd(0.006)).toBe("$0.006");
	});

	it("formats percentages compactly", () => {
		expect(formatPercent(62.5)).toBe("62.5%");
		expect(formatPercent(31.4)).toBe("31.4%");
		expect(formatPercent(44.1)).toBe("44.1%");
		expect(formatPercent(62)).toBe("62%");
	});

	it("renders bars at the requested width", () => {
		expect(formatBar(0.5, 10)).toBe("█████░░░░░");
		expect(formatBar(0, 4)).toBe("░░░░");
		expect(formatBar(1, 4)).toBe("████");
		expect(formatBar(2, 4)).toBe("████");
	});

	it("formats reset countdowns", () => {
		const now = Date.parse("2026-10-09T10:00:00.000Z");
		expect(formatCountdown("2026-10-09T11:12:00.000Z", now)).toBe("1h 12m");
		expect(formatCountdown("2026-10-12T14:00:00.000Z", now)).toBe("3d 4h");
		expect(formatCountdown("2026-10-09T09:00:00.000Z", now)).toBe("resets now");
		expect(formatCountdown(null, now)).toBeNull();
	});

	it("builds an aligned meter row", () => {
		const row = formatMeterRow(parseGoStatus(payload)[0]!, 10, Date.parse("2026-10-09T10:00:00.000Z"));
		expect(row).toContain("Rolling 5h");
		expect(row).toContain("62.5%");
		expect(row).toContain("$12.00 / $19.20");
		expect(row).toContain("2h");
	});
});
