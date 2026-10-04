import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeSkip } from "../src/index/ignore.ts";
import {
	MAX_FILE_SIZE,
	buildDirHash,
	buildTree,
	diffTrees,
	type Tree,
} from "../src/index/merkle.ts";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "semsearch-merkle-"));
	dirs.push(dir);
	return dir;
}

function write(root: string, rel: string, content: string): void {
	const path = join(root, rel);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

const EXTS = [".ts", ".js"];

function skipFor(root: string) {
	return makeSkip(root, EXTS);
}

function treeOf(entries: Record<string, string>): Tree {
	return { rootHash: "", files: new Map(Object.entries(entries)) };
}

describe("buildTree", () => {
	it("hashes files and ignores .gitignore", async () => {
		const root = tempDir();
		write(root, "a.ts", "a");
		write(root, "b.ts", "b");
		write(root, "ignored.ts", "c");
		write(root, ".gitignore", "ignored.ts\n");
		const tree = await buildTree(root, skipFor(root));
		expect([...tree.files.keys()].sort()).toEqual(["a.ts", "b.ts"]);
		expect(tree.rootHash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("skips node_modules and vendor", async () => {
		const root = tempDir();
		write(root, "src/a.ts", "a");
		write(root, "node_modules/pkg/x.ts", "x");
		write(root, "vendor/y.ts", "y");
		const tree = await buildTree(root, skipFor(root));
		expect([...tree.files.keys()]).toEqual(["src/a.ts"]);
	});

	it("returns an empty tree for an empty directory", async () => {
		const root = tempDir();
		const tree = await buildTree(root, skipFor(root));
		expect(tree.files.size).toBe(0);
		expect(tree.rootHash).toBe(buildDirHash(new Map()));
	});

	it("skips symlinks", async () => {
		const root = tempDir();
		write(root, "real.ts", "real");
		symlinkSync(join(root, "real.ts"), join(root, "link.ts"));
		const tree = await buildTree(root, skipFor(root));
		expect([...tree.files.keys()]).toEqual(["real.ts"]);
	});

	it("skips files above the size limit", async () => {
		const root = tempDir();
		write(root, "small.ts", "small");
		writeFileSync(join(root, "big.ts"), Buffer.alloc(MAX_FILE_SIZE + 1));
		const tree = await buildTree(root, skipFor(root));
		expect([...tree.files.keys()]).toEqual(["small.ts"]);
	});

	it("produces a stable root hash for identical content", async () => {
		const a = tempDir();
		const b = tempDir();
		write(a, "x.ts", "same");
		write(b, "x.ts", "same");
		const first = await buildTree(a, skipFor(a));
		const second = await buildTree(b, skipFor(b));
		expect(first.rootHash).toBe(second.rootHash);
	});
});

describe("diffTrees", () => {
	it("detects no changes", () => {
		const oldTree = treeOf({ "a.ts": "1", "b.ts": "2" });
		const curTree = treeOf({ "a.ts": "1", "b.ts": "2" });
		expect(diffTrees(oldTree, curTree)).toEqual({
			added: [],
			removed: [],
			modified: [],
		});
	});

	it("detects modified files", () => {
		const result = diffTrees(treeOf({ "a.ts": "1" }), treeOf({ "a.ts": "2" }));
		expect(result.modified).toEqual(["a.ts"]);
	});

	it("detects added and removed files", () => {
		const result = diffTrees(
			treeOf({ "old.ts": "1" }),
			treeOf({ "new.ts": "1" })
		);
		expect(result.added).toEqual(["new.ts"]);
		expect(result.removed).toEqual(["old.ts"]);
	});
});
