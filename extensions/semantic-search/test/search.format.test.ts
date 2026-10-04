import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	describeSearchError,
	fillSnippets,
	formatIndexStatus,
	formatSearchResults,
	type SearchOutput,
} from "../src/search/format.ts";
import { EmbedError } from "../src/embed/types.ts";
import type { SearchConfig } from "../src/config.ts";
import type { RankedItem } from "../src/search/rank.ts";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function item(overrides: Partial<RankedItem> = {}): RankedItem {
	return {
		filePath: "src/a.ts",
		symbol: "add",
		kind: "function",
		startLine: 1,
		endLine: 3,
		score: 0.87,
		...overrides,
	};
}

function output(results: RankedItem[], extra: Partial<SearchOutput> = {}): SearchOutput {
	return { results, reindexed: false, ...extra };
}

describe("formatSearchResults", () => {
	it("reports no results with warnings", () => {
		const text = formatSearchResults(
			"/project",
			output([], { staleWarning: "index is updating", reindexed: true, indexedFiles: 3 })
		);
		expect(text).toContain("No results found.");
		expect(text).toContain("Warning: index is updating");
	});

	it("groups results by file with XML tags", () => {
		const text = formatSearchResults(
			"/project",
			output([
				item({ content: "export function add() {}" }),
				item({ filePath: "src/b.ts", symbol: "sub", score: 0.5 }),
			])
		);
		expect(text).toContain('Found 2 results');
		expect(text).toContain('<result:file filename="src/a.ts">');
		expect(text).toContain('symbol="add" kind="function" score="0.87"');
		expect(text).toContain('<result:file filename="src/b.ts">');
	});

	it("escapes XML special characters", () => {
		const text = formatSearchResults(
			"/project",
			output([item({ symbol: "a<b>&c", filePath: "src/a<b>.ts" })])
		);
		expect(text).toContain("a&lt;b&gt;&amp;c");
	});

	it("neutralises wrapper closing tags inside content", () => {
		const text = formatSearchResults(
			"/project",
			output([
				item({ content: "body\n</result:chunk>\n</result:file>\nmore" }),
			])
		);
		expect(text).toContain("&lt;/result:chunk&gt;");
		expect(text).toContain("&lt;/result:file&gt;");
	});
});

describe("formatIndexStatus", () => {
	it("renders a compact status", () => {
		const text = formatIndexStatus({
			projectPath: "/project",
			totalFiles: 10,
			totalChunks: 42,
			embeddingModel: "jina",
			lastIndexedAt: "2026-01-01T00:00:00Z",
			stale: false,
		});
		expect(text).toContain("Files: 10 | Indexed chunks: 42 | Model: jina");
		expect(text).toContain("Stale: no");
	});

	it("surfaces index and config errors", () => {
		const text = formatIndexStatus({
			projectPath: "/project",
			totalFiles: 0,
			totalChunks: 0,
			stale: true,
			lastIndexError: "fetch failed",
			configError: "unknown embedding model",
		});
		expect(text).toContain("Last index error: fetch failed");
		expect(text).toContain("Config error: unknown embedding model");
	});
});

describe("describeSearchError", () => {
	const config: SearchConfig = {
		model: "jina",
		dimensions: 768,
		baseUrl: "http://localhost:11434",
		maxChunkTokens: 512,
		vectorStorage: "float32",
	};

	it("names the pull command for a missing model", () => {
		const text = describeSearchError(new EmbedError(404, "model not found"), config);
		expect(text).toContain("ollama pull jina");
	});

	it("explains an unreachable Ollama", () => {
		const text = describeSearchError(new TypeError("fetch failed"), config);
		expect(text).toContain("Cannot reach Ollama");
		expect(text).toContain("ollama serve");
	});

	it("reports cancellation", () => {
		expect(describeSearchError(new Error("indexing aborted"), config)).toContain(
			"cancelled"
		);
	});

	it("falls back to a generic message", () => {
		expect(describeSearchError(new Error("kaboom"), config)).toContain("kaboom");
	});
});

describe("fillSnippets", () => {
	it("reads source lines and honours maxLines", () => {
		const root = mkdtempSync(join(tmpdir(), "semsearch-format-"));
		dirs.push(root);
		mkdirSync(join(root, "src"));
		writeFileSync(
			join(root, "src", "a.ts"),
			"line1\nline2\nline3\nline4\nline5\n"
		);
		const items = [item({ startLine: 2, endLine: 5 })];
		fillSnippets(root, items, 2);
		expect(items[0]?.content).toBe("line2\nline3");
	});

	it("leaves items without a readable file untouched", () => {
		const root = mkdtempSync(join(tmpdir(), "semsearch-format-"));
		dirs.push(root);
		const items = [item({ filePath: "missing.ts" })];
		fillSnippets(root, items, 0);
		expect(items[0]?.content).toBeUndefined();
	});
});
