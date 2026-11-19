import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serializeMemory } from "../frontmatter.ts";
import { applyImport, formatImportPlan, planImport } from "../import.ts";
import { MemoryStore } from "../store.ts";

const dirs: string[] = [];
const tmp = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "pi-memory-import-"));
	dirs.push(dir);
	return dir;
};

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(files: Record<string, string>): { source: string; store: MemoryStore } {
	const source = join(tmp(), "claude-memory");
	mkdirSync(source, { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(join(source, name), content);
	}
	const store = new MemoryStore(join(tmp(), "pi-memory"));
	store.ensure();
	return { source, store };
}

const sample = (name: string, body: string, type: "feedback" | "project" = "feedback") =>
	serializeMemory({
		name,
		description: `${name} description`,
		type,
		body,
	});

describe("planImport", () => {
	it("plans files and skips the index and empties", () => {
		const { source, store } = setup({
			"MEMORY.md": "- [Use pnpm](feedback_pnpm.md) — hook\n",
			"feedback_pnpm.md": sample("Use pnpm", "Use pnpm for installs."),
			"project_auth.md": sample("Auth rewrite", "The rewrite was compliance-driven.", "project"),
			"empty.md": "---\nname: Empty\n---\n\n",
		});
		const plan = planImport(source, store);
		expect(plan.entries.map((entry) => entry.from)).toEqual(["feedback_pnpm.md", "project_auth.md"]);
		expect(plan.skipped.map((skip) => skip.file).sort()).toEqual(["MEMORY.md", "empty.md"]);
	});

	it("skips a memory the pi store already has", () => {
		const { source, store } = setup({
			"feedback_pnpm.md": sample("Use pnpm", "Use pnpm for installs."),
		});
		store.save({
			name: "Use pnpm",
			description: "Use pnpm description",
			type: "feedback",
			body: "Use pnpm for installs.",
		});
		const plan = planImport(source, store);
		expect(plan.entries).toHaveLength(0);
		expect(plan.skipped[0]?.reason).toContain("already present");
	});

	it("does not import the same memory twice from one batch", () => {
		const { source, store } = setup({
			"feedback_a.md": sample("Same title", "First body about caching."),
			"feedback_b.md": sample("Same title", "Second body about caching."),
		});
		const plan = planImport(source, store);
		expect(plan.entries).toHaveLength(1);
		expect(plan.skipped[0]?.reason).toContain("same name");
	});

	it("throws when the source is missing", () => {
		const store = new MemoryStore(join(tmp(), "store"));
		expect(() => planImport(join(tmp(), "missing"), store)).toThrow(/no Claude Code memory store/);
	});
});

describe("applyImport", () => {
	it("copies memories and rewrites the index without touching the source", () => {
		const { source, store } = setup({
			"feedback_pnpm.md": sample("Use pnpm", "Use pnpm for installs."),
			"project_auth.md": sample("Auth rewrite", "Compliance-driven.", "project"),
		});
		const before = readFileSync(join(source, "feedback_pnpm.md"), "utf8");
		const plan = planImport(source, store);
		const result = applyImport(plan, store);
		expect(result.imported).toBe(2);
		expect(result.updated).toBe(0);
		expect(store.files()).toHaveLength(2);
		expect(store.readIndex()).toContain("feedback_use_pnpm.md");
		expect(readFileSync(join(source, "feedback_pnpm.md"), "utf8")).toBe(before);
	});

	it("reports the plan in a readable form", () => {
		const { source, store } = setup({
			"feedback_pnpm.md": sample("Use pnpm", "Use pnpm for installs."),
		});
		const text = formatImportPlan(planImport(source, store));
		expect(text).toContain("1 to import");
		expect(text).toContain("feedback_pnpm.md → feedback_use_pnpm.md");
	});
});
