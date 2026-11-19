import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	addExtractionSample,
	approxTokens,
	emptyExtractionEval,
	evaluateRecall,
	formatEvalReport,
	parseSessionJsonl,
	percentile,
	readSessionFiles,
	sessionSlice,
} from "../eval.ts";
import { DEFAULT_LIMITS, type MemoryFile } from "../types.ts";

const dirs: string[] = [];
const tmp = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "pi-memory-eval-"));
	dirs.push(dir);
	return dir;
};

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const message = (id: string, role: "user" | "assistant", text: string) => ({
	id,
	type: "message",
	message: { role, content: [{ type: "text", text }] },
});

describe("parseSessionJsonl", () => {
	it("keeps conversation entries and skips everything else", () => {
		const text = [
			JSON.stringify({ type: "session", version: 3 }),
			JSON.stringify(message("a", "user", "Use pnpm.")),
			JSON.stringify({ type: "custom", id: "b", customType: "x", data: {} }),
			JSON.stringify({ type: "custom_message", id: "c", customType: "recall", content: "hidden" }),
			"not json",
		].join("\n");
		const entries = parseSessionJsonl(text);
		expect(entries.map((entry) => entry.id)).toEqual(["a", "c"]);
	});
});

describe("readSessionFiles", () => {
	it("returns the newest files, up to the limit", () => {
		const dir = tmp();
		for (const name of ["one.jsonl", "two.jsonl", "three.jsonl"]) {
			writeFileSync(join(dir, name), JSON.stringify(message(name, "user", name)));
		}
		const files = readSessionFiles(dir, 2);
		expect(files).toHaveLength(2);
		expect(files.every((file) => file.entries.length === 1)).toBe(true);
	});

	it("returns nothing for a missing directory", () => {
		expect(readSessionFiles(join(tmp(), "nope"), 5)).toEqual([]);
	});
});

describe("evaluateRecall", () => {
	const memory = (overrides: Partial<MemoryFile> = {}): MemoryFile => ({
		file: "feedback_pnpm.md",
		name: "Use pnpm",
		description: "Package manager preference",
		type: "feedback",
		body: "Use pnpm for installs.",
		mtimeMs: 1_000,
		bytes: 100,
		...overrides,
	});

	it("counts turns, injections, bytes, and repeated files", () => {
		const sessions = [
			{
				path: "a.jsonl",
				entries: [
					message("1", "user", "pnpm install please"),
					message("2", "user", "what is the weather"),
					message("3", "user", "pnpm again"),
				],
			},
			{
				path: "b.jsonl",
				entries: [message("4", "user", "pnpm setup")],
			},
		];
		const result = evaluateRecall(sessions, [memory()], {
			limits: DEFAULT_LIMITS,
			now: 2_000,
		});
		expect(result.sessions).toBe(2);
		expect(result.turns).toBe(4);
		// Surfaces reset per session, so the second session recalls it again.
		expect(result.injectedTurns).toBe(2);
		expect(result.emptyTurns).toBe(2);
		expect(result.bytes).toHaveLength(2);
		expect(result.files.get("feedback_pnpm.md")).toBe(2);
	});
});

describe("aggregation", () => {
	it("computes percentiles and token estimates", () => {
		expect(percentile([], 0.5)).toBe(0);
		expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
		expect(percentile([1, 2, 3, 4], 0.95)).toBe(4);
		expect(approxTokens(4_000)).toBe(1000);
	});

	it("tallies extraction samples", () => {
		const evaluation = emptyExtractionEval();
		addExtractionSample(evaluation, {
			session: "a.jsonl",
			proposed: 2,
			accepted: 1,
			rejected: [{ name: "B", reason: "already saved" }],
			writes: [{ name: "A", type: "feedback", description: "d" }],
		});
		expect(evaluation.sessions).toBe(1);
		expect(evaluation.proposed).toBe(2);
		expect(evaluation.accepted).toBe(1);
		expect(evaluation.rejectedReasons.get("already saved")).toBe(1);
	});

	it("formats a report with recall and extraction sections", () => {
		const read = evaluateRecall(
			[{ path: "a.jsonl", entries: [message("1", "user", "pnpm install")] }],
			[
				{
					file: "feedback_pnpm.md",
					name: "Use pnpm",
					description: "Package manager preference",
					type: "feedback",
					body: "Use pnpm.",
					mtimeMs: 1_000,
					bytes: 50,
				},
			],
			{ limits: DEFAULT_LIMITS, now: 2_000 }
		);
		const extraction = emptyExtractionEval();
		addExtractionSample(extraction, {
			session: "a.jsonl",
			proposed: 1,
			accepted: 1,
			rejected: [],
			writes: [{ name: "Use pnpm", type: "feedback", description: "d" }],
		});
		const report = formatEvalReport({
			recall: read,
			extraction,
			storeDir: "/tmp/store",
			memories: 1,
			indexLines: 1,
			now: new Date("2026-06-01T00:00:00Z"),
		});
		expect(report).toContain("# pi-memory eval");
		expect(report).toContain("## Recall");
		expect(report).toContain("## Extraction");
		expect(report).toContain("[feedback] Use pnpm");
	});

	it("builds a session slice", () => {
		const slice = sessionSlice(
			{ path: "a.jsonl", entries: [message("1", "user", "hello there")] },
			{ maxMessages: 10, maxChars: 1000 }
		);
		expect(slice.messages[0]?.text).toBe("hello there");
	});
});
