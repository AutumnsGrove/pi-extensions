import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import parallelExtension from "./index.ts";
import { monthKey } from "./quota.ts";

interface MockTool {
	name: string;
	execute: (
		id: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: unknown
	) => Promise<unknown>;
}

interface MockPi {
	pi: ExtensionAPI;
	tools: Map<string, MockTool>;
	commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
	providers: unknown[];
	handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
}

const createMockPi = (): MockPi => {
	const tools = new Map<string, MockTool>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const providers: unknown[] = [];
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			handlers.set(event, handler);
			return () => {};
		},
		registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.set(name, options);
		},
		registerTool(tool: MockTool) {
			tools.set(tool.name, tool);
		},
		registerProvider(provider: unknown) {
			providers.push(provider);
		},
		registerShortcut() {},
	};
	return { pi: pi as unknown as ExtensionAPI, tools, commands, providers, handlers };
};

const toolContext = () => ({
	model: null,
	modelRegistry: { getApiKeyForProvider: async () => "fake-key" },
	ui: { setStatus: vi.fn(), notify: vi.fn() },
});

const writeLedger = (agentDir: string, queries: number, usd = queries * 0.001): void => {
	const dir = join(agentDir, "parallel");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "quota.json"),
		JSON.stringify({
			version: 1,
			month: monthKey(),
			queries,
			usd,
			searchRequests: 0,
			extractUrls: 0,
			updatedAt: new Date().toISOString(),
		}),
		"utf-8"
	);
};

let agentDir: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "parallel-index-"));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	if (previousAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
	rmSync(agentDir, { recursive: true, force: true });
});

describe("parallel extension wiring", () => {
	it("registers the provider, commands, and tools", () => {
		const { pi, tools, commands, providers } = createMockPi();
		parallelExtension(pi);
		expect(providers).toHaveLength(1);
		expect((providers[0] as { id: string }).id).toBe("parallel");
		expect([...commands.keys()].sort()).toEqual([
			"parallel",
			"parallel-login",
			"parallel-logout",
			"parallel-reset-quota",
		]);
		expect([...tools.keys()].sort()).toEqual(["web_fetch", "web_search"]);
	});

	it("sets the quota status on session_start", () => {
		const { pi, handlers } = createMockPi();
		parallelExtension(pi);
		const ctx = toolContext();
		handlers.get("session_start")?.({}, ctx);
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("parallel", expect.stringContaining("/4,000"));
	});
});

describe("local hard cap", () => {
	it("web_search refuses before any network call when the request ceiling is reached", async () => {
		writeLedger(agentDir, 4_000);
		const { pi, tools } = createMockPi();
		parallelExtension(pi);
		const tool = tools.get("web_search");
		expect(tool).toBeDefined();
		await expect(
			tool!.execute("id", { objective: "q", search_queries: ["a"] }, undefined, undefined, toolContext())
		).rejects.toThrow(/request ceiling/);
	});

	it("web_fetch counts one query per URL and refuses when it would cross the ceiling", async () => {
		writeLedger(agentDir, 3_999);
		const { pi, tools } = createMockPi();
		parallelExtension(pi);
		const tool = tools.get("web_fetch");
		expect(tool).toBeDefined();
		await expect(
			tool!.execute(
				"id",
				{ urls: ["https://example.com/a", "https://example.com/b"] },
				undefined,
				undefined,
				toolContext()
			)
		).rejects.toThrow(/request ceiling/);
	});
});
