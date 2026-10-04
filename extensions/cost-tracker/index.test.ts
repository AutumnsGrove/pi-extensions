import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import costTracker, { exportCostTable, hasCostMarkers } from "./index.ts";
import { readActive, readRuns, sessionDirForCwd } from "./ledger.ts";

let work: string;
let agent: string;
let cwd: string;
let previousAgentDir: string | undefined;

interface Notify {
	message: string;
	level?: string;
}

interface FakeCtx {
	cwd: string;
	ui: {
		setStatus: (key: string, text: string | undefined) => void;
		notify: (message: string, level?: string) => void;
	};
	sessionManager: { getSessionFile: () => string | undefined };
}

interface Harness {
	commands: Map<string, { handler: (args: string, ctx: FakeCtx) => Promise<void> }>;
	handlers: Map<string, Array<(event: unknown, ctx: FakeCtx) => unknown>>;
	notifications: Notify[];
	ctx: FakeCtx;
}

function setup(): Harness {
	const commands = new Map();
	const handlers = new Map();
	const notifications: Notify[] = [];
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: FakeCtx) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		registerCommand: (name: string, options: { handler: (args: string, ctx: FakeCtx) => Promise<void> }) => {
			commands.set(name, options);
		},
	} as unknown as ExtensionAPI;
	const ctx: FakeCtx = {
		cwd,
		ui: {
			setStatus: () => {},
			notify: (message: string, level?: string) => notifications.push({ message, level }),
		},
		sessionManager: { getSessionFile: () => undefined },
	};
	costTracker(pi);
	return { commands, handlers, notifications, ctx };
}

function writeInWindowUsage(cwdPath: string): void {
	const dir = sessionDirForCwd(cwdPath, agent);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "manual.jsonl"),
		`${JSON.stringify({
			type: "message",
			timestamp: new Date().toISOString(),
			message: {
				role: "assistant",
				model: "test-model",
				usage: { input: 100, output: 50, totalTokens: 150, cost: { total: 0.25 } },
			},
		})}\n`,
		"utf8"
	);
}

beforeEach(() => {
	work = mkdtempSync(join(tmpdir(), "cost-ext-"));
	agent = join(work, "agent");
	cwd = join(work, "project");
	mkdirSync(cwd, { recursive: true });
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agent;
});

afterEach(() => {
	if (previousAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
	rmSync(work, { recursive: true, force: true });
});

describe("/cost command", () => {
	it("writes an active run on start", async () => {
		const { commands, ctx } = setup();
		await commands.get("cost")?.handler("start semantic-search", ctx);
		expect(readActive(agent)).toMatchObject({
			label: "semantic-search",
			cwd,
		});
	});

	it("defaults the label to the directory name", async () => {
		const { commands, ctx } = setup();
		await commands.get("cost")?.handler("start", ctx);
		expect(readActive(agent)?.label).toBe("project");
	});

	it("finalizes, exports, and clears on stop", async () => {
		writeFileSync(
			join(cwd, "README.md"),
			"# Project\n\n## Development cost\n\n<!-- COST:START -->\n<!-- COST:END -->\n",
			"utf8"
		);
		const { commands, ctx } = setup();
		await commands.get("cost")?.handler("start demo", ctx);
		writeInWindowUsage(cwd);
		await commands.get("cost")?.handler("stop", ctx);

		expect(readActive(agent)).toBeUndefined();
		const runs = readRuns(agent);
		expect(runs).toHaveLength(1);
		expect(runs[0]?.usage.cost).toBeCloseTo(0.25, 6);

		const readme = readFileSync(join(cwd, "README.md"), "utf8");
		expect(readme).toContain("| demo |");
	});

	it("notifies when stopping without an active run", async () => {
		const { commands, notifications, ctx } = setup();
		await commands.get("cost")?.handler("stop", ctx);
		expect(notifications.at(-1)?.level).toBe("warning");
	});

	it("prints usage for an unknown subcommand", async () => {
		const { commands, notifications, ctx } = setup();
		await commands.get("cost")?.handler("bogus", ctx);
		expect(notifications.at(-1)?.message).toContain("Usage:");
	});
});

describe("live accumulation", () => {
	it("adds assistant usage only while a run is active", async () => {
		const { commands, handlers, ctx } = setup();
		const statuses: Array<string | undefined> = [];
		ctx.ui.setStatus = (_key, text) => statuses.push(text);
		const messageEnd = handlers.get("message_end") ?? [];

		// No active run: nothing happens.
		for (const handler of messageEnd) {
			await handler(
				{ type: "message_end", message: { role: "assistant", usage: { cost: { total: 1 } } } },
				ctx
			);
		}
		expect(statuses).toHaveLength(0);

		await commands.get("cost")?.handler("start live", ctx);
		for (const handler of messageEnd) {
			await handler(
				{
					type: "message_end",
					message: {
						role: "assistant",
						usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.01 } },
					},
				},
				ctx
			);
		}
		expect(statuses.some((text) => text?.includes("0.010"))).toBe(true);
	});
});

describe("export helpers", () => {
	it("detects and writes the cost block", () => {
		writeFileSync(
			join(cwd, "README.md"),
			"# T\n\n<!-- COST:START -->\n<!-- COST:END -->\n",
			"utf8"
		);
		expect(hasCostMarkers(cwd)).toBe(true);
		const path = exportCostTable(cwd);
		expect(path).toBe(join(cwd, "README.md"));
		expect(readFileSync(path ?? "", "utf8")).toContain("| **Total** |");
	});

	it("returns undefined without a README", () => {
		expect(exportCostTable(join(cwd, "missing"))).toBeUndefined();
		expect(hasCostMarkers(join(cwd, "missing"))).toBe(false);
	});

	it("writes a run ledger file under the agent dir", async () => {
		const { commands, ctx } = setup();
		await commands.get("cost")?.handler("start x", ctx);
		writeInWindowUsage(cwd);
		await commands.get("cost")?.handler("stop", ctx);
		expect(existsSync(join(agent, "cost-tracker", "runs.json"))).toBe(true);
	});
});
