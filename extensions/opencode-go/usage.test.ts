import { describe, expect, it } from "vitest";
import {
	computePace,
	formatBar,
	formatCountdown,
	formatMeterRow,
	formatPace,
	formatPercent,
	formatUsd,
	parseGoStatus,
	type UsageMeter,
} from "./usage.ts";

type MeterOverrides = Partial<UsageMeter> & Pick<UsageMeter, "kind" | "short">;
const meter = (over: MeterOverrides): UsageMeter => ({
	label: over.short,
	percent: 0,
	usedUsd: 0,
	limitUsd: 100,
	startsAt: null,
	resetsAt: null,
	...over,
});

const payload = {
	access: {
		startsAt: "2026-10-01T00:00:00.000Z",
		endsAt: "2026-11-01T00:00:00.000Z",
		meters: {
			fiveHour: {
				startsAt: "2026-10-09T07:00:00.000Z",
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

	it("keeps each window's own start and falls back to access.startsAt for the month", () => {
		const meters = parseGoStatus(payload);
		expect(meters[0]!.startsAt).toBe("2026-10-09T07:00:00.000Z");
		expect(meters[1]!.startsAt).toBeNull();
		expect(meters[2]!.startsAt).toBe("2026-10-01T00:00:00.000Z");
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

describe("computePace", () => {
	const start = Date.parse("2026-10-09T00:00:00.000Z");
	const HOUR = 3_600_000;
	const at = (hours: number) => new Date(start + hours * HOUR).toISOString();
	const bounds = { startsAt: at(0), resetsAt: at(100) };

	it("flags headroom when spending slower than the clock", () => {
		const pace = computePace(
			meter({ kind: "product_period", short: "mo", percent: 10, usedUsd: 10, ...bounds }),
			start + 25 * HOUR
		)!;
		expect(pace.status).toBe("under");
		expect(pace.elapsedPercent).toBeCloseTo(25);
		expect(pace.deltaPoints).toBeCloseTo(-15);
		expect(pace.projectedPercent).toBeCloseTo(40);
		expect(pace.remainingUsd).toBeCloseTo(90);
		expect(pace.remainingHours).toBeCloseTo(75);
		expect(formatPace(pace)).toBe("under pace (-15.0 pts) · tracks to 40% · $28.80/day left");
	});

	it("quotes an hourly rate inside short windows", () => {
		const pace = computePace(
			meter({
				kind: "five_hour",
				short: "5h",
				percent: 2,
				usedUsd: 2,
				startsAt: at(0),
				resetsAt: at(5),
			}),
			start + HOUR
		)!;
		expect(formatPace(pace)).toBe("under pace (-18.0 pts) · tracks to 10% · $24.50/hr left");
	});

	it("flags burning ahead of the clock", () => {
		const pace = computePace(
			meter({ kind: "five_hour", short: "5h", percent: 50, usedUsd: 50, ...bounds }),
			start + 25 * HOUR
		)!;
		expect(pace.status).toBe("over");
		expect(pace.projectedPercent).toBeCloseTo(200);
		expect(formatPace(pace)).toBe("over pace (+25.0 pts) · tracks to 200% · $16.00/day left");
	});

	it("treats a small drift as on pace", () => {
		const pace = computePace(
			meter({ kind: "calendar_week", short: "wk", percent: 52, usedUsd: 52, ...bounds }),
			start + 50 * HOUR
		)!;
		expect(pace.status).toBe("on");
		expect(formatPace(pace)).toBe("on pace · tracks to 104% · $23.04/day left");
	});

	it("returns null without an active, well-formed window", () => {
		const open = meter({ kind: "product_period", short: "mo" });
		expect(computePace(open, start)).toBeNull();
		expect(computePace(meter({ kind: "product_period", short: "mo", startsAt: at(0) }), start)).toBeNull();
		expect(computePace({ ...open, ...bounds }, start - HOUR)).toBeNull();
		expect(computePace({ ...open, ...bounds }, start + 101 * HOUR)).toBeNull();
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
