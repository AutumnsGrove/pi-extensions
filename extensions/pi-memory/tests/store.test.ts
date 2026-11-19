import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore, MemoryWriteError, emptyState } from "../store.ts";
import { DEFAULT_LIMITS } from "../types.ts";

const dirs: string[] = [];
const store = (limits = DEFAULT_LIMITS): MemoryStore => {
	const dir = mkdtempSync(join(tmpdir(), "pi-memory-store-"));
	dirs.push(dir);
	const instance = new MemoryStore(dir, limits);
	instance.ensure();
	return instance;
};

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const candidate = (overrides: Partial<Parameters<MemoryStore["save"]>[0]> = {}) => ({
	name: "Use pnpm",
	description: "Autumn wants pnpm, not npm",
	type: "feedback" as const,
	body: "Use pnpm for installs and scripts.",
	why: "npm rewrites the lockfile.",
	howToApply: "Run pnpm.",
	...overrides,
});

describe("save", () => {
	it("writes a file and rebuilds the index", () => {
		const s = store();
		const result = s.save(candidate());
		expect(result.file).toBe("feedback_use_pnpm.md");
		expect(result.created).toBe(true);
		const text = readFileSync(join(s.dir, result.file), "utf8");
		expect(text).toContain("name: Use pnpm");
		expect(text).toContain("**Why:** npm rewrites the lockfile.");
		expect(s.readIndex()).toBe(
			"- [Use pnpm](feedback_use_pnpm.md) — Autumn wants pnpm, not npm\n"
		);
		expect(s.files()).toHaveLength(1);
	});

	it("updates a same-named memory instead of duplicating it", () => {
		const s = store();
		s.save(candidate(), { now: Date.parse("2026-01-01T00:00:00Z") });
		const result = s.save(
			candidate({ description: "Still pnpm", howToApply: "Always pnpm." }),
			{ now: Date.parse("2026-02-01T00:00:00Z") }
		);
		expect(result.created).toBe(false);
		expect(result.file).toBe("feedback_use_pnpm.md");
		expect(s.files()).toHaveLength(1);
		expect(s.files()[0]?.description).toBe("Still pnpm");
		const text = readFileSync(join(s.dir, result.file), "utf8");
		expect(text).toContain("created: 2026-01-01T00:00:00Z");
		expect(text).toContain("updated: 2026-02-01T00:00:00Z");
	});

	it("suffixes a filename collision when the names differ", () => {
		const s = store();
		const prefix = "x".repeat(48);
		s.save(candidate({ name: `${prefix} alpha` }));
		s.save(candidate({ name: `${prefix} beta` }));
		expect(s.files().map((file) => file.file).sort()).toEqual([
			`feedback_${prefix}.md`,
			`feedback_${prefix}_2.md`,
		]);
		// Same normalised name updates; a genuinely different name gets a file.
		s.save(candidate({ name: "Pnpm" }));
		const second = s.save(candidate({ name: "PNPM" }));
		expect(second.created).toBe(false);
		const third = s.save(candidate({ name: "pnpm please" }));
		expect(third.file).toBe("feedback_pnpm_please.md");
	});

	it("refuses a type change in place", () => {
		const s = store();
		s.save(candidate());
		expect(() => s.save(candidate({ type: "project" }))).toThrow(MemoryWriteError);
	});

	it("refuses secrets and does not write the file", () => {
		const s = store();
		expect(() =>
			s.save(candidate({ body: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789" }))
		).toThrow(/GitHub token/);
		expect(s.files()).toHaveLength(0);
		expect(existsSync(s.indexPath)).toBe(false);
	});

	it("keeps distinct non-Latin titles apart", () => {
		const s = store();
		s.save(candidate({ name: "日本語のメモ", body: "First memory." }));
		const japanese = s.files()[0]!;
		s.save(candidate({ name: "中文记忆", body: "Second memory." }));
		expect(s.files()).toHaveLength(2);
		expect(s.forget("日本語のメモ")?.file).toBe(japanese.file);
		expect(s.files().map((file) => file.name)).toEqual(["中文记忆"]);
	});

	it("caps a long body instead of failing", () => {
		const s = store({ ...DEFAULT_LIMITS, maxBodyChars: 120 });
		const result = s.save(candidate({ body: "x".repeat(500) }));
		expect(result.created).toBe(true);
		expect(readFileSync(join(s.dir, result.file), "utf8")).toContain("truncated");
	});
});

describe("find and forget", () => {
	it("resolves by filename, name, and slug", () => {
		const s = store();
		s.save(candidate());
		expect(s.find("feedback_use_pnpm.md")?.file).toBe("feedback_use_pnpm.md");
		expect(s.find("use pnpm")?.file).toBe("feedback_use_pnpm.md");
		expect(s.find("feedback_use_pnpm")?.file).toBe("feedback_use_pnpm.md");
		expect(s.find("nope")).toBeUndefined();
	});

	it("removes a file and the index line", () => {
		const s = store();
		s.save(candidate());
		expect(s.forget("Use pnpm")?.file).toBe("feedback_use_pnpm.md");
		expect(s.files()).toHaveLength(0);
		expect(s.readIndex()).toBe("");
		expect(s.forget("Use pnpm")).toBeUndefined();
	});
});

describe("index", () => {
	it("sorts by type then name", () => {
		const s = store();
		s.save(candidate({ type: "reference", name: "Linear board" }));
		s.save(candidate({ type: "user", name: "Autumn" }));
		s.save(candidate({ type: "feedback", name: "Zeta" }));
		s.save(candidate({ type: "feedback", name: "Alpha" }));
		const lines = s.readIndex().trim().split("\n");
		expect(lines.map((line) => line.match(/\[(.*?)\]/)?.[1])).toEqual([
			"Autumn",
			"Alpha",
			"Zeta",
			"Linear board",
		]);
	});

	it("truncates under the line cap and says how many are missing", () => {
		const s = store({ ...DEFAULT_LIMITS, maxIndexLines: 4 });
		for (let i = 0; i < 6; i++) {
			s.save(candidate({ name: `Memory ${i}`, description: `Hook ${i}` }));
		}
		const lines = s.readIndex().trim().split("\n");
		expect(lines).toHaveLength(4);
		expect(lines[3]).toContain("3 more memories not shown");
	});

	it("truncates under the byte cap", () => {
		const s = store({ ...DEFAULT_LIMITS, maxIndexBytes: 220 });
		for (let i = 0; i < 10; i++) {
			s.save(candidate({ name: `Memory ${i}`, description: `A reasonably long hook ${i}` }));
		}
		const text = s.readIndex();
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(220);
		expect(text).toContain("not shown");
	});
});

describe("state", () => {
	it("round-trips and prunes to 40 sessions", () => {
		const s = store();
		const state = emptyState();
		for (let i = 0; i < 60; i++) {
			state.sessions[`s${i}`] = { turns: i, lastSeenAt: i };
		}
		state.lastDreamAt = "2026-01-01T00:00:00Z";
		s.writeState(state);
		const read = s.readState();
		expect(Object.keys(read.sessions)).toHaveLength(40);
		expect(read.sessions.s0).toBeUndefined();
		expect(read.sessions.s59?.turns).toBe(59);
		expect(read.lastDreamAt).toBe("2026-01-01T00:00:00Z");
	});

	it("survives a corrupt state file", () => {
		const s = store();
		writeFileSync(s.statePath, "{ what");
		expect(s.readState()).toEqual(emptyState());
	});
});

describe("lock", () => {
	it("is exclusive and releases", () => {
		const s = store();
		const release = s.acquireLock(1_000);
		expect(release).toBeDefined();
		expect(s.acquireLock(2_000)).toBeUndefined();
		release?.();
		expect(existsSync(s.lockPath)).toBe(false);
		expect(s.acquireLock(3_000)).toBeDefined();
	});

	it("steals a stale lock", () => {
		const s = store();
		writeFileSync(s.lockPath, JSON.stringify({ pid: 999_999, at: 0 }));
		expect(s.acquireLock(1_000_000, 120_000)).toBeDefined();
	});
});
