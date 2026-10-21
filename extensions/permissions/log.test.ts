import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	appendDecision,
	decisionsPath,
	formatRecord,
	readDecisions,
	redactRecord,
	redactString,
	redactValue,
} from "./log.ts";
import type { DecisionRecord } from "./types.ts";

const dirs: string[] = [];

async function tempCtx(): Promise<ExtensionContext> {
	const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-"));
	dirs.push(cwd);
	return { cwd } as ExtensionContext;
}

function record(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
	return {
		v: 1,
		ts: new Date("2026-01-02T03:04:05Z").toISOString(),
		session_id: "session-1",
		cwd: "/repo",
		mode: "auto",
		tool: "bash",
		input: { command: "curl -H 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz'" },
		decision: "deny",
		source: "reviewer",
		reason: "exfiltration",
		latency_ms: 12,
		...overrides,
	};
}

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("redaction", () => {
	it("masks common secret shapes", () => {
		expect(redactString("key sk-abcdefghijklmnopqrstuvwxyz")).not.toContain("abcdefghijklmnop");
		expect(redactString("token=supersecret")).toContain("token=***");
		expect(redactString("Authorization: Bearer abcdefghijklmn")).not.toContain("abcdefghijklmn");
		expect(redactString("ghp_abcdefghijklmnopqrstuvwxyz")).toContain("ghp_***");
	});

	it("walks objects and arrays", () => {
		const redacted = redactValue({
			command: "sk-abcdefghijklmnopqrstuvwxyz",
			nested: [{ password: "hunter2" }],
		}) as Record<string, unknown>;
		expect(JSON.stringify(redacted)).not.toContain("hunter2");
		expect(JSON.stringify(redacted)).not.toContain("abcdefghijklmnop");
	});

	it("redacts a record unless full state is requested", () => {
		const redacted = redactRecord(record(), false);
		expect(JSON.stringify(redacted)).not.toContain("abcdefghijklmnop");
		const full = redactRecord(record(), true);
		expect(JSON.stringify(full)).toContain("abcdefghijklmnop");
	});
});

describe("appendDecision", () => {
	it("writes a gitignored JSONL line and reads it back", async () => {
		const ctx = await tempCtx();
		await appendDecision(ctx, record(), false);
		await appendDecision(ctx, record({ decision: "allow" }), false);

		const path = decisionsPath(ctx.cwd);
		const text = await readFile(path, "utf8");
		expect(text.trim().split("\n")).toHaveLength(2);
		expect(text).not.toContain("abcdefghijklmnop");

		const ignore = await readFile(join(ctx.cwd, ".pi", "permissions", ".gitignore"), "utf8");
		expect(ignore).toContain("*");

		const records = await readDecisions(ctx.cwd, 1);
		expect(records).toHaveLength(1);
		expect(records[0]?.decision).toBe("allow");
	});

	it("returns an empty list when the log is missing", async () => {
		const ctx = await tempCtx();
		expect(await readDecisions(ctx.cwd)).toEqual([]);
	});
});

describe("formatRecord", () => {
	it("renders one compact line", () => {
		const line = formatRecord(record());
		expect(line).toContain("DENY");
		expect(line).toContain("bash");
		expect(line).toContain("reviewer");
		expect(line).not.toContain("abcdefghijklmnop");
	});
});
