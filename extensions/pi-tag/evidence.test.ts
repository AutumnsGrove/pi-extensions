import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	checkEvidence,
	describeEvidence,
	normalisePath,
	parseEvidence,
	phraseInTitle,
	treeAt,
	underPrefix,
} from "./evidence.ts";
import type { Label } from "./manifest.ts";

const TREE = new Set([
	"libs/shutter/cloudflare/src/index.ts",
	"libs/engine/package.json",
	"apps/landing/static/fonts/Calistoga-Regular.ttf",
	"docs/patterns/songbird-pattern.md",
	"docs/patterns/prism-pattern.md",
]);

const context = { title: "Clearing: stop the status page reporting outages", exists: (p: string) => TREE.has(p) };

const bug: Label = { name: "bug", group: "type", description: "d", when: "w" };
const lattice: Label = {
	name: "lattice",
	group: "component",
	description: "d",
	when: "w",
	path: "libs/, workers/",
};
const clearing: Label = { name: "clearing", group: "component", description: "d", when: "w", path: "apps/clearing/" };
const songbird: Label = {
	name: "pattern:songbird",
	group: "pattern",
	description: "d",
	when: "w",
	doc: "docs/patterns/songbird-pattern.md",
};

describe("phraseInTitle", () => {
	it("matches a whole word, case-insensitively", () => {
		expect(phraseInTitle("Clearing: stop the status page", "clearing")).toBe(true);
		expect(phraseInTitle("fix the CLEARING page", "Clearing")).toBe(true);
	});

	it("does not match inside a longer word", () => {
		expect(phraseInTitle("the clearinghouse is down", "clearing")).toBe(false);
		expect(phraseInTitle("linters disagree", "lint")).toBe(false);
	});

	it("treats regex characters in the phrase literally", () => {
		expect(phraseInTitle("Ship C++ support", "C++")).toBe(true);
		expect(phraseInTitle("Ship C support", "C++")).toBe(false);
	});

	it("rejects an empty phrase", () => {
		expect(phraseInTitle("anything", "   ")).toBe(false);
	});
});

describe("normalisePath", () => {
	it("folds the ways a model writes a path", () => {
		expect(normalisePath("./libs/x.ts")).toBe("libs/x.ts");
		expect(normalisePath("/libs/x.ts")).toBe("libs/x.ts");
		expect(normalisePath("libs\\x.ts")).toBe("libs/x.ts");
		expect(normalisePath("  libs/x.ts  ")).toBe("libs/x.ts");
	});

	it("refuses traversal and junk", () => {
		expect(normalisePath("../secrets")).toBeUndefined();
		expect(normalisePath("libs/../../etc/passwd")).toBeUndefined();
		expect(normalisePath("")).toBeUndefined();
		expect(normalisePath(42)).toBeUndefined();
	});
});

describe("underPrefix", () => {
	const prefixes = ["libs", "workers"];

	it("matches the prefix itself and anything inside it", () => {
		expect(underPrefix("libs", prefixes)).toBe("libs");
		expect(underPrefix("libs/engine/package.json", prefixes)).toBe("libs");
	});

	it("does not match a sibling with the same stem", () => {
		expect(underPrefix("libs2/engine/package.json", prefixes)).toBeUndefined();
		expect(underPrefix("workers-paused/x.ts", prefixes)).toBeUndefined();
	});
});

describe("parseEvidence", () => {
	it("keeps the three kinds and drops everything else", () => {
		expect(
			parseEvidence([
				{ kind: "title", phrase: "Clearing" },
				{ kind: "path", path: "./libs/x.ts" },
				{ kind: "doc", path: "docs/patterns/prism-pattern.md" },
				{ kind: "vibes", phrase: "felt right" },
				{ kind: "path", path: "../escape" },
				null,
				"nope",
			])
		).toEqual([
			{ kind: "title", phrase: "Clearing" },
			{ kind: "path", path: "libs/x.ts" },
			{ kind: "doc", path: "docs/patterns/prism-pattern.md" },
		]);
	});

	it("returns nothing for a non-array", () => {
		expect(parseEvidence({ kind: "title", phrase: "x" })).toEqual([]);
		expect(parseEvidence(undefined)).toEqual([]);
	});
});

describe("checkEvidence", () => {
	it("asks nothing more of a type label than the rule it cites", () => {
		expect(checkEvidence(bug, [], context)).toEqual({ ok: true });
	});

	it("accepts a component proven by its path", () => {
		const verdict = checkEvidence(lattice, [{ kind: "path", path: "libs/shutter/cloudflare/src/index.ts" }], context);
		expect(verdict).toEqual({ ok: true });
	});

	it("accepts a component named in the title", () => {
		expect(checkEvidence(clearing, [{ kind: "title", phrase: "Clearing" }], context)).toEqual({ ok: true });
	});

	it("rejects a title phrase that is not in the title", () => {
		const verdict = checkEvidence(clearing, [{ kind: "title", phrase: "Arbor" }], context);
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toBe('the title does not contain "Arbor"');
	});

	it("rejects a path that is not in the tree", () => {
		const verdict = checkEvidence(lattice, [{ kind: "path", path: "libs/ghost.ts" }], context);
		expect(verdict.reason).toBe('"libs/ghost.ts" is not in the tree');
	});

	it("rejects a real path that belongs to a different component", () => {
		const verdict = checkEvidence(
			clearing,
			[{ kind: "path", path: "libs/shutter/cloudflare/src/index.ts" }],
			context
		);
		expect(verdict.reason).toBe('"libs/shutter/cloudflare/src/index.ts" is not under `apps/clearing/`');
	});

	it("rejects a component with no evidence at all — the #1657 failure mode", () => {
		const verdict = checkEvidence(lattice, [], context);
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toContain("no evidence");
	});

	it("rejects a component whose only evidence is prose", () => {
		const verdict = checkEvidence(lattice, [{ kind: "doc", path: "docs/patterns/prism-pattern.md" }], context);
		expect(verdict.reason).toContain("no evidence");
	});

	it("accepts a pattern whose own doc was read", () => {
		const verdict = checkEvidence(songbird, [{ kind: "doc", path: "docs/patterns/songbird-pattern.md" }], context);
		expect(verdict).toEqual({ ok: true });
	});

	it("takes one good piece of evidence even when another is wrong", () => {
		const verdict = checkEvidence(
			lattice,
			[
				{ kind: "title", phrase: "Shutter" },
				{ kind: "path", path: "libs/shutter/cloudflare/src/index.ts" },
			],
			context
		);
		expect(verdict).toEqual({ ok: true });
	});

	it("reports the first failure when nothing proves the claim", () => {
		const verdict = checkEvidence(
			lattice,
			[
				{ kind: "title", phrase: "Shutter" },
				{ kind: "path", path: "libs/ghost.ts" },
			],
			context
		);
		expect(verdict.reason).toBe('the title does not contain "Shutter"');
	});

	it("rejects a pattern decided by a different pattern's doc", () => {
		const verdict = checkEvidence(songbird, [{ kind: "doc", path: "docs/patterns/prism-pattern.md" }], context);
		expect(verdict.reason).toBe('"docs/patterns/prism-pattern.md" is not that pattern\'s doc (docs/patterns/songbird-pattern.md)');
	});

	it("rejects a pattern with no doc evidence", () => {
		const verdict = checkEvidence(songbird, [{ kind: "path", path: "libs/engine/package.json" }], context);
		expect(verdict.reason).toContain("needs its doc read");
	});

	it("refuses a group a machine must not assign", () => {
		const priority: Label = { name: "priority-high", group: "priority", description: "d", when: "w" };
		expect(checkEvidence(priority, [], context).reason).toContain("not assigned by a machine");
	});
});

describe("describeEvidence", () => {
	it("phrases each kind for the comment", () => {
		expect(describeEvidence({ kind: "title", phrase: "Clearing" })).toBe("the title names `Clearing`");
		expect(describeEvidence({ kind: "path", path: "libs/x.ts" })).toBe("read `libs/x.ts`");
	});
});

describe("treeAt", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-tag-tree-"));
	mkdirSync(join(root, "libs"), { recursive: true });
	writeFileSync(join(root, "libs", "x.ts"), "export {};\n");
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	it("sees a file that is there", () => {
		expect(treeAt(root)("libs/x.ts")).toBe(true);
	});

	it("does not see one that is not", () => {
		expect(treeAt(root)("libs/y.ts")).toBe(false);
	});

	it("refuses to walk out of the checkout", () => {
		expect(treeAt(root)("../../etc/passwd")).toBe(false);
	});
});
