import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildChunkers, type ChunkerSet } from "../src/chunk/index.ts";
import type { Embedder } from "../src/embed/types.ts";
import { Indexer } from "../src/index/indexer.ts";
import { runSearch } from "../src/search/service.ts";
import { Store } from "../src/store/sqlite.ts";

const KEYWORDS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];

function keywordEmbedder(): Embedder {
	return {
		modelName: "keyword",
		dimensions: KEYWORDS.length,
		async embed(texts: readonly string[]): Promise<number[][]> {
			return texts.map((text) => {
				const lower = text.toLowerCase();
				return KEYWORDS.map((keyword) => lower.split(keyword).length - 1);
			});
		},
	};
}

let chunkers: ChunkerSet;
const dirs: string[] = [];

beforeAll(async () => {
	chunkers = await buildChunkers(512);
});

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function project(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "semsearch-service-"));
	dirs.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const path = join(root, rel);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
	return root;
}

function setup(files: Record<string, string>) {
	const projectDir = project(files);
	const embedder = keywordEmbedder();
	const store = Store.open(":memory:", embedder.dimensions);
	const indexer = new Indexer({
		store,
		embedder,
		chunkers,
		maxChunkTokens: 512,
		projectDir,
	});
	return { projectDir, embedder, store, indexer };
}

const FILES = {
	"src/a.ts":
		"export function alpha() {\n  return 'alpha';\n}\n\nexport function alphaTwo() {\n  return 'alpha';\n}\n",
	"src/b.ts": "export function beta() {\n  return 'beta';\n}\n",
};

describe("runSearch", () => {
	it("indexes then returns the best-ranked result", async () => {
		const { projectDir, embedder, store, indexer } = setup(FILES);
		const { output, text } = await runSearch({
			store,
			embedder,
			indexer,
			projectDir,
			request: { query: "alpha", limit: 5 },
		});
		expect(output.reindexed).toBe(true);
		expect(output.results[0]?.filePath).toBe("src/a.ts");
		expect(text).toContain('<result:file filename="src/a.ts">');
		expect(text).toContain('symbol="alpha+alphaTwo"');
		store.close();
	});

	it("omits snippets in summary mode", async () => {
		const { projectDir, embedder, store, indexer } = setup(FILES);
		const { output } = await runSearch({
			store,
			embedder,
			indexer,
			projectDir,
			request: { query: "alpha", summary: true },
		});
		expect(output.results.length).toBeGreaterThan(0);
		expect(output.results[0]?.content).toBeUndefined();
		store.close();
	});

	it("does not re-index when already fresh", async () => {
		const { projectDir, embedder, store, indexer } = setup(FILES);
		await runSearch({ store, embedder, indexer, projectDir, request: { query: "alpha" } });
		const second = await runSearch({
			store,
			embedder,
			indexer,
			projectDir,
			request: { query: "beta" },
		});
		expect(second.output.reindexed).toBe(false);
		expect(second.output.results[0]?.filePath).toBe("src/b.ts");
		store.close();
	});

	it("stops when the caller aborts", async () => {
		const { projectDir, embedder, store, indexer } = setup(FILES);
		await expect(
			runSearch({
				store,
				embedder,
				indexer,
				projectDir,
				request: { query: "alpha" },
				signal: AbortSignal.abort(),
			})
		).rejects.toThrow(/aborted/);
		store.close();
	});
});
