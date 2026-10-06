import { describe, expect, it } from "vitest";
import { formatTokenCount, parseTokenCount, sizeSlug } from "./format.ts";

describe("parseTokenCount", () => {
	it("accepts bare integers", () => {
		expect(parseTokenCount("400000")).toBe(400000);
		expect(parseTokenCount(" 32000 ")).toBe(32000);
	});

	it("accepts thousands and millions suffixes", () => {
		expect(parseTokenCount("400k")).toBe(400000);
		expect(parseTokenCount("400K")).toBe(400000);
		expect(parseTokenCount("1m")).toBe(1_000_000);
		expect(parseTokenCount("1.5m")).toBe(1_500_000);
	});

	it("tolerates spaces and separators", () => {
		expect(parseTokenCount("400 k")).toBe(400000);
		expect(parseTokenCount("400_000")).toBe(400000);
		expect(parseTokenCount("1,000,000")).toBe(1_000_000);
	});

	it("rejects invalid input", () => {
		expect(parseTokenCount("")).toBeUndefined();
		expect(parseTokenCount("abc")).toBeUndefined();
		expect(parseTokenCount("0")).toBeUndefined();
		expect(parseTokenCount("-5")).toBeUndefined();
		expect(parseTokenCount("12x")).toBeUndefined();
	});
});

describe("formatTokenCount", () => {
	it("formats with compact suffixes", () => {
		expect(formatTokenCount(999)).toBe("999");
		expect(formatTokenCount(1000)).toBe("1k");
		expect(formatTokenCount(400000)).toBe("400k");
		expect(formatTokenCount(187400)).toBe("187.4k");
		expect(formatTokenCount(1_000_000)).toBe("1M");
		expect(formatTokenCount(1_500_000)).toBe("1.5M");
	});
});

describe("sizeSlug", () => {
	it("lowercases the unit for ids", () => {
		expect(sizeSlug(400000)).toBe("400k");
		expect(sizeSlug(1_500_000)).toBe("1.5m");
	});
});
