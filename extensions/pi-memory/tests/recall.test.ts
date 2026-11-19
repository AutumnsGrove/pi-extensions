import { describe, expect, it } from "vitest";
import {
	RECALL_PREAMBLE,
	formatManifest,
	formatMemories,
	recallOptions,
	scoreMemories,
	selectRecall,
} from "../recall.ts";
import { DEFAULT_LIMITS, type MemoryFile } from "../types.ts";

const now = Date.parse("2026-06-01T00:00:00Z");

const memory = (overrides: Partial<MemoryFile> = {}): MemoryFile => ({
	file: "feedback_pnpm.md",
	name: "Use pnpm",
	description: "Autumn wants pnpm for this repository",
	type: "feedback",
	body: "Use pnpm for installs and scripts.\n\n**Why:** npm rewrites the lockfile.",
	mtimeMs: now - 86_400_000,
	bytes: 100,
	...overrides,
});

describe("scoreMemories", () => {
	it("ranks a name match above a description match and a body match", () => {
		const name = memory({ file: "a.md", name: "pnpm workspace", description: "x" });
		const description = memory({ file: "b.md", name: "Tooling", description: "Use pnpm here" });
		const body = memory({ file: "c.md", name: "Notes", description: "x", body: "pnpm only" });
		const scored = scoreMemories([body, description, name], "pnpm", now);
		expect(scored.map((entry) => entry.memory.file)).toEqual(["a.md", "b.md"]);
	});

	it("ignores a single incidental body word", () => {
		const file = memory({ name: "Auth rewrite", description: "Compliance", body: "We used pnpm once." });
		expect(scoreMemories([file], "pnpm", now)).toEqual([]);
	});

	it("accepts two body terms as a strong match", () => {
		const file = memory({ name: "Auth rewrite", description: "Compliance", body: "pnpm workspace build" });
		expect(scoreMemories([file], "pnpm workspace", now)).toHaveLength(1);
	});

	it("returns nothing for a prompt with no useful tokens", () => {
		expect(scoreMemories([memory()], "the and for it", now)).toEqual([]);
	});

	it("gives a small recency edge without letting it dominate", () => {
		const recent = memory({ file: "recent.md", name: "Pnpm", mtimeMs: now });
		const old = memory({ file: "old.md", name: "Pnpm old", mtimeMs: now - 365 * 86_400_000 });
		const scored = scoreMemories([old, recent], "pnpm", now);
		expect(scored[0]?.memory.file).toBe("recent.md");
		expect(scored[1]?.score).toBeGreaterThan(0);
	});
});

describe("selectRecall", () => {
	it("injects the preamble, bodies, and footer", () => {
		const selection = selectRecall([memory()], "pnpm", recallOptions(DEFAULT_LIMITS), new Set(), now);
		expect(selection.selected).toHaveLength(1);
		expect(selection.text).toContain("<pi-memory>");
		expect(selection.text).toContain(RECALL_PREAMBLE);
		expect(selection.text).toContain("Use pnpm for installs");
		expect(selection.text.endsWith("</pi-memory>")).toBe(true);
	});

	it("respects the file cap", () => {
		const files = [
			memory({ file: "a.md", name: "pnpm a" }),
			memory({ file: "b.md", name: "pnpm b" }),
			memory({ file: "c.md", name: "pnpm c" }),
		];
		const selection = selectRecall(
			files,
			"pnpm",
			{ ...recallOptions(DEFAULT_LIMITS), maxFiles: 2 },
			new Set(),
			now
		);
		expect(selection.selected.map((file) => file.file)).toEqual(["a.md", "b.md"]);
	});

	it("respects the byte cap", () => {
		const files = Array.from({ length: 5 }, (_, i) =>
			memory({
				file: `f${i}.md`,
				name: `pnpm ${i}`,
				body: `Use pnpm.\n\n${"detail ".repeat(200)}`,
			})
		);
		const selection = selectRecall(
			files,
			"pnpm",
			{ ...recallOptions(DEFAULT_LIMITS), maxBytes: 900, maxBodyBytes: 400 },
			new Set(),
			now
		);
		expect(selection.bytes).toBeLessThanOrEqual(900);
		expect(selection.selected.length).toBeGreaterThan(0);
	});

	it("skips files already surfaced", () => {
		const file = memory();
		const selection = selectRecall(
			[file],
			"pnpm",
			recallOptions(DEFAULT_LIMITS),
			new Set([file.file]),
			now
		);
		expect(selection.text).toBe("");
	});

	it("returns an empty selection when the budget is too small for the preamble", () => {
		const selection = selectRecall(
			[memory()],
			"pnpm",
			{ ...recallOptions(DEFAULT_LIMITS), maxBytes: 10 },
			new Set(),
			now
		);
		expect(selection).toEqual({ selected: [], text: "", bytes: 0 });
	});
});

describe("formatters", () => {
	it("renders a full memory", () => {
		expect(formatMemories([memory()])).toContain("## Use pnpm");
		expect(formatMemories([])).toBe("No memories.");
	});

	it("renders the manifest", () => {
		expect(formatManifest([memory()])).toContain("feedback  Use pnpm (feedback_pnpm.md)");
		expect(formatManifest([])).toBe("No memories yet.");
	});
});
