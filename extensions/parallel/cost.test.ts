import { describe, expect, it } from "vitest";
import { estimateExtractCost, estimateSearchCost, formatUsd } from "./cost.ts";

describe("estimateSearchCost", () => {
	it("charges the cheap tier for fast/turbo", () => {
		expect(estimateSearchCost("fast", 10)).toEqual({ queries: 1, usd: 0.001, searchRequests: 1 });
		expect(estimateSearchCost("turbo", 10).usd).toBeCloseTo(0.001);
	});

	it("charges the premium tier for basic/advanced", () => {
		expect(estimateSearchCost("basic", 10).usd).toBeCloseTo(0.005);
		expect(estimateSearchCost("advanced", 10).usd).toBeCloseTo(0.005);
	});

	it("adds $1/1k for results beyond the included ten", () => {
		expect(estimateSearchCost("fast", 20).usd).toBeCloseTo(0.011);
		expect(estimateSearchCost("advanced", 15).usd).toBeCloseTo(0.01);
	});
});

describe("estimateExtractCost", () => {
	it("counts one query and $0.001 per URL", () => {
		expect(estimateExtractCost(3)).toEqual({ queries: 3, usd: 0.003, extractUrls: 3 });
	});
});

describe("formatUsd", () => {
	it("never collapses a real cost to $0.00", () => {
		expect(formatUsd(0.001)).toBe("$0.0010");
		expect(formatUsd(0.5)).toBe("$0.50");
		expect(formatUsd(0)).toBe("$0");
	});
});
