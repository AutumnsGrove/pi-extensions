import { describe, expect, it } from "vitest";
import {
	cosine,
	embeddingText,
	formatSearchResults,
	keywordSearch,
	mergeSearchHits,
	semanticSearch,
	snippetFor,
	vectorKey,
	type SearchHit,
} from "../search.ts";
import type { MemoryFile } from "../types.ts";

const memory = (overrides: Partial<MemoryFile> = {}): MemoryFile => ({
	file: "feedback_pnpm.md",
	name: "Use pnpm",
	description: "Autumn wants pnpm for this repository",
	type: "feedback",
	body: "Use pnpm for installs.\n\n**Why:** npm rewrites the lockfile.",
	mtimeMs: 1_000,
	bytes: 120,
	...overrides,
});

describe("keywordSearch", () => {
	it("ranks name hits above description and body hits", () => {
		const files = [
			memory({ file: "body.md", name: "Notes", description: "x", body: "pnpm" }),
			memory({ file: "desc.md", name: "Tooling", description: "pnpm here" }),
			memory({ file: "name.md", name: "pnpm workspace", description: "x" }),
		];
		expect(keywordSearch(files, "pnpm", 10).map((hit) => hit.memory.file)).toEqual([
			"name.md",
			"desc.md",
			"body.md",
		]);
	});

	it("returns nothing for a stopword-only query", () => {
		expect(keywordSearch([memory()], "the and it", 10)).toEqual([]);
	});

	it("honours the limit", () => {
		const files = Array.from({ length: 5 }, (_, i) =>
			memory({ file: `f${i}.md`, name: `pnpm ${i}` })
		);
		expect(keywordSearch(files, "pnpm", 2)).toHaveLength(2);
	});

	it("builds a snippet from the best matching line", () => {
		const file = memory({ body: "First line.\nThe lockfile is why we use pnpm.\nLast line." });
		expect(snippetFor(file, "lockfile pnpm")).toContain("lockfile");
	});
});

describe("semanticSearch", () => {
	const files = [
		memory({ file: "pnpm.md", name: "Use pnpm", description: "Package manager", body: "pnpm install" }),
		memory({
			file: "auth.md",
			name: "Auth rewrite",
			description: "Compliance context",
			body: "compliance driven",
		}),
	];

	const fakeEmbed = (texts: readonly string[]): Promise<number[][]> =>
		Promise.resolve(
			texts.map((raw) => {
				const text = raw.toLowerCase();
				return text.includes("pnpm") ? [1, 0, 0] : text.includes("auth") ? [0, 1, 0] : [0.9, 0.1, 0];
			})
		);

	it("ranks by cosine and caches file vectors", async () => {
		let embeddedTexts = 0;
		const embed = (texts: readonly string[]) => {
			embeddedTexts += texts.length;
			return fakeEmbed(texts);
		};
		const first = await semanticSearch(files, {
			query: "pnpm",
			limit: 2,
			profile: "m:3",
			minScore: 0.5,
			embed,
			cache: {},
		});
		expect(first.hits.map((hit) => hit.memory.file)).toEqual(["pnpm.md"]);
		expect(first.embedded).toBe(2);
		expect(embeddedTexts).toBe(3); // two files + query

		const second = await semanticSearch(files, {
			query: "auth",
			limit: 2,
			profile: "m:3",
			minScore: 0.5,
			embed,
			cache: first.cache,
		});
		expect(second.hits.map((hit) => hit.memory.file)).toEqual(["auth.md"]);
		expect(second.embedded).toBe(0);
		expect(embeddedTexts).toBe(4); // query only
	});

	it("drops hits under the cosine floor", async () => {
		const result = await semanticSearch(files, {
			query: "pnpm",
			limit: 5,
			profile: "m:3",
			minScore: 1.5,
			embed: fakeEmbed,
			cache: {},
		});
		expect(result.hits).toHaveLength(0);
	});

	it("propagates an embedder failure", async () => {
		await expect(
			semanticSearch(files, {
				query: "pnpm",
				limit: 5,
				profile: "m:3",
				minScore: 0.1,
				embed: () => Promise.reject(new Error("ollama down")),
				cache: {},
			})
		).rejects.toThrow("ollama down");
	});

	it("invalidates a cache entry when the file changes", () => {
		const a = memory();
		const b = memory({ mtimeMs: 2_000 });
		expect(vectorKey("p", a)).not.toBe(vectorKey("p", b));
		expect(vectorKey("p", a)).not.toBe(vectorKey("q", a));
	});
});

describe("cosine", () => {
	it("computes similarity and handles degenerate vectors", () => {
		expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
		expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
		expect(cosine([0, 0], [1, 1])).toBe(0);
		expect(cosine([1], [1, 2])).toBe(0);
	});
});

describe("mergeSearchHits", () => {
	const hit = (file: string, source: "keyword" | "semantic"): SearchHit => ({
		memory: memory({ file }),
		score: 1,
		snippet: "",
		source,
	});

	it("keeps keyword order and appends unique semantic hits", () => {
		const merged = mergeSearchHits([hit("a.md", "keyword")], [hit("a.md", "semantic"), hit("b.md", "semantic")], 5);
		expect(merged.map((entry) => [entry.memory.file, entry.source])).toEqual([
			["a.md", "keyword"],
			["b.md", "semantic"],
		]);
	});

	it("stops at the limit", () => {
		expect(mergeSearchHits([hit("a.md", "keyword")], [hit("b.md", "semantic")], 1)).toHaveLength(1);
	});
});

describe("formatting", () => {
	it("formats hits and a note", () => {
		const text = formatSearchResults({
			hits: [
				{
					memory: memory(),
					score: 4,
					snippet: "Use pnpm for installs.",
					source: "keyword",
				},
			],
			note: "semantic search unavailable",
		});
		expect(text).toContain("1. [feedback] Use pnpm (feedback_pnpm.md) · keyword 4");
		expect(text).toContain("Use pnpm for installs.");
		expect(text).toContain("semantic search unavailable");
	});

	it("says so when nothing matched", () => {
		expect(formatSearchResults({ hits: [] })).toBe("No memories matched.");
	});

	it("builds embedding text from the name, description, and body", () => {
		expect(embeddingText(memory())).toContain("Use pnpm");
	});
});
