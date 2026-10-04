import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeChunk } from "../src/chunk/types.ts";
import { Store } from "../src/store/sqlite.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function tempDbPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "semsearch-store-"));
	tempDirs.push(dir);
	return join(dir, "index.db");
}

function chunk(filePath: string, symbol: string, kind = "function") {
	return makeChunk(filePath, symbol, kind as never, 1, 2, `${symbol} body`);
}

describe("Store schema and metadata", () => {
	it("creates the schema and round-trips metadata", () => {
		const store = Store.open(":memory:", 2);
		store.setMeta("root_hash", "abc");
		store.setMeta("root_hash", "def");
		expect(store.getMeta("root_hash")).toBe("def");
		expect(store.getMeta("missing")).toBeUndefined();
		expect(store.getMeta("vec_dimensions")).toBe("2");
		store.close();
	});

	it("recreates the vector table when dimensions change", () => {
		const path = tempDbPath();
		const store = Store.open(path, 2);
		store.insertChunks([chunk("a.ts", "A")], [[1, 0]]);
		expect(store.stats().totalChunks).toBe(1);
		store.close();

		const reopened = Store.open(path, 3);
		expect(reopened.getMeta("vec_dimensions")).toBe("3");
		expect(reopened.stats()).toEqual({ totalFiles: 0, totalChunks: 0 });
		reopened.insertChunks([chunk("a.ts", "A")], [[1, 0, 0]]);
		expect(reopened.stats().totalChunks).toBe(1);
		reopened.close();
	});
});

describe("Store upsert, search, delete", () => {
	it("upserts files and finds the nearest vector", () => {
		const store = Store.open(":memory:", 2);
		store.upsertFile("src/a.ts", "h1");
		store.upsertFile("src/b.ts", "h2");
		store.insertChunks(
			[chunk("src/a.ts", "A"), chunk("src/b.ts", "B")],
			[
				[1, 0],
				[0, 1],
			]
		);

		const results = store.search([1, 0], 5, 0);
		expect(results[0]?.filePath).toBe("src/a.ts");
		expect(results[0]?.symbol).toBe("A");
		expect(results[0]?.distance).toBeCloseTo(0, 5);

		expect(store.getFileHashes()).toEqual(
			new Map([
				["src/a.ts", "h1"],
				["src/b.ts", "h2"],
			])
		);
		store.close();
	});

	it("filters by max distance", () => {
		const store = Store.open(":memory:", 2);
		store.insertChunks(
			[chunk("a.ts", "A"), chunk("b.ts", "B")],
			[
				[1, 0],
				[0, 1],
			]
		);
		const all = store.search([1, 0], 5, 0);
		const tight = store.search([1, 0], 5, 0.5);
		expect(all.length).toBe(2);
		expect(tight.length).toBe(1);
		expect(tight[0]?.filePath).toBe("a.ts");
		store.close();
	});

	it("filters by path prefix without false positives", () => {
		const store = Store.open(":memory:", 2);
		store.insertChunks(
			[
				chunk("src/a.ts", "A"),
				chunk("test/a.ts", "B"),
				chunk("srcfoo.ts", "C"),
			],
			[
				[1, 0],
				[1, 0],
				[1, 0],
			]
		);
		const results = store.search([1, 0], 10, 0, "src");
		expect(results.map((r) => r.filePath).sort()).toEqual(["src/a.ts"]);
		store.close();
	});

	it("deletes a file's chunks and file record", () => {
		const store = Store.open(":memory:", 2);
		store.upsertFile("a.ts", "h");
		store.insertChunks([chunk("a.ts", "A")], [[1, 0]]);
		store.deleteFileChunks("a.ts");
		expect(store.stats()).toEqual({ totalFiles: 0, totalChunks: 0 });
		expect(store.search([1, 0], 5, 0)).toHaveLength(0);
		store.close();
	});

	it("deduplicates chunks with the same id in one batch", () => {
		const store = Store.open(":memory:", 2);
		const duplicate = chunk("a.ts", "A");
		store.insertChunks([duplicate, duplicate], [[1, 0], [1, 0]]);
		expect(store.stats().totalChunks).toBe(1);
		store.close();
	});

	it("replaces a vector when the same id is inserted again", () => {
		const store = Store.open(":memory:", 2);
		const duplicate = chunk("a.ts", "A");
		store.insertChunks([duplicate], [[1, 0]]);
		// A later call (retried batch, non-contiguous duplicate) must not trip the
		// vec0 primary key; the old plain INSERT threw here.
		expect(() => store.insertChunks([duplicate], [[0, 1]])).not.toThrow();
		expect(store.stats().totalChunks).toBe(1);
		expect(store.search([0, 1], 5, 0)[0]?.filePath).toBe("a.ts");
		store.close();
	});

	it("reports top symbols and sentinel files", () => {
		const store = Store.open(":memory:", 2);
		store.upsertFile("a.ts", "");
		store.insertChunks([chunk("a.ts", "A"), chunk("a.ts", "A2")], [[1, 0], [0, 1]]);
		expect(store.hasSentinelFiles()).toBe(true);
		expect(store.topSymbols(5).length).toBe(2);
		store.close();
	});

	it("throws on a chunk/vector length mismatch", () => {
		const store = Store.open(":memory:", 2);
		expect(() => store.insertChunks([chunk("a.ts", "A")], [])).toThrow(
			/length mismatch/
		);
		store.close();
	});
});
