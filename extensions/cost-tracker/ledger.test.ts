import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	addUsage,
	aggregateByLabel,
	allRunsWithHistory,
	appendRun,
	clearActive,
	costStateDir,
	formatDuration,
	formatTokens,
	formatUsd,
	normalizeUsage,
	readActive,
	readRuns,
	readUsageForCwd,
	readUsageFromFile,
	renderCostTable,
	sessionDirForCwd,
	startRun,
	stopRun,
	upsertCostBlock,
	usageInWindow,
	zeroUsage,
	type RunRecord,
} from "./ledger.ts";

let work: string;
let agent: string;
let cwd: string;

beforeEach(() => {
	work = mkdtempSync(join(tmpdir(), "cost-ledger-"));
	agent = join(work, "agent");
	cwd = join(work, "project");
	mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
	rmSync(work, { recursive: true, force: true });
});

function writeSession(cwdPath: string, name: string, records: unknown[]): string {
	const dir = sessionDirForCwd(cwdPath, agent);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, name);
	writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
	return file;
}

describe("usage math", () => {
	it("adds every field", () => {
		const a = { ...zeroUsage(), input: 1, output: 2, cost: 0.1 };
		const b = { ...zeroUsage(), cacheRead: 3, cacheWrite: 4, cost: 0.2 };
		expect(addUsage(a, b)).toMatchObject({
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			cost: 0.30000000000000004,
		});
	});

	it("normalizes a pi usage block and falls back totalTokens", () => {
		const usage = normalizeUsage({
			input: 10,
			output: 5,
			cacheRead: 2,
			cacheWrite: 1,
			cost: { total: 0.42 },
		});
		expect(usage).toEqual({
			input: 10,
			output: 5,
			cacheRead: 2,
			cacheWrite: 1,
			totalTokens: 18,
			cost: 0.42,
		});
	});

	it("treats missing or malformed usage as zero", () => {
		expect(normalizeUsage(undefined)).toEqual(zeroUsage());
		expect(normalizeUsage({ input: "nope", cost: null })).toEqual(zeroUsage());
	});
});

describe("session discovery", () => {
	it("mirrors pi's session slug", () => {
		const dir = sessionDirForCwd("/Users/autumn/Documents/Projects/pi-extensions", agent);
		expect(dir).toBe(
			join(agent, "sessions", "--Users-autumn-Documents-Projects-pi-extensions--")
		);
	});

	it("extracts assistant, toolResult, and usage entries", () => {
		const file = writeSession(cwd, "s.jsonl", [
			{ type: "session", timestamp: "2026-01-01T00:00:00.000Z" },
			{
				type: "message",
				timestamp: "2026-01-01T00:00:10.000Z",
				message: {
					role: "assistant",
					model: "m1",
					provider: "p1",
					usage: { input: 100, output: 50, totalTokens: 150, cost: { total: 0.001 } },
				},
			},
			{
				type: "message",
				timestamp: "2026-01-01T00:00:20.000Z",
				message: { role: "user", content: "hi" },
			},
			{
				type: "message",
				timestamp: "2026-01-01T00:00:30.000Z",
				message: {
					role: "toolResult",
					usage: { input: 5, totalTokens: 5, cost: { total: 0.0001 } },
				},
			},
			{
				type: "usage",
				timestamp: "2026-01-01T00:00:40.000Z",
				model: "m1",
				provider: "p1",
				usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0.00001 } },
			},
			"not json",
		]);
		const records = readUsageFromFile(file);
		expect(records).toHaveLength(3);
		expect(records.map((r) => r.usage.cost)).toEqual([0.001, 0.0001, 0.00001]);
		expect(records[0]?.model).toBe("m1");
	});

	it("windows records by timestamp", () => {
		const records = [
			{ timestamp: 100, model: "m", provider: "p", usage: { ...zeroUsage(), cost: 1 } },
			{ timestamp: 200, model: "m", provider: "p", usage: { ...zeroUsage(), cost: 2 } },
			{ timestamp: 300, model: "m", provider: "p", usage: { ...zeroUsage(), cost: 4 } },
		];
		const { usage, models } = usageInWindow(records, 150, 300);
		expect(usage.cost).toBe(6);
		expect(models.m).toBe(6);
	});
});

describe("run lifecycle", () => {
	it("starts, reads, and clears the active run", () => {
		const run = startRun("semantic-search", cwd, undefined, agent);
		expect(readActive(agent)).toMatchObject({ label: "semantic-search", cwd });
		expect(run.startedAt).toBeTruthy();
		clearActive(agent);
		expect(readActive(agent)).toBeUndefined();
	});

	it("finalizes a run by summing the session window", () => {
		const active = startRun("demo", cwd, undefined, agent);
		// Written after the run starts, so the "now" record is inside the window
		// and the 2020 record is outside it.
		writeSession(cwd, "s.jsonl", [
			{
				type: "message",
				timestamp: "2020-01-01T00:00:00.000Z",
				message: { role: "assistant", usage: { cost: { total: 99 } } },
			},
			{
				type: "message",
				timestamp: new Date().toISOString(),
				message: {
					role: "assistant",
					model: "m1",
					usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.5 } },
				},
			},
		]);
		expect(active.startedAt).toBeTruthy();
		expect(readActive(agent)).toBeDefined();
		const result = stopRun(new Date(), agent);
		expect(result?.run.label).toBe("demo");
		expect(result?.run.usage.cost).toBeCloseTo(0.5, 6);
		expect(result?.run.usage.totalTokens).toBe(15);
		expect(result?.records).toBe(1);
		expect(readRuns(agent)).toHaveLength(1);
		expect(readActive(agent)).toBeUndefined();
	});

	it("returns undefined when stopping with no active run", () => {
		expect(stopRun(new Date(), agent)).toBeUndefined();
	});

	it("appends and reads runs, including seeded history", () => {
		const run: RunRecord = {
			label: "x",
			cwd,
			startedAt: "",
			stoppedAt: "",
			usage: { ...zeroUsage(), cost: 1 },
			models: {},
		};
		appendRun(run, agent);
		expect(readRuns(agent)).toHaveLength(1);
		const withHistory = allRunsWithHistory(agent);
		expect(withHistory.length).toBeGreaterThan(1);
		expect(withHistory.some((r) => r.manual)).toBe(true);
	});

	it("reads usage across all sessions for a cwd", () => {
		writeSession(cwd, "a.jsonl", [
			{
				type: "message",
				timestamp: new Date().toISOString(),
				message: { role: "assistant", usage: { cost: { total: 0.1 } } },
			},
		]);
		writeSession(cwd, "b.jsonl", [
			{
				type: "message",
				timestamp: new Date().toISOString(),
				message: { role: "assistant", usage: { cost: { total: 0.2 } } },
			},
		]);
		expect(readUsageForCwd(cwd, agent)).toHaveLength(2);
		expect(costStateDir(agent)).toBe(join(agent, "cost-tracker"));
	});
});

describe("formatting", () => {
	it("formats usd", () => {
		expect(formatUsd(0.0004)).toBe("$0.0004");
		expect(formatUsd(0.417)).toBe("$0.417");
		expect(formatUsd(Number.NaN)).toBe("$0.000");
	});

	it("formats token counts", () => {
		expect(formatTokens(940)).toBe("940");
		expect(formatTokens(12_400)).toBe("12.4k");
		expect(formatTokens(2_100_000)).toBe("2.1M");
	});

	it("formats durations", () => {
		expect(formatDuration(5_000)).toBe("5s");
		expect(formatDuration(65_000)).toBe("1m 5s");
		expect(formatDuration(3_600_000)).toBe("1h 0m");
		expect(formatDuration(-1)).toBe("0s");
	});
});

describe("aggregation and rendering", () => {
	const runs: RunRecord[] = [
		{
			label: "a",
			cwd: "",
			startedAt: "",
			stoppedAt: "",
			usage: { ...zeroUsage(), cost: 1, totalTokens: 1000 },
			models: {},
		},
		{
			label: "a",
			cwd: "",
			startedAt: "",
			stoppedAt: "",
			usage: { ...zeroUsage(), cost: 2, totalTokens: 2000 },
			models: {},
		},
		{
			label: "b",
			cwd: "",
			startedAt: "",
			stoppedAt: "",
			usage: { ...zeroUsage(), cost: 0.5, totalTokens: 500 },
			models: {},
		},
	];

	it("aggregates by label, sorted by cost", () => {
		const totals = aggregateByLabel(runs);
		expect(totals.map((t) => t.label)).toEqual(["a", "b"]);
		expect(totals[0]?.usage.cost).toBe(3);
		expect(totals[0]?.runs).toBe(2);
	});

	it("renders a markdown table with a total row", () => {
		const table = renderCostTable(runs);
		expect(table).toContain("| Extension | Cost | Runs |");
		expect(table).toContain("| a | $3.000 | 2 |");
		expect(table).toContain("| **Total** | **$3.500** | **3** |");
	});
});

describe("cost block upsert", () => {
	it("replaces an existing block idempotently", () => {
		const original = `# Title\n\n<!-- COST:START -->\nold\n<!-- COST:END -->\n\n## Next\n`;
		const once = upsertCostBlock(original, "| a |\n| --- |");
		const twice = upsertCostBlock(once, "| a |\n| --- |");
		expect(twice).toBe(once);
		expect(twice).toContain("| a |");
		expect(twice).not.toContain("old");
		expect(twice.endsWith("## Next\n")).toBe(true);
	});

	it("appends a block when no markers exist", () => {
		const result = upsertCostBlock("# Title\n", "| a |");
		expect(result).toContain("<!-- COST:START -->");
		expect(result).toContain("| a |");
	});
});
