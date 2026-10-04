import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSemanticSearchExtension } from "../index.ts";
import type { SearchManager } from "../src/manager.ts";

interface FakeCtx {
	cwd: string;
	ui: {
		notify: (message: string, level?: string) => void;
		setStatus: (key: string, value: string | undefined) => void;
	};
	notifications: string[];
	statuses: Array<string | undefined>;
}

function fakeCtx(cwd = "/project"): FakeCtx {
	const notifications: string[] = [];
	const statuses: Array<string | undefined> = [];
	return {
		cwd,
		ui: {
			notify: (message) => notifications.push(message),
			setStatus: (_key, value) => statuses.push(value),
		},
		notifications,
		statuses,
	};
}

function setup() {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const pi = {
		on: (event: string, handler: (event: any, ctx: any) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		registerTool: (definition: any) => tools.set(definition.name, definition),
		registerCommand: (name: string, options: any) => commands.set(name, options),
	} as unknown as ExtensionAPI;

	let forcedReindex = false;
	const store = { stats: () => ({ totalFiles: 3, totalChunks: 10 }) };
	const indexer = {
		ensureFresh: async () => ({ reindexed: false, stats: { indexedFiles: 0 } }),
		index: async (force: boolean) => {
			forcedReindex = force;
			return { indexedFiles: 3, chunksCreated: 10 };
		},
		isFresh: async () => true,
		status: () => ({
			totalFiles: 3,
			totalChunks: 10,
			embeddingModel: "keyword",
			lastIndexedAt: "2026-01-01T00:00:00Z",
			lastIndexError: "",
		}),
	};
	const manager: SearchManager = {
		config: {
			backend: "ollama",
			model: "m",
			dimensions: 2,
			baseUrl: "http://localhost:11434",
			maxChunkTokens: 512,
			vectorStorage: "float32",
		},
		ensure: async () => ({ store: store as never, indexer: indexer as never }),
		search: async (_dir, request) => ({
			output: {
				results: [
					{
						filePath: "src/a.ts",
						symbol: "alpha",
						kind: "function",
						startLine: 1,
						endLine: 2,
						score: 0.9,
					},
				],
				reindexed: false,
			},
			text: `Found 1 results for ${request.query}`,
		}),
		close: () => {},
	};

	const extension = createSemanticSearchExtension(() => manager);
	extension(pi);
	return {
		tools,
		commands,
		handlers,
		get forcedReindex() {
			return forcedReindex;
		},
	};
}

describe("semantic-search extension", () => {
	it("registers tools, commands, and lifecycle handlers", () => {
		const { tools, commands, handlers } = setup();
		expect([...tools.keys()].sort()).toEqual(["index_status", "semantic_search"]);
		expect(commands.has("semsearch")).toBe(true);
		expect(handlers.has("session_start")).toBe(true);
		expect(handlers.has("session_shutdown")).toBe(true);
	});

	it("advertises strong usage guidance on semantic_search", () => {
		const { tools } = setup();
		const tool = tools.get("semantic_search");
		expect(tool.promptGuidelines.join(" ")).toMatch(/semantic_search first/);
		expect(tool.annotations).toEqual({ readOnlyHint: true });
	});

	it("executes semantic_search and returns text plus details", async () => {
		const { tools } = setup();
		const result = await tools
			.get("semantic_search")
			.execute("id", { query: "alpha" }, undefined, undefined, fakeCtx());
		expect(result.content[0].text).toContain("Found 1 results for alpha");
		expect(result.details.resultCount).toBe(1);
		expect(result.details.results[0].filePath).toBe("src/a.ts");
	});

	it("executes index_status", async () => {
		const { tools } = setup();
		const result = await tools
			.get("index_status")
			.execute("id", {}, undefined, undefined, fakeCtx());
		expect(result.content[0].text).toContain("Indexed chunks: 10");
		expect(result.details.stale).toBe(false);
	});

	it("reports status and forces reindex via /semsearch", async () => {
		const harness = setup();
		const ctx = fakeCtx();
		await harness.commands.get("semsearch").handler("status", ctx);
		expect(ctx.notifications.at(-1)).toContain("3 files, 10 chunks");

		await harness.commands.get("semsearch").handler("reindex", ctx);
		expect(harness.forcedReindex).toBe(true);
		expect(ctx.notifications.at(-1)).toContain("Re-indexed 3 files");
	});

	it("does not register grep interception by default", () => {
		const { handlers } = setup();
		expect(handlers.has("tool_call")).toBe(false);
	});
});
