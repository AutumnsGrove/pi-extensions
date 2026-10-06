import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import contextWindow from "./index.ts";
import { BAR_EMPTY } from "./bar.ts";
import {
	emptyLimitConfig,
	getLimit,
	limitConfigPath,
	readLimitConfig,
	setLimit,
	writeLimitConfig,
} from "./config.ts";
import { findVariant, modelsJsonPath, type ModelsJson } from "./variant.ts";
import { readJsonFile } from "./json.ts";

let work: string;
let previousAgentDir: string | undefined;

function baseModel(): Model<any> {
	return {
		id: "deepseek-v4.1-flash",
		name: "DeepSeek V4.1 Flash",
		api: "openai-completions",
		provider: "deepseek",
		baseUrl: "https://api.deepseek.com",
		input: ["text"],
		cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: 65536,
	} as unknown as Model<any>;
}

interface Harness {
	pi: ExtensionAPI;
	ctx: ExtensionCommandContext;
	notifications: Array<{ message: string; kind: string }>;
	setModel: ReturnType<typeof vi.fn>;
	handlers: Map<string, (...args: any[]) => any>;
}

function makeHarness(
	model: Model<any>,
	getModel: (id: string) => Model<any> | undefined,
	onRefresh?: () => void
): Harness {
	const notifications: Array<{ message: string; kind: string }> = [];
	const setModel = vi.fn(async () => true);
	const handlers = new Map<string, (...args: any[]) => any>();

	const registry = {
		find: (_provider: string, id: string) => getModel(id),
		getAll: () => [],
		getError: () => undefined,
		refresh: async () => {
			onRefresh?.();
			return { aborted: false, errors: new Map() };
		},
	};

	const ctx = {
		model,
		modelRegistry: registry,
		getContextUsage: () => ({ tokens: 1000, contextWindow: model.contextWindow, percent: 0.1 }),
		sessionManager: {
			buildSessionProjection: () => ({
				messages: [],
				entries: [],
				thinkingLevel: "medium",
				model: null,
			}),
		},
		ui: {
			notify: (message: string, kind: string) => notifications.push({ message, kind }),
		},
	} as unknown as ExtensionCommandContext;

	const pi = {
		registerCommand: (name: string, options: { handler: (...args: any[]) => any }) => {
			handlers.set(`command:${name}`, options.handler);
		},
		on: (event: string, handler: (...args: any[]) => any) => {
			handlers.set(`event:${event}`, handler);
		},
		getSettings: () => ({}),
		setModel,
	} as unknown as ExtensionAPI;

	return { pi, ctx, notifications, setModel, handlers };
}

beforeEach(() => {
	work = mkdtempSync(join(tmpdir(), "context-window-cmd-"));
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = work;
});

afterEach(() => {
	if (previousAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
	rmSync(work, { recursive: true, force: true });
});

describe("/context command", () => {
	it("shows the panel with no configuration", async () => {
		const base = baseModel();
		const harness = makeHarness(base, (id) => (id === base.id ? base : undefined));
		contextWindow(harness.pi);

		await harness.handlers.get("command:context")!("", harness.ctx);
		expect(harness.notifications.at(-1)?.message).toContain("Context usage");
		expect(harness.notifications.at(-1)?.message).toContain("No custom limit");
		expect(harness.notifications.at(-1)?.message).toContain(BAR_EMPTY);
	});

	it("validates the requested size", async () => {
		const base = baseModel();
		const harness = makeHarness(base, (id) => (id === base.id ? base : undefined));
		contextWindow(harness.pi);
		const command = harness.handlers.get("command:context")!;

		await command("set nope", harness.ctx);
		expect(harness.notifications.at(-1)?.kind).toBe("warning");

		await command("set 2000000", harness.ctx);
		expect(harness.notifications.at(-1)?.message).toContain("below the native window");

		await command("set 10k", harness.ctx);
		expect(harness.notifications.at(-1)?.message).toContain("floor");
	});

	it("derives a model and persists the limit, then resets", async () => {
		const base = baseModel();
		const variant: Model<any> = {
			...base,
			id: "deepseek-v4.1-flash-400k",
			contextWindow: 400000,
		} as Model<any>;
		let refreshed = false;
		const harness = makeHarness(
			base,
			(id) => {
				if (id === base.id) return base;
				if (id === variant.id && refreshed) return variant;
				return undefined;
			},
			() => {
				refreshed = true;
			}
		);
		contextWindow(harness.pi);
		const command = harness.handlers.get("command:context")!;

		await command("set 400k", harness.ctx);
		expect(harness.setModel).toHaveBeenCalledWith(variant);
		expect(harness.notifications.at(-1)?.message).toContain("capped at 400k");

		const models = readJsonFile<ModelsJson>(modelsJsonPath())!;
		expect(findVariant(models, "deepseek", "deepseek-v4.1-flash-400k")?.contextWindow).toBe(400000);
		expect(getLimit(readLimitConfig(), "deepseek", "deepseek-v4.1-flash")?.limit).toBe(400000);

		await command("list", harness.ctx);
		expect(harness.notifications.at(-1)?.message).toContain("deepseek-v4.1-flash-400k");

		const resetCtx = { ...harness.ctx, model: variant } as unknown as ExtensionCommandContext;
		await command("reset", resetCtx);
		expect(harness.setModel).toHaveBeenLastCalledWith(base);
		expect(readLimitConfig().models).toEqual({});
		expect(existsSync(limitConfigPath())).toBe(true);
		expect(findVariant(readJsonFile<ModelsJson>(modelsJsonPath())!, "deepseek", variant.id)).toBeUndefined();
	});

	it("re-applies a configured limit on session start", async () => {		const base = baseModel();
		const variant: Model<any> = {
			...base,
			id: "deepseek-v4.1-flash-400k",
			contextWindow: 400000,
		} as Model<any>;
		const harness = makeHarness(base, (id) => {
			if (id === base.id) return base;
			if (id === variant.id) return variant;
			return undefined;
		});
		contextWindow(harness.pi);

		writeLimitConfig(
			setLimit(emptyLimitConfig(), "deepseek", {
				baseId: base.id,
				limit: 400000,
				variantId: variant.id,
			})
		);

		await harness.handlers.get("event:session_start")!({ type: "session_start" }, harness.ctx);
		expect(harness.setModel).toHaveBeenCalledWith(variant);
	});

	it("rewrites derived model ids back to the base slug for provider requests", async () => {
		const base = baseModel();
		const variantId = "deepseek-v4.1-flash-400k";
		writeLimitConfig(
			setLimit(emptyLimitConfig(), "deepseek", { baseId: base.id, limit: 400000, variantId })
		);
		const variant = { ...base, id: variantId, contextWindow: 400000 } as Model<any>;
		const harness = makeHarness(variant, () => variant);
		contextWindow(harness.pi);
		const handler = harness.handlers.get("event:before_provider_request")!;

		// The derived id is rewritten to the real base slug...
		expect(
			await handler(
				{ type: "before_provider_request", payload: { model: variantId, messages: [] } },
				harness.ctx
			)
		).toEqual({ model: base.id, messages: [] });

		// ...and unrelated models are left alone.
		const other = { ...harness.ctx, model: base } as unknown as ExtensionCommandContext;
		expect(
			await handler({ type: "before_provider_request", payload: { model: base.id } }, other)
		).toBeUndefined();
	});

	it("falls back to a session override when the registry will not reload models.json", async () => {
		const base = baseModel();
		// The registry never exposes the derived model, even after refresh.
		const harness = makeHarness(base, (id) => (id === base.id ? base : undefined));
		contextWindow(harness.pi);
		const command = harness.handlers.get("command:context")!;

		await command("set 400k", harness.ctx);

		const applied = harness.setModel.mock.calls.at(-1)?.[0] as Model<any>;
		expect(applied.id).toBe("deepseek-v4.1-flash-400k");
		expect(applied.contextWindow).toBe(400000);
		expect(harness.notifications.at(-1)?.kind).toBe("warning");
		expect(harness.notifications.at(-1)?.message).toContain("session override");

		// The limit is still persisted for the next startup.
		expect(getLimit(readLimitConfig(), "deepseek", "deepseek-v4.1-flash")?.limit).toBe(400000);
		expect(
			findVariant(readJsonFile<ModelsJson>(modelsJsonPath())!, "deepseek", "deepseek-v4.1-flash-400k")
				?.contextWindow
		).toBe(400000);
	});
});
