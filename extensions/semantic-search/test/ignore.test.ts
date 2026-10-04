import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	IgnoreTree,
	ancestorDirs,
	isRootUnindexable,
	makeSkip,
	parseLinguistExcluded,
} from "../src/index/ignore.ts";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "semsearch-ignore-"));
	dirs.push(dir);
	return dir;
}

function write(root: string, rel: string, content: string): void {
	const path = join(root, rel);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

const EXTS = [".ts", ".js"];

describe("built-in skips", () => {
	it("skips hardcoded directories", () => {
		const root = tempDir();
		const skip = makeSkip(root, EXTS);
		expect(skip("node_modules", true)).toBe(true);
		expect(skip("vendor", true)).toBe(true);
		expect(skip(".git", true)).toBe(true);
	});

	it("skips hardcoded lock files", () => {
		const root = tempDir();
		const skip = makeSkip(root, EXTS);
		expect(skip("package-lock.json", false)).toBe(true);
		expect(skip("deep/package-lock.json", false)).toBe(true);
	});

	it("filters by extension", () => {
		const root = tempDir();
		const skip = makeSkip(root, EXTS);
		expect(skip("a.ts", false)).toBe(false);
		expect(skip("a.md", false)).toBe(true);
	});
});

describe(".gitignore", () => {
	it("applies root patterns", () => {
		const root = tempDir();
		write(root, ".gitignore", "secret.ts\n");
		const skip = makeSkip(root, EXTS);
		expect(skip("secret.ts", false)).toBe(true);
		expect(skip("a.ts", false)).toBe(false);
	});

	it("honours negation patterns", () => {
		const root = tempDir();
		write(root, ".gitignore", "*.ts\n!keep.ts\n");
		const skip = makeSkip(root, EXTS);
		expect(skip("drop.ts", false)).toBe(true);
		expect(skip("keep.ts", false)).toBe(false);
	});

	it("applies nested patterns relative to their directory", () => {
		const root = tempDir();
		write(root, "sub/.gitignore", "hidden.ts\n");
		const skip = makeSkip(root, EXTS);
		expect(skip("sub/hidden.ts", false)).toBe(true);
		expect(skip("sub/visible.ts", false)).toBe(false);
		expect(skip("hidden.ts", false)).toBe(false);
	});
});

describe(".pi-searchignore", () => {
	it("applies root and nested patterns", () => {
		const root = tempDir();
		write(root, ".pi-searchignore", "gen.ts\n");
		write(root, "pkg/.pi-searchignore", "snap.ts\n");
		const skip = makeSkip(root, EXTS);
		expect(skip("gen.ts", false)).toBe(true);
		expect(skip("pkg/snap.ts", false)).toBe(true);
		expect(skip("pkg/ok.ts", false)).toBe(false);
	});
});

describe(".gitattributes linguist rules", () => {
	it("skips linguist-generated files", () => {
		const root = tempDir();
		write(root, ".gitattributes", "gen/*.js linguist-generated=true\n");
		const skip = makeSkip(root, EXTS);
		expect(skip("gen/a.js", false)).toBe(true);
		expect(skip("gen/a.ts", false)).toBe(false);
	});

	it("skips linguist-vendored files", () => {
		const root = tempDir();
		write(root, ".gitattributes", "bundle.js linguist-vendored\n");
		const skip = makeSkip(root, EXTS);
		expect(skip("bundle.js", false)).toBe(true);
	});

	it("does not skip non-linguist attributes", () => {
		const root = tempDir();
		write(root, ".gitattributes", "*.js text\n");
		const skip = makeSkip(root, EXTS);
		expect(skip("a.js", false)).toBe(false);
	});

	it("parses patterns directly", () => {
		const root = tempDir();
		write(root, ".gitattributes", "# comment\ngen/*.js linguist-generated\n\n");
		const matcher = parseLinguistExcluded(join(root, ".gitattributes"));
		expect(matcher?.ignores("gen/a.js")).toBe(true);
		expect(matcher?.ignores("src/a.js")).toBe(false);
	});
});

describe("combined layers and helpers", () => {
	it("applies all layers together", () => {
		const root = tempDir();
		write(root, ".gitignore", "ignored.ts\n");
		write(root, ".pi-searchignore", "custom.ts\n");
		const skip = makeSkip(root, EXTS);
		expect(skip("ignored.ts", false)).toBe(true);
		expect(skip("custom.ts", false)).toBe(true);
		expect(skip("node_modules", true)).toBe(true);
		expect(skip("index.ts", false)).toBe(false);
	});

	it("skips extra worktree directories", () => {
		const root = tempDir();
		const skip = makeSkip(root, EXTS, ["worktrees/feature"]);
		expect(skip("worktrees/feature", true)).toBe(true);
		expect(skip("worktrees/main", true)).toBe(false);
	});

	it("computes ancestor directories", () => {
		expect(ancestorDirs("")).toEqual([""]);
		expect(ancestorDirs("a/b")).toEqual(["", "a", "a/b"]);
	});

	it("flags system roots and home as unindexable", () => {
		expect(isRootUnindexable("/").unindexable).toBe(true);
		expect(isRootUnindexable("/tmp").unindexable).toBe(true);
	});

	it("flags a .pi-searchignore catch-all", () => {
		const root = tempDir();
		write(root, ".pi-searchignore", "**\n");
		const result = isRootUnindexable(root);
		expect(result.unindexable).toBe(true);
		expect(result.reason).toContain("catch-all");
	});
});
