import { describe, expect, it } from "vitest";
import { makeChunk } from "../src/chunk/types.ts";
import {
	findSplitPoint,
	mergeUndersizedChunks,
	partitionLines,
	splitOversizedChunks,
} from "../src/index/split.ts";

function chunk(content: string, kind = "function", symbol = "F") {
	return makeChunk("a.ts", symbol, kind as never, 1, 1, content);
}

describe("splitOversizedChunks", () => {
	it("passes chunks under the limit through unchanged", () => {
		const input = [chunk("small")];
		expect(splitOversizedChunks(input, 100)).toEqual(input);
	});

	it("returns input unchanged when maxTokens is zero", () => {
		const input = [chunk("x".repeat(10_000))];
		expect(splitOversizedChunks(input, 0)).toEqual(input);
	});

	it("splits a large chunk into several sub-chunks", () => {
		const body = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
		const input = [chunk(body)];
		const result = splitOversizedChunks(input, 20); // 80 chars
		expect(result.length).toBeGreaterThan(1);
		for (const part of result) {
			expect(part.content.length).toBeLessThan(1000);
		}
	});

	it("passes a single huge line through unchanged (no infinite loop)", () => {
		const input = [chunk("x".repeat(2000))];
		const result = splitOversizedChunks(input, 4); // 16 chars
		expect(result).toHaveLength(1);
		expect(result[0]?.content).toBe(input[0]?.content);
	});
});

describe("partitionLines and boundary detection", () => {
	it("splits at a blank line", () => {
		const lines = ["a\n", "b\n", "\n", "c\n", "d\n"];
		const parts = partitionLines(lines, 5);
		expect(parts.length).toBeGreaterThan(1);
	});

	it("prefers a block-ending brace", () => {
		const index = findSplitPoint(["  x\n", "}\n", "y\n"]);
		expect(index).toBe(2);
	});

	it("falls back when no boundary is found", () => {
		expect(findSplitPoint(["aaa", "bbb", "ccc"])).toBe(0);
	});
});

describe("mergeUndersizedChunks", () => {
	it("merges adjacent undersized const chunks", () => {
		const a = chunk("const A = 1", "const", "A");
		const b = chunk("const B = 2", "const", "B");
		const merged = mergeUndersizedChunks([a, b]);
		expect(merged).toHaveLength(1);
		expect(merged[0]?.symbol).toBe("A+B");
		expect(merged[0]?.content).toContain("const A = 1");
		expect(merged[0]?.content).toContain("const B = 2");
	});

	it("never merges functions", () => {
		const a = chunk("function a() {}", "function", "a");
		const b = chunk("function b() {}", "function", "b");
		expect(mergeUndersizedChunks([a, b])).toHaveLength(2);
	});

	it("does not merge across kinds or files", () => {
		const a = chunk("const A = 1", "const", "A");
		const b = chunk("var B = 2", "var", "B");
		expect(mergeUndersizedChunks([a, b])).toHaveLength(2);
	});

	it("does not merge same-kind declarations far apart", () => {
		const a = makeChunk("a.ts", "A", "const", 1, 1, "const A = 1");
		const b = makeChunk("a.ts", "B", "const", 100, 100, "const B = 2");
		const merged = mergeUndersizedChunks([a, b]);
		expect(merged).toHaveLength(2);
		expect(merged[0]?.symbol).toBe("A");
	});
});
