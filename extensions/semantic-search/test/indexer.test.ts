import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildChunkers, type ChunkerSet } from "../src/chunk/index.ts";
import type { Embedder } from "../src/embed/types.ts";
import { Indexer, META_LAST_INDEX_ERROR } from "../src/index/indexer.ts";
import { Store } from "../src/store/sqlite.ts";

const KEYWORDS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];

/** Deterministic bag-of-keywords embedder: no network, order-independent. */
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
	const root = mkdtempSync(join(tmpdir(), "semsearch-indexer-"));
	dirs.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const path = join(root, rel);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
	return root;
}

function makeIndexer(dir: string, embedder = keywordEmbedder()) {
	const store = Store.open(":memory:", embedder.dimensions);
	const indexer = new Indexer({
		store,
		embedder,
		chunkers,
		maxChunkTokens: 512,
		projectDir: dir,
	});
	return { store, indexer, embedder };
}

const START = {
	"a.ts": "export function alpha() {\n  return 'alpha';\n}\n",
	"b.ts": "export function beta() {\n  return 'beta';\n}\n",
};

describe("Indexer", () => {
	it("indexes and searches", async () => {
		const dir = project(START);
		const { store, indexer, embedder } = makeIndexer(dir);
		const stats = await indexer.index(false);
		expect(stats.totalFiles).toBe(2);
		expect(stats.chunksCreated).toBeGreaterThan(0);

		const [query] = await embedder.embed(["alpha"]);
		const results = store.search(query ?? [], 5, 0);
		expect(results[0]?.filePath).toBe("a.ts");
		store.close();
	});

	it("only re-indexes changed files", async () => {
		const dir = project(START);
		const { store, indexer } = makeIndexer(dir);
		await indexer.index(false);

		expect((await indexer.ensureFresh()).reindexed).toBe(false);

		writeFileSync(join(dir, "c.ts"), "export function gamma() {\n  return 1;\n}\n");
		const added = await indexer.ensureFresh();
		expect(added.reindexed).toBe(true);
		expect(added.stats.filesAdded).toBe(1);

		expect((await indexer.ensureFresh()).reindexed).toBe(false);
		store.close();
	});

	it("detects modified files", async () => {
		const dir = project(START);
		const { store, indexer } = makeIndexer(dir);
		await indexer.index(false);
		writeFileSync(join(dir, "a.ts"), "export function alpha() {\n  return 'changed';\n}\n");
		const result = await indexer.ensureFresh();
		expect(result.reindexed).toBe(true);
		expect(result.stats.filesModified).toBe(1);
		expect(result.stats.filesAdded).toBe(0);
		store.close();
	});

	it("force reindex removes deleted files", async () => {
		const dir = project(START);
		const { store, indexer } = makeIndexer(dir);
		await indexer.index(false);
		rmSync(join(dir, "b.ts"));
		const stats = await indexer.index(true);
		expect(stats.filesRemoved).toBe(1);
		expect(store.getFileHashes().has("b.ts")).toBe(false);
		store.close();
	});

	it("reports status and freshness", async () => {
		const dir = project(START);
		const { store, indexer } = makeIndexer(dir);
		await indexer.index(false);
		expect(await indexer.isFresh()).toBe(true);
		const status = indexer.status();
		expect(status.totalChunks).toBeGreaterThan(0);
		expect(status.embeddingModel).toBe("keyword");
		expect(status.lastIndexedAt).toBeTruthy();
		expect(status.lastIndexError).toBe("");
		expect(indexer.lastIndexedAt()).toBeInstanceOf(Date);
		store.close();
	});

	it("skips binary files", async () => {
		const dir = project({
			...START,
			"bin.ts": "export function alpha() {\u0000}\n",
		});
		const { store, indexer } = makeIndexer(dir);
		await indexer.index(false);
		expect(store.getFileHashes().has("bin.ts")).toBe(false);
		expect(store.getFileHashes().has("a.ts")).toBe(true);
		store.close();
	});

	it("records the last index error when embedding fails", async () => {
		const dir = project(START);
		const failing: Embedder = {
			modelName: "failing",
			dimensions: KEYWORDS.length,
			async embed(): Promise<number[][]> {
				throw new Error("boom");
			},
		};
		const store = Store.open(":memory:", KEYWORDS.length);
		const indexer = new Indexer({
			store,
			embedder: failing,
			chunkers,
			maxChunkTokens: 512,
			projectDir: dir,
		});
		await expect(indexer.index(false)).rejects.toThrow("boom");
		expect(store.getMeta(META_LAST_INDEX_ERROR)).toBe("boom");
		store.close();
	});

	it("treats a sentinel file hash as stale", async () => {
		const dir = project(START);
		const { store, indexer } = makeIndexer(dir);
		await indexer.index(false);
		store.upsertFile("a.ts", "");
		expect((await indexer.ensureFresh()).reindexed).toBe(true);
		store.close();
	});

	it("ignores unsupported files outright", async () => {
		const dir = project({ ...START, "notes.md": "# alpha alpha\n" });
		const { store, indexer } = makeIndexer(dir);
		await indexer.index(false);
		expect(store.getFileHashes().has("notes.md")).toBe(false);
		store.close();
	});
});
