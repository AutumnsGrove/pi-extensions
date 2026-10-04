import { describe, expect, it } from "vitest";
import {
	boostedScore,
	isTestFile,
	mergeOverlappingResults,
	type RankedItem,
} from "../src/search/rank.ts";

function item(overrides: Partial<RankedItem> = {}): RankedItem {
	return {
		filePath: "src/a.ts",
		symbol: "A",
		kind: "function",
		startLine: 1,
		endLine: 10,
		score: 0.5,
		...overrides,
	};
}

describe("boostedScore", () => {
	it("boosts source declarations", () => {
		expect(boostedScore(0.5, "function", "src/a.ts")).toBeCloseTo(0.575);
	});

	it("caps the boost at 1", () => {
		expect(boostedScore(0.95, "type", "src/a.ts")).toBe(1);
	});

	it("demotes test files", () => {
		expect(boostedScore(0.8, "package", "src/a.test.ts")).toBeCloseTo(0.6);
	});

	it("leaves documentation unboosted", () => {
		expect(boostedScore(0.5, "section", "config.yaml")).toBe(0.5);
	});
});

describe("isTestFile", () => {
	it("detects common conventions", () => {
		expect(isTestFile("foo_test.go")).toBe(true);
		expect(isTestFile("foo_spec.rb")).toBe(true);
		expect(isTestFile("foo.test.ts")).toBe(true);
		expect(isTestFile("foo.spec.js")).toBe(true);
		expect(isTestFile("test_foo.py")).toBe(true);
		expect(isTestFile("src/tests/helper.ts")).toBe(true);
		expect(isTestFile("__tests__/a.tsx")).toBe(true);
	});

	it("does not flag regular files", () => {
		expect(isTestFile("src/component.ts")).toBe(false);
		expect(isTestFile("contest.ts")).toBe(false);
	});
});

describe("mergeOverlappingResults", () => {
	it("merges overlapping chunks and keeps the best score", () => {
		const merged = mergeOverlappingResults([
			item({ startLine: 1, endLine: 10, score: 0.5, symbol: "A" }),
			item({ startLine: 8, endLine: 20, score: 0.9, symbol: "B" }),
		]);
		expect(merged).toHaveLength(1);
		expect(merged[0]?.startLine).toBe(1);
		expect(merged[0]?.endLine).toBe(20);
		expect(merged[0]?.score).toBe(0.9);
		expect(merged[0]?.symbol).toBe("A+B");
	});

	it("merges chunks within the adjacency gap", () => {
		const merged = mergeOverlappingResults([
			item({ startLine: 1, endLine: 5 }),
			item({ startLine: 9, endLine: 12 }),
		]);
		expect(merged).toHaveLength(1);
	});

	it("keeps distant chunks separate", () => {
		const merged = mergeOverlappingResults([
			item({ startLine: 1, endLine: 5 }),
			item({ startLine: 100, endLine: 110 }),
		]);
		expect(merged).toHaveLength(2);
	});

	it("does not merge across files", () => {
		const merged = mergeOverlappingResults([
			item({ filePath: "a.ts", startLine: 1, endLine: 10 }),
			item({ filePath: "b.ts", startLine: 1, endLine: 10 }),
		]);
		expect(merged).toHaveLength(2);
	});
});
