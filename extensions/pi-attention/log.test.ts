import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_LOG_BYTES, appendVerdict, describeVerdicts, logPath, readVerdicts } from "./log.ts";
import type { VerdictRecord } from "./types.ts";

let dir: string;
let path: string;

const record = (overrides: Partial<VerdictRecord> = {}): VerdictRecord => ({
	at: 1_700_000_000_000,
	state: "waiting",
	source: "rule",
	reason: "passing checks, nothing to do",
	input: { toolCalls: 0 },
	...overrides,
});

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-attention-log-"));
	path = join(dir, "attention.jsonl");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	delete process.env.PI_ATTENTION_LOG;
});

describe("appendVerdict and readVerdicts", () => {
	it("round-trips records in order", () => {
		appendVerdict(record({ state: "working" }), path);
		appendVerdict(record({ state: "needs_you", source: "model", model: "openrouter/x" }), path);
		const records = readVerdicts(path);
		expect(records).toHaveLength(2);
		expect(records[0]?.state).toBe("working");
		expect(records[1]?.model).toBe("openrouter/x");
	});

	it("creates the directory and stays invisible on failure", () => {
		const nested = join(dir, "a", "b", "attention.jsonl");
		appendVerdict(record(), nested);
		expect(statSync(nested).size).toBeGreaterThan(0);
		expect(() => appendVerdict(record(), "/dev/null/nope/attention.jsonl")).not.toThrow();
	});

	it("skips a torn line instead of failing", () => {
		writeFileSync(path, `${JSON.stringify(record())}\n{"state":"wai`);
		expect(readVerdicts(path)).toHaveLength(1);
	});

	it("returns nothing for a missing file, and caps how much it reads", () => {
		expect(readVerdicts(join(dir, "missing.jsonl"))).toEqual([]);
		for (let index = 0; index < 5; index += 1) appendVerdict(record({ reason: `r${index}` }), path);
		expect(readVerdicts(path, 2)).toHaveLength(2);
	});

	it("rotates to the newest half past the size cap", () => {
		const filler = "x".repeat(1024);
		for (let index = 0; index < Math.ceil(MAX_LOG_BYTES / filler.length) + 2; index += 1) {
			appendVerdict(record({ reason: `${index}:${filler}` }), path);
		}
		expect(statSync(path).size).toBeLessThan(MAX_LOG_BYTES);
		const records = readVerdicts(path, 500);
		expect(records.length).toBeGreaterThan(1);
		// The newest record survives a rotation; the oldest are what got dropped.
		expect(records.at(-1)?.reason.startsWith(`${Math.ceil(MAX_LOG_BYTES / filler.length) + 1}:`)).toBe(true);
	});
});

describe("logPath", () => {
	it("defaults under the pi agent directory and honors the override", () => {
		expect(logPath({})).toContain(join(".pi", "agent", "attention.jsonl"));
		expect(logPath({ PI_ATTENTION_LOG: "/tmp/x.jsonl" })).toBe("/tmp/x.jsonl");
		expect(logPath({ PI_ATTENTION_LOG: "~/x.jsonl" })).not.toContain("~");
	});
});

describe("describeVerdicts", () => {
	it("says so when there is nothing", () => {
		expect(describeVerdicts([])).toEqual(["No verdicts logged yet."]);
	});

	it("renders state, source, model, and reason", () => {
		const [line] = describeVerdicts(
			[
				record({
					at: Date.now() - 70_000,
					state: "needs_you",
					source: "model",
					model: "openrouter/typesafe/jev-1.14",
					confidence: 0.72,
					reason: "wants a look",
				}),
			],
			Date.now(),
		);
		expect(line).toContain("needs_you 0.72 [model openrouter/typesafe/jev-1.14]");
		expect(line).toContain("wants a look");
		expect(line).toContain("1m ago");
	});
});
