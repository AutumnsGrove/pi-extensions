import { describe, expect, it } from "vitest";
import {
	DEFAULT_DIVIDER,
	isPrideTheme,
	joinStatuses,
	sampleIndices,
	sanitizeStatusText,
} from "./divider.ts";

describe("isPrideTheme", () => {
	it("matches every theme in the pride pack", () => {
		expect(isPrideTheme("pride-dark")).toBe(true);
		expect(isPrideTheme("pride-light")).toBe(true);
		expect(isPrideTheme("pride-trans-dark")).toBe(true);
		expect(isPrideTheme("pride-pan-light")).toBe(true);
	});

	it("leaves other themes alone", () => {
		expect(isPrideTheme("dark")).toBe(false);
		expect(isPrideTheme("light")).toBe(false);
		expect(isPrideTheme(undefined)).toBe(false);
	});
});

describe("sampleIndices", () => {
	it("spreads samples evenly across a long ramp", () => {
		expect(sampleIndices(["a", "b", "c", "d", "e", "f"], 3)).toEqual([
			0, 3, 5,
		]);
	});

	it("alternates a short ramp instead of repeating a colour", () => {
		expect(sampleIndices(["a", "b"], 3)).toEqual([0, 1, 0]);
	});

	it("collapses duplicate values before sampling", () => {
		expect(sampleIndices(["a", "a", "b"], 3)).toEqual([0, 2, 0]);
		expect(sampleIndices(["a", "a", "b"], 2)).toEqual([0, 2]);
	});

	it("handles degenerate counts", () => {
		expect(sampleIndices(["a", "b"], 0)).toEqual([]);
		expect(sampleIndices([], 3)).toEqual([]);
		expect(sampleIndices(["a", "b"], 1)).toEqual([0]);
	});
});

describe("sanitizeStatusText", () => {
	it("collapses newlines, tabs and repeated spaces", () => {
		expect(sanitizeStatusText("a\nb\tc   d")).toBe("a b c d");
	});

	it("trims the ends", () => {
		expect(sanitizeStatusText("  spaced  ")).toBe("spaced");
	});
});

describe("joinStatuses", () => {
	it("returns an empty string for no statuses", () => {
		expect(joinStatuses(new Map(), ` ${DEFAULT_DIVIDER} `)).toBe("");
	});

	it("leaves a single status undivided", () => {
		expect(joinStatuses(new Map([["a", "alpha"]]), ` ${DEFAULT_DIVIDER} `)).toBe(
			"alpha"
		);
	});

	it("orders items by key and divides every adjacent pair", () => {
		const statuses = new Map([
			["openrouter-pin", "pin: DeepSeek"],
			["parallel", "parallel 12/4000"],
			["annual", "model x"],
		]);
		expect(joinStatuses(statuses, ` ${DEFAULT_DIVIDER} `)).toBe(
			"model x /// pin: DeepSeek /// parallel 12/4000"
		);
	});

	it("keeps the divider verbatim, including ANSI styling", () => {
		const divider = " \u001b[2m///\u001b[0m ";
		expect(
			joinStatuses(
				new Map([
					["a", "alpha"],
					["b", "beta"],
				]),
				divider
			)
		).toBe(`alpha${divider}beta`);
	});

	it("drops empty statuses so they cannot leave a dangling divider", () => {
		expect(
			joinStatuses(
				new Map([
					["a", "alpha"],
					["b", "   "],
					["c", "gamma"],
				]),
				" /// "
			)
		).toBe("alpha /// gamma");
	});

	it("sanitises each status before joining", () => {
		expect(
			joinStatuses(
				new Map([
					["a", "one\ntwo"],
					["b", "three"],
				]),
				" /// "
			)
		).toBe("one two /// three");
	});
});
