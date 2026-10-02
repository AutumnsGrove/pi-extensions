import { describe, expect, it } from "vitest";
import {
	formatCount,
	formatDiscount,
	formatLatency,
	formatPercentiles,
	formatPrice,
	formatUptime,
	pricePerMillion,
} from "./format.ts";

describe("pricePerMillion", () => {
	it("converts a per-token string to per-million", () => {
		expect(pricePerMillion("0.000000021")).toBeCloseTo(0.021);
	});

	it("accepts numbers and rejects junk", () => {
		expect(pricePerMillion(0.000002)).toBeCloseTo(2);
		expect(pricePerMillion("")).toBeUndefined();
		expect(pricePerMillion("abc")).toBeUndefined();
		expect(pricePerMillion(-1)).toBeUndefined();
		expect(pricePerMillion(null)).toBeUndefined();
	});
});

describe("formatPrice", () => {
	it("renders per-million dollars with useful precision", () => {
		expect(formatPrice("0.000000021")).toBe("$0.021");
		expect(formatPrice("0.0000025")).toBe("$2.50");
		expect(formatPrice("0.0000000004")).toBe("$0.0004");
	});

	it("marks free and missing prices", () => {
		expect(formatPrice("0")).toBe("free");
		expect(formatPrice(null)).toBe("—");
	});
});

describe("formatDiscount", () => {
	it("renders a fraction as a percent", () => {
		expect(formatDiscount(0.3)).toBe("30%");
		expect(formatDiscount(0.53)).toBe("53%");
		expect(formatDiscount(0.001)).toBe("0.1%");
	});

	it("treats values above one as already-percent and ignores zero", () => {
		expect(formatDiscount(15)).toBe("15%");
		expect(formatDiscount(0)).toBe("—");
		expect(formatDiscount(undefined)).toBe("—");
	});
});

describe("formatCount", () => {
	it("abbreviates large windows", () => {
		expect(formatCount(1_048_576)).toBe("1.0M");
		expect(formatCount(943_718)).toBe("944K");
		expect(formatCount(128_000)).toBe("128K");
		expect(formatCount(0)).toBe("—");
	});
});

describe("percentile formatting", () => {
	it("reads p50 and formats full percentile sweeps", () => {
		const stats = { p50: 636, p75: 745, p90: 1022, p99: 3045 };
		expect(formatLatency(stats)).toBe("636ms");
		expect(formatPercentiles(stats, "ms")).toBe("p50 636ms  p75 745ms  p90 1022ms  p99 3045ms");
	});

	it("handles missing stats", () => {
		expect(formatLatency(undefined)).toBe("—");
		expect(formatPercentiles(undefined, "ms")).toBe("—");
	});
});

describe("formatUptime", () => {
	it("renders one decimal or a dash", () => {
		expect(formatUptime(99.7767)).toBe("99.8");
		expect(formatUptime(undefined)).toBe("—");
	});
});
