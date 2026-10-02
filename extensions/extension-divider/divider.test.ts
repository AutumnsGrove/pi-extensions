import { describe, expect, it } from "vitest";
import { DEFAULT_DIVIDER, joinStatuses, sanitizeStatusText } from "./divider.ts";

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
