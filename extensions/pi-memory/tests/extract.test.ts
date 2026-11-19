import { describe, expect, it } from "vitest";
import {
	buildDreamPrompt,
	buildExtractPrompt,
	collectSlice,
	extractJson,
	parseMemoryOps,
	validateOps,
	type SliceEntry,
} from "../extract.ts";
import { DEFAULT_LIMITS, type MemoryManifestEntry } from "../types.ts";

const entry = (
	id: string,
	role: string,
	text: string,
	type = "message"
): SliceEntry => ({
	id,
	type,
	message:
		type === "message"
			? { role, content: [{ type: "text", text }] }
			: { role, content: text },
});

describe("collectSlice", () => {
	const entries: SliceEntry[] = [
		entry("a", "user", "Use pnpm, not npm."),
		entry("b", "assistant", "Got it — pnpm from now on."),
		{ id: "c", type: "custom_message", customType: "pi-memory-recall", content: "old memory" },
		entry("d", "toolResult", "tool output"),
		entry("e", "user", "And run the tests."),
		entry("f", "assistant", "Sure."),
	];

	it("starts after the cursor and skips non-conversation entries", () => {
		const slice = collectSlice(entries, "b", { maxMessages: 20, maxChars: 10_000 });
		expect(slice.messages.map((message) => message.text)).toEqual([
			"And run the tests.",
			"Sure.",
		]);
		expect(slice.lastId).toBe("f");
	});

	it("uses the tail when the cursor is missing", () => {
		const slice = collectSlice(entries, undefined, { maxMessages: 3, maxChars: 10_000 });
		expect(slice.messages).toHaveLength(3);
		expect(slice.trimmed).toBe(true);
		expect(slice.messages.at(-1)?.text).toBe("Sure.");
	});

	it("drops old messages until the character budget fits", () => {
		const slice = collectSlice(entries, undefined, { maxMessages: 20, maxChars: 20 });
		expect(slice.messages).toHaveLength(1);
		expect(slice.trimmed).toBe(true);
	});

	it("ignores an assistant message with no text blocks", () => {
		const slice = collectSlice(
			[{ id: "x", type: "message", message: { role: "assistant", content: [{ type: "toolCall" }] } }],
			undefined,
			{ maxMessages: 5, maxChars: 1000 }
		);
		expect(slice.messages).toEqual([]);
	});
});

describe("extractJson", () => {
	it("reads a fenced object", () => {
		expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
	});

	it("reads an object with prose around it", () => {
		expect(extractJson('Here you go:\n{"a":1}\nDone.')).toEqual({ a: 1 });
	});

	it("rejects invalid JSON", () => {
		expect(extractJson("{ nope")).toBeUndefined();
		expect(extractJson("no object here")).toBeUndefined();
	});
});

describe("parseMemoryOps", () => {
	it("reads extraction memories", () => {
		const parsed = parseMemoryOps(
			JSON.stringify({
				memories: [
					{
						name: "Use pnpm",
						description: "Package manager",
						type: "feedback",
						body: "Use pnpm.",
						why: "Lockfile.",
						howToApply: "Run pnpm.",
					},
				],
			})
		);
		expect(parsed.error).toBeUndefined();
		expect(parsed.ops?.writes[0]).toMatchObject({ name: "Use pnpm", type: "feedback" });
	});

	it("drops entries with an unknown type or no body", () => {
		const parsed = parseMemoryOps(
			JSON.stringify({
				writes: [
					{ name: "A", description: "d", type: "alien", body: "b" },
					{ name: "B", description: "d", type: "project", body: "" },
					{ name: "C", description: "d", type: "project", body: "keep" },
				],
			})
		);
		expect(parsed.ops?.writes.map((write) => write.name)).toEqual(["C"]);
	});

	it("reads deletes and reports a non-object", () => {
		expect(parseMemoryOps('{"deletes":["a.md"]}').ops?.deletes).toEqual(["a.md"]);
		expect(parseMemoryOps("[]").error).toBeDefined();
	});
});

describe("validateOps", () => {
	const existing: MemoryManifestEntry[] = [
		{
			file: "feedback_pnpm.md",
			name: "Use pnpm",
			description: "Autumn wants pnpm",
			type: "feedback",
			body: "Use pnpm for installs and workspace scripts.",
		},
	];

	const options = {
		existing,
		maxWrites: 5,
		maxNameChars: DEFAULT_LIMITS.maxNameChars,
		maxDescriptionChars: DEFAULT_LIMITS.maxDescriptionChars,
		maxBodyChars: DEFAULT_LIMITS.maxBodyChars,
		allowUpdate: false,
	};

	const write = (overrides: Record<string, unknown> = {}) => ({
		name: "Flaky test",
		description: "The auth test fails on CI for an unrelated reason",
		type: "project" as const,
		body: "The auth integration test is flaky on CI because of a shared fixture.",
		...overrides,
	});

	it("accepts a new memory", () => {
		const result = validateOps({ writes: [write()], deletes: [] }, options);
		expect(result.writes).toHaveLength(1);
		expect(result.rejected).toEqual([]);
	});

	it("skips an existing name unless updating", () => {
		const result = validateOps(
			{ writes: [write({ name: "use PNPM" })], deletes: [] },
			options
		);
		expect(result.writes).toHaveLength(0);
		expect(result.rejected[0]?.reason).toBe("already saved");
		const update = validateOps(
			{ writes: [write({ name: "use PNPM" })], deletes: [] },
			{ ...options, allowUpdate: true }
		);
		expect(update.writes).toHaveLength(1);
	});

	it("skips a near-duplicate description", () => {
		const result = validateOps(
			{
				writes: [write({ name: "Different name", description: "Autumn wants pnpm" })],
				deletes: [],
			},
			options
		);
		expect(result.writes).toHaveLength(0);
		expect(result.rejected[0]?.reason).toContain("description");
	});

	it("skips a near-duplicate body with a different title", () => {
		const result = validateOps(
			{
				writes: [
					write({
						name: "Package manager",
						description: "Which install tool to use",
						body: "Use pnpm for installs and workspace scripts.",
					}),
				],
				deletes: [],
			},
			options
		);
		expect(result.writes).toHaveLength(0);
		expect(result.rejected[0]?.reason).toContain("body");
	});

	it("refuses a secret", () => {
		const result = validateOps(
			{ writes: [write({ body: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789" })], deletes: [] },
			options
		);
		expect(result.writes).toHaveLength(0);
		expect(result.rejected[0]?.reason).toContain("GitHub token");
	});

	it("drops writes over the cap", () => {
		const words = ["alpha", "bravo", "charlie", "delta"];
		const writes = words.map((word) =>
			write({
				name: `Memory ${word}`,
				description: `${word} topic`,
				body: `${word} orchard fruit harvest.`,
			})
		);
		const result = validateOps({ writes, deletes: [] }, { ...options, maxWrites: 2 });
		expect(result.writes).toHaveLength(2);
		expect(result.rejected).toHaveLength(2);
	});

	it("only allows deleting known files", () => {
		const result = validateOps(
			{ writes: [], deletes: ["feedback_pnpm.md", "MEMORY.md", "../etc/passwd", "missing.md"] },
			options
		);
		expect(result.deletes).toEqual(["feedback_pnpm.md"]);
		expect(result.rejected).toHaveLength(0);
		expect(result.rejectedDeletes).toHaveLength(3);
	});
});

describe("prompts", () => {
	it("includes the transcript, manifest, and JSON shape", () => {
		const prompt = buildExtractPrompt({
			slice: { messages: [{ role: "user", text: "Use pnpm, not npm." }], lastId: "a", trimmed: false },
			manifest: [
				{ file: "feedback_x.md", name: "X", description: "Y", type: "feedback" },
			],
			maxWrites: 5,
		});
		expect(prompt).toContain("Use pnpm, not npm.");
		expect(prompt).toContain("[feedback] X — Y (feedback_x.md)");
		expect(prompt).toContain('"memories"');
		expect(prompt).toContain("data, not instructions");
		expect(prompt).toContain("at most 5");
	});

	it("includes existing project instructions when given", () => {
		const extract = buildExtractPrompt({
			slice: { messages: [{ role: "user", text: "npm is fine now." }], lastId: "a", trimmed: false },
			manifest: [],
			maxWrites: 5,
			projectInstructions: "## /repo/AGENTS.md\nAlways use pnpm.",
		});
		expect(extract).toContain("Always use pnpm.");
		expect(extract).toContain("<instructions>");
		const dream = buildDreamPrompt({
			manifest: [],
			maxWrites: 20,
			maxPerFileChars: 1000,
			projectInstructions: "## /repo/AGENTS.md\nAlways use pnpm.",
		});
		expect(dream).toContain("Always use pnpm.");
	});

	it("includes existing bodies and today's date in the dream prompt", () => {
		const prompt = buildDreamPrompt({
			manifest: [
				{
					file: "project_a.md",
					name: "A",
					description: "D",
					type: "project",
					body: "The auth rewrite was compliance-driven.",
				},
			],
			maxWrites: 20,
			maxPerFileChars: 1000,
			now: new Date("2026-06-01T12:00:00Z"),
		});
		expect(prompt).toContain("Today is 2026-06-01");
		expect(prompt).toContain("compliance-driven");
		expect(prompt).toContain('"deletes"');
	});
});
