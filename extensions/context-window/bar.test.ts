import { describe, expect, it } from "vitest";
import { BAR_EMPTY, BAR_FILLED, formatPercent, renderBar } from "./bar.ts";

describe("renderBar", () => {
	it("renders empty, half, and full bars at the requested width", () => {
		expect(renderBar(0, 10)).toBe(BAR_EMPTY.repeat(10));
		expect(renderBar(0.5, 10)).toBe(BAR_FILLED.repeat(5) + BAR_EMPTY.repeat(5));
		expect(renderBar(1, 10)).toBe(BAR_FILLED.repeat(10));
	});

	it("clamps out-of-range and invalid fractions", () => {
		expect(renderBar(-1, 4)).toBe(BAR_EMPTY.repeat(4));
		expect(renderBar(2, 4)).toBe(BAR_FILLED.repeat(4));
		expect(renderBar(Number.NaN, 4)).toBe(BAR_EMPTY.repeat(4));
	});

	it("returns an empty string for zero width", () => {
		expect(renderBar(0.5, 0)).toBe("");
	});

	it("supports custom glyphs", () => {
		expect(renderBar(0.5, 4, "#", "-")).toBe("##--");
	});
});

describe("formatPercent", () => {
	it("formats with one decimal by default", () => {
		expect(formatPercent(0.469)).toBe("46.9%");
		expect(formatPercent(1)).toBe("100.0%");
	});

	it("does not clamp above 100%", () => {
		expect(formatPercent(1.25)).toBe("125.0%");
	});

	it("handles invalid input", () => {
		expect(formatPercent(Number.NaN)).toBe("?");
	});
});
