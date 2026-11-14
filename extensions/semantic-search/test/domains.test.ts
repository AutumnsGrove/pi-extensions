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

/** Keyword embedder that counts how many texts it actually embedded. */
function countingEmbedder(): Embedder & { embedded: number } {
	const embedder = {
		modelName: "keyword",
		dimensions: KEYWORDS.length,
		embedded: 0,
		async embed(texts: readonly string[]): Promise<number[][]> {
			embedder.embedded += texts.length;
			return texts.map((text) => {
				const lower = text.toLowerCase();
				return KEYWORDS.map((keyword) => lower.split(keyword).length - 1);
			});
		},
	};
	return embedder;
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
	const root = mkdtempSync(join(tmpdir(), "semsearch-domain-"));
	dirs.push(root);
	for (const [rel, content] of Object.entries(files)) {
		const path = join(root, rel);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
	return root;
}

const REPO = {
	"pkg/a.ts": "export function alpha() {\n  return 'alpha';\n}\n",
	"pkg/b.ts": "export function beta() {\n  return 'beta';\n}\n",
	"other/c.ts": "export function gamma() {\n  return 'gamma';\n}\n",
	"root.ts": "export function delta() {\n  return 'delta';\n}\n",
};

function setup() {
	const repo = project(REPO);
	const embedder = countingEmbedder();
	const store = Store.open(":memory:", embedder.dimensions);
	const parent = new Indexer({
		store,
		embedder,
		chunkers,
		maxChunkTokens: 512,
		projectDir: repo,
	});
	const pkgDir = join(repo, "pkg");
	const child = new Indexer({
		store,
		embedder,
		chunkers,
		maxChunkTokens: 512,
		projectDir: pkgDir,
		domainDir: repo,
		rootPrefix: "pkg",
	});
	return { repo, pkgDir, embedder, store, parent, child };
}

describe("shared domains", () => {
	it("stores domain-relative paths from either root", async () => {
		const { store, parent } = setup();
		await parent.index(false);
		expect([...store.getFileHashes().keys()].sort()).toEqual([
			"other/c.ts",
			"pkg/a.ts",
			"pkg/b.ts",
			"root.ts",
		]);
		store.close();
	});

	it("embeds nothing when the parent already indexed the subtree", async () => {
		const { store, parent, child, embedder } = setup();
		await parent.index(false);
		const before = embedder.embedded;

		const result = await child.ensureFresh();
		// First run for this root records its own Merkle root, but every file is
		// already in the store, so nothing is chunked or embedded again.
		expect(result.reindexed).toBe(true);
		expect(result.stats.filesAdded).toBe(0);
		expect(result.stats.chunksCreated).toBe(0);
		expect(embedder.embedded).toBe(before);
		expect(store.getRoot(child.rootDir)?.rootHash).not.toBe("");
		store.close();
	});

	it("is fresh for the child once its own root is recorded", async () => {
		const { store, parent, child } = setup();
		await parent.index(false);
		await child.ensureFresh();
		const second = await child.ensureFresh();
		expect(second.reindexed).toBe(false);
		store.close();
	});

	it("returns only the invoking root's results", async () => {
		const { repo, pkgDir, store, parent, child, embedder } = setup();
		await parent.index(false);

		const { output } = await runSearch({
			store,
			embedder,
			indexer: child,
			projectDir: pkgDir,
			rootPrefix: "pkg",
			request: { query: "alpha", limit: 10, minScore: -1 },
		});
		expect(output.results.length).toBeGreaterThan(0);
		for (const result of output.results) {
			expect(result.filePath.startsWith("pkg/")).toBe(false);
			expect(["a.ts", "b.ts"]).toContain(result.filePath);
		}
		store.close();
	});

	it("keeps pathPrefix working inside the root scope", async () => {
		const { repo, pkgDir, store, parent, child, embedder } = setup();
		await parent.index(false);
		const { output } = await runSearch({
			store,
			embedder,
			indexer: child,
			projectDir: pkgDir,
			rootPrefix: "pkg",
			request: { query: "alpha", limit: 10, minScore: -1, pathPrefix: "a.ts" },
		});
		expect(output.results.map((result) => result.filePath)).toEqual(["a.ts"]);
		store.close();
	});

	it("reindexing the child leaves sibling rows untouched", async () => {
		const { store, parent, child } = setup();
		await parent.index(false);
		const before = store.getFileHashes();

		writeFileSync(join(child.rootDir, "a.ts"), "export function alpha() {\n  return 'changed';\n}\n");
		const stats = await child.index(true);
		expect(stats.totalFiles).toBe(2);

		const after = store.getFileHashes();
		for (const path of ["other/c.ts", "root.ts"]) {
			expect(after.get(path)).toBe(before.get(path));
		}
		expect(after.has("pkg/a.ts")).toBe(true);
		store.close();
	});

	it("garbage-collects rows no root covers", async () => {
		const { store, parent, child } = setup();
		await parent.index(false);
		await child.ensureFresh();
		expect(store.getFileHashes().size).toBe(4);

		// Drop the parent root: only pkg/... is still referenced.
		store.deleteRoot(parent.rootDir);
		expect(store.collectGarbage()).toBe(2);
		expect([...store.getFileHashes().keys()].sort()).toEqual(["pkg/a.ts", "pkg/b.ts"]);
		store.close();
	});

	it("removing a nested root keeps rows another root still uses", async () => {
		const { store, parent, child } = setup();
		await parent.index(false);
		await child.ensureFresh();
		store.deleteRoot(child.rootDir);
		expect(store.collectGarbage()).toBe(0);
		expect(store.getFileHashes().size).toBe(4);
		store.close();
	});

	it("records per-root stats instead of whole-domain totals", async () => {
		const { store, parent, child } = setup();
		await parent.index(false);
		await child.ensureFresh();
		expect(parent.status().totalFiles).toBe(4);
		expect(child.status().totalFiles).toBe(2);
		expect(child.status().totalChunks).toBeLessThanOrEqual(
			parent.status().totalChunks
		);
		store.close();
	});
});
