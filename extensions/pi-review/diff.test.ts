import { describe, expect, it } from "vitest";
import { findDiffFile, isValidPosition, parseDiff, summarizeDiff } from "./diff.ts";

const modified = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,5 +1,6 @@
 import { setup } from "./setup";
 
-setup({ debug: false });
+setup({ debug: true });
+console.log("ready");
 
 export default setup;
`;

describe("parseDiff", () => {
	it("indexes both sides of a modified file", () => {
		const diff = parseDiff(modified);
		expect(diff.files).toHaveLength(1);
		const file = diff.files[0]!;
		expect(file.path).toBe("src/app.ts");
		expect(file.status).toBe("modified");
		expect(file.additions).toBe(2);
		expect(file.deletions).toBe(1);
		expect([...file.left].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
		expect([...file.right].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
	});

	it("validates positions per side", () => {
		const diff = parseDiff(modified);
		expect(isValidPosition(diff, "src/app.ts", "RIGHT", 3)).toBe(true);
		expect(isValidPosition(diff, "src/app.ts", "RIGHT", 4)).toBe(true);
		expect(isValidPosition(diff, "src/app.ts", "RIGHT", 5)).toBe(true);
		expect(isValidPosition(diff, "src/app.ts", "LEFT", 4)).toBe(true);
		expect(isValidPosition(diff, "src/app.ts", "LEFT", 6)).toBe(false);
		expect(isValidPosition(diff, "src/app.ts", "RIGHT", 99)).toBe(false);
		expect(isValidPosition(diff, "src/missing.ts", "RIGHT", 1)).toBe(false);
	});

	it("handles an added file with no left side", () => {
		const diff = parseDiff(`diff --git a/new.ts b/new.ts
new file mode 100644
index 0000000..2222222
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+one
+two
`);
		const file = diff.files[0]!;
		expect(file.status).toBe("added");
		expect(file.path).toBe("new.ts");
		expect(file.left.size).toBe(0);
		expect([...file.right]).toEqual([1, 2]);
	});

	it("handles a deleted file with no right side", () => {
		const diff = parseDiff(`diff --git a/old.ts b/old.ts
deleted file mode 100644
index 2222222..0000000
--- a/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-one
-two
`);
		const file = diff.files[0]!;
		expect(file.status).toBe("deleted");
		expect(file.path).toBe("old.ts");
		expect([...file.left]).toEqual([1, 2]);
		expect(file.right.size).toBe(0);
		expect(findDiffFile(diff, "old.ts")).toBe(file);
	});

	it("tracks renames and maps the old path", () => {
		const diff = parseDiff(`diff --git a/src/before.ts b/src/after.ts
similarity index 88%
rename from src/before.ts
rename to src/after.ts
index 1111111..2222222 100644
--- a/src/before.ts
+++ b/src/after.ts
@@ -1 +1 @@
-export const name = "before";
+export const name = "after";
`);
		const file = diff.files[0]!;
		expect(file.status).toBe("renamed");
		expect(file.path).toBe("src/after.ts");
		expect(file.oldPath).toBe("src/before.ts");
		expect(findDiffFile(diff, "src/before.ts")).toBe(file);
		expect(isValidPosition(diff, "src/after.ts", "RIGHT", 1)).toBe(true);
	});

	it("unquotes paths with spaces", () => {
		const diff = parseDiff(`diff --git "a/docs/my file.md" "b/docs/my file.md"
index 1111111..2222222 100644
--- "a/docs/my file.md"
+++ "b/docs/my file.md"
@@ -1 +1 @@
-old
+new
`);
		expect(diff.files[0]!.path).toBe("docs/my file.md");
		expect(isValidPosition(diff, "docs/my file.md", "RIGHT", 1)).toBe(true);
	});

	it("parses multiple hunks and files", () => {
		const diff = parseDiff(`${modified}diff --git a/lib/util.ts b/lib/util.ts
index 3333333..4444444 100644
--- a/lib/util.ts
+++ b/lib/util.ts
@@ -10,2 +10,3 @@ export function util() {
 const a = 1;
+const added = 2;
 const b = 3;
@@ -30,2 +31,1 @@ export function other() {
-const gone = 4;
 const kept = 5;
`);
		expect(diff.files).toHaveLength(2);
		const util = diff.byPath.get("lib/util.ts")!;
		expect([...util.right]).toEqual([10, 11, 12, 31]);
		expect([...util.left]).toEqual([10, 11, 30, 31]);
	});

	it("does not read file headers out of hunk content", () => {
		// A removed `-- comment` line arrives as `--- comment`, and an added
		// `++ marker` line as `+++ marker`; neither is a file header.
		const diff = parseDiff(`diff --git a/db/001.sql b/db/001.sql
index 1111111..2222222 100644
--- a/db/001.sql
+++ b/db/001.sql
@@ -1,3 +1,3 @@
--- drop the legacy index
+++ keep the index
 CREATE INDEX idx ON t (a);
 SELECT 1;
`);
		const file = diff.files[0]!;
		expect(diff.files).toHaveLength(1);
		expect(file.path).toBe("db/001.sql");
		expect(file.additions).toBe(1);
		expect(file.deletions).toBe(1);
		expect([...file.left]).toEqual([1, 2, 3]);
		expect([...file.right]).toEqual([1, 2, 3]);
		expect(diff.byPath.get(" drop the legacy index")).toBeUndefined();
	});

	it("marks binary files and tolerates an empty diff", () => {
		const diff = parseDiff(`diff --git a/logo.png b/logo.png
new file mode 100644
index 0000000..1111111
Binary files /dev/null and b/logo.png differ
`);
		expect(diff.files[0]!.binary).toBe(true);
		expect(diff.files[0]!.path).toBe("logo.png");
		expect(parseDiff("").files).toEqual([]);
	});
});

describe("summarizeDiff", () => {
	it("lists files with their status and line counts", () => {
		const diff = parseDiff(modified);
		expect(summarizeDiff(diff)).toBe("- src/app.ts (modified, +2 −1)");
		expect(summarizeDiff(parseDiff(""))).toBe("(no changed files)");
	});
});
