import { describe, expect, it } from "vitest";
import { createStructuredChunker } from "../src/chunk/structured.ts";

const small = createStructuredChunker(512);
const tiny = createStructuredChunker(4); // maxChars = 16

const LARGE_YAML = `alpha: |
  aaaaaaaaaaaaaaaaaaaa
beta: |
  bbbbbbbbbbbbbbbbbbbb
`;

const LARGE_JSON = `{
  "alpha": "aaaaaaaaaaaaaaaa",
  "beta": "bbbbbbbbbbbbbbbb"
}
`;

describe("StructuredChunker", () => {
	it("returns nothing for empty input", () => {
		expect(small.chunk("a.yaml", "")).toEqual([]);
		expect(small.chunk("a.yaml", "   \n  ")).toEqual([]);
	});

	it("keeps a small YAML file as one document chunk", () => {
		const chunks = small.chunk("a.yaml", "a: 1\nb: 2\n");
		expect(chunks).toHaveLength(1);
		expect(chunks[0]?.symbol).toBe("root");
		expect(chunks[0]?.kind).toBe("document");
	});

	it("splits a large YAML file at top-level keys", () => {
		const chunks = tiny.chunk("a.yaml", LARGE_YAML);
		expect(chunks.map((c) => c.symbol).sort()).toEqual(["alpha", "beta"]);
		for (const c of chunks) {
			expect(c.kind).toBe("section");
			expect(c.content.startsWith(`# path: ${c.symbol}\n`)).toBe(true);
		}
	});

	it("keeps a small JSON file as one document chunk", () => {
		const chunks = small.chunk("a.json", `{"a": 1, "b": 2}`);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]?.kind).toBe("document");
	});

	it("splits a large JSON file at top-level keys", () => {
		const chunks = tiny.chunk("a.json", LARGE_JSON);
		expect(chunks.map((c) => c.symbol).sort()).toEqual(["alpha", "beta"]);
	});

	it("handles multi-document YAML", () => {
		const chunks = tiny.chunk("a.yaml", "---\na: 1\n---\nb: 2\n");
		const symbols = chunks.map((c) => c.symbol);
		expect(symbols).toContain("a");
		expect(symbols).toContain("b");
	});

	it("reports real line ranges that point at the key", () => {
		const chunks = tiny.chunk("a.yaml", LARGE_YAML);
		const alpha = chunks.find((c) => c.symbol === "alpha");
		expect(alpha?.startLine).toBe(1);
	});

	it("treats top-level '- key: value' lines as sequence items", () => {
		const yaml = "- name: a\n  value: 1\n- name: b\n  value: 2\n";
		const chunks = tiny.chunk("a.yaml", yaml);
		expect(chunks.map((c) => c.symbol)).toEqual(["[0]", "[1]"]);
		expect(chunks[0]?.content).toContain("- name: a");
	});
});
