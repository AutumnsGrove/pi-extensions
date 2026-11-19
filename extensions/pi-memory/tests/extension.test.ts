import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createMemoryExtension,
	flushMemoryWork,
	INDEX_POINTER_TYPE,
	SAVE_NOTICE_TYPE,
} from "../extension.ts";
import { RECALL_CUSTOM_TYPE } from "../recall.ts";
import { MemoryStore } from "../store.ts";

const dirs: string[] = [];
const envKeys = [
	"PI_MEMORY_DIR",
	"PI_MEMORY_CONFIG",
	"PI_CODING_AGENT_DIR",
	"PI_MEMORY_DISABLED",
	"PI_MEMORY_SCOPE",
	"PI_MEMORY_STORE",
	"PI_MEMORY_MODEL",
	"PI_MEMORY_AUTO_DREAM",
	"PI_MEMORY_EXTRACT_EVERY",
	"HOME",
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const key of envKeys) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	for (const key of envKeys) {
		const value = savedEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

const tmp = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "pi-memory-ext-"));
	dirs.push(dir);
	return dir;
};

interface Harness {
	pi: ExtensionAPI;
	tools: Map<string, any>;
	commands: Map<string, any>;
	handlers: Map<string, Array<(event: any, ctx: any) => unknown>>;
	sent: Array<{ message: any; options?: any }>;
	prompts: string[];
	ctx: any;
	store: MemoryStore;
	sessionId: string;
	sessionDir: string;
}

interface HarnessOptions {
	cwd?: string;
	storeDir?: string;
	reply?: () => string;
	entries?: any[];
	header?: { parentSession?: string } | null;
	hasUI?: boolean;
	mode?: string;
	config?: Record<string, unknown>;
	sessionDir?: string;
	completeDelayMs?: number;
}

function setup(options: HarnessOptions = {}): Harness {
	const cwd = options.cwd ?? tmp();
	const storeDir = options.storeDir ?? tmp();
	process.env.PI_MEMORY_DIR = storeDir;
	process.env.PI_CODING_AGENT_DIR = join(tmp(), "agent");
	process.env.PI_MEMORY_CONFIG = join(tmp(), "memory.json");
	if (options.config) {
		writeFileSync(process.env.PI_MEMORY_CONFIG, JSON.stringify(options.config));
	}
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const sent: Array<{ message: any; options?: any }> = [];
	const prompts: string[] = [];
	const pi = {
		on: (event: string, handler: (event: any, ctx: any) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		registerTool: (definition: any) => tools.set(definition.name, definition),
		registerCommand: (name: string, definition: any) => commands.set(name, definition),
		registerMessageRenderer: () => {},
		sendMessage: (message: any, opts?: any) => sent.push({ message, options: opts }),
	} as unknown as ExtensionAPI;

	const sessionId = `session-${Math.random().toString(36).slice(2)}`;
	const sessionDir = options.sessionDir ?? tmp();
	const notifications: string[] = [];
	const statuses: Array<string | undefined> = [];
	const reply = options.reply ?? (() => '{"memories":[]}');
	const model = { provider: "test", id: "model", contextWindow: 100_000 };
	const ctx = {
		cwd,
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		isIdle: () => true,
		isProjectTrusted: () => true,
		model,
		thinkingLevel: "medium",
		scopedModels: [],
		signal: undefined,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionDir: () => sessionDir,
			getHeader: () => options.header ?? null,
			getBranch: () => options.entries ?? [],
			getCwd: () => cwd,
			getEntries: () => options.entries ?? [],
		},
		modelRegistry: {
			complete: async (_model: any, context: any) => {
				prompts.push(context.messages?.[0]?.content ?? "");
				if (options.completeDelayMs) {
					await new Promise((resolve) => setTimeout(resolve, options.completeDelayMs));
				}
				const text = reply();
				return {
					content: [{ type: "text", text }],
					usage: { cost: { total: 0.002 } },
				};
			},
			find: () => undefined,
			getAll: () => [model],
		},
		ui: {
			notify: (message: string) => notifications.push(message),
			setStatus: (_key: string, value: string | undefined) => statuses.push(value),
			theme: { fg: (_color: string, text: string) => text },
		},
		notifications,
		statuses,
	} as any;

	createMemoryExtension(pi);
	return {
		pi,
		tools,
		commands,
		handlers,
		sent,
		prompts,
		ctx,
		store: currentStore(storeDir),
		sessionId,
		sessionDir,
	};
}

/** The extension creates its own store; this mirrors the same directory. */
function currentStore(dir: string): MemoryStore {
	return new MemoryStore(dir);
}

async function emit(harness: Harness, event: string, payload: any): Promise<any> {
	const handlers = harness.handlers.get(event) ?? [];
	let result: any;
	for (const handler of handlers) {
		const next = await handler(payload, harness.ctx);
		if (next !== undefined) result = next;
	}
	return result;
}

function seed(store: MemoryStore, name: string, body: string, type: "feedback" | "project" = "feedback") {
	return store.save({
		name,
		description: `${name} description`,
		type,
		body,
	});
}

describe("registration", () => {
	it("registers the four tools and the command", () => {
		const h = setup();
		expect([...h.tools.keys()].sort()).toEqual([
			"memory_forget",
			"memory_read",
			"memory_save",
			"memory_search",
		]);
		expect(h.commands.has("memory")).toBe(true);
	});
});

describe("prompt section and recall", () => {
	it("adds the index to the system prompt", async () => {
		const h = setup();
		seed(h.store, "Use pnpm", "Use pnpm for installs.");
		const result = await emit(h, "before_agent_start", {
			messageType: "user",
			prompt: "What package manager?",
			systemPromptOptions: { sections: {} },
		});
		expect(result).toBeUndefined();
		// The section is mutated in place.
		const options = (await captureSection(h)) as any;
		expect(options.sections["pi-memory"]).toContain("Use pnpm");
		expect(options.sections["pi-memory"]).toContain("feedback_use_pnpm.md");
	});

	it("injects a matching body once and skips it next time", async () => {
		const h = setup();
		seed(h.store, "Use pnpm", "Use pnpm for installs and workspace scripts.");
		const first = await emit(h, "before_agent_start", {
			messageType: "user",
			prompt: "install the dependencies with pnpm",
			systemPromptOptions: { sections: {} },
		});
		expect(first?.message).toMatchObject({
			customType: RECALL_CUSTOM_TYPE,
			display: false,
		});
		expect(first.message.content).toContain("Use pnpm for installs");

		const second = await emit(h, "before_agent_start", {
			messageType: "user",
			prompt: "install the dependencies with pnpm",
			systemPromptOptions: { sections: {} },
		});
		expect(second).toBeUndefined();
	});

	it("does not recall for a custom-message run or for a child session", async () => {
		const h = setup({ header: { parentSession: "/tmp/parent.jsonl" } });
		seed(h.store, "Use pnpm", "Use pnpm for installs.");
		const result = await emit(h, "before_agent_start", {
			messageType: "user",
			prompt: "pnpm",
			systemPromptOptions: { sections: {} },
		});
		expect(result).toBeUndefined();
	});
});

async function captureSection(h: Harness): Promise<any> {
	const options: any = { sections: {} };
	await emit(h, "before_agent_start", {
		messageType: "user",
		prompt: "",
		systemPromptOptions: options,
	});
	return options;
}

describe("tools", () => {
	it("saves, reads, searches, and forgets", async () => {
		const h = setup();
		const save = h.tools.get("memory_save");
		const saved = await save.execute(
			"call",
			{
				name: "Use pnpm",
				description: "Package manager preference",
				type: "feedback",
				body: "Use pnpm for installs.",
				why: "The lockfile.",
				how_to_apply: "Run pnpm.",
			},
			undefined,
			undefined,
			h.ctx
		);
		expect(saved.isError).toBeUndefined();
		expect(saved.details.file).toBe("feedback_use_pnpm.md");
		expect(readFileSync(join(h.store.dir, "feedback_use_pnpm.md"), "utf8")).toContain(
			"**Why:** The lockfile."
		);
		expect(h.sent.some((entry) => entry.message.customType === INDEX_POINTER_TYPE)).toBe(
			true
		);

		const read = await h.tools.get("memory_read").execute("call", { id: "Use pnpm" }, undefined, undefined, h.ctx);
		expect(read.content[0].text).toContain("Use pnpm for installs.");

		const search = await h.tools
			.get("memory_search")
			.execute("call", { query: "lockfile", mode: "keyword" }, undefined, undefined, h.ctx);
		expect(search.content[0].text).toContain("Use pnpm");

		const forget = await h.tools
			.get("memory_forget")
			.execute("call", { id: "Use pnpm" }, undefined, undefined, h.ctx);
		expect(forget.content[0].text).toContain("Removed");
		expect(h.store.files()).toHaveLength(0);
	});

	it("updates a memory with the same title instead of duplicating", async () => {
		const h = setup();
		const save = h.tools.get("memory_save");
		const args = {
			name: "Use pnpm",
			description: "Package manager",
			type: "feedback",
			body: "Use pnpm.",
		};
		await save.execute("call", args, undefined, undefined, h.ctx);
		const second = await save.execute("call", { ...args, body: "Always pnpm." }, undefined, undefined, h.ctx);
		expect(second.details.created).toBe(false);
		expect(h.store.files()).toHaveLength(1);
	});

	it("refuses a secret through the tool", async () => {
		const h = setup();
		const result = await h.tools.get("memory_save").execute(
			"call",
			{
				name: "Deploy",
				description: "Deploy notes",
				type: "project",
				body: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
			},
			undefined,
			undefined,
			h.ctx
		);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("GitHub token");
		expect(h.store.files()).toHaveLength(0);
	});
});

describe("extraction", () => {
	const entries = [
		{
			id: "a",
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "Use pnpm, not npm." }] },
		},
		{
			id: "b",
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: "Got it." }] },
		},
	];

	it("saves a memory after the configured number of settled runs", async () => {
		const h = setup({
			entries,
			config: { extraction: { every: 1, minMessages: 1 } },
			reply: () =>
				JSON.stringify({
					memories: [
						{
							name: "Use pnpm",
							description: "Package manager preference",
							type: "feedback",
							body: "Use pnpm for installs.",
							why: "The lockfile.",
							howToApply: "Run pnpm.",
						},
					],
				}),
		});
		await emit(h, "agent_settled", { aborted: false });
		await flushMemoryWork();
		expect(h.store.files()).toHaveLength(1);
		expect(h.store.readIndex()).toContain("Use pnpm");
		expect(h.sent.some((entry) => entry.message.customType === SAVE_NOTICE_TYPE)).toBe(true);
		const saved = h.store.readState();
		expect(saved.sessions[h.sessionId]?.cursor).toBe("b");
		expect(saved.lastExtractCount).toBe(1);
	});

	it("returns from agent_settled without waiting for the model", async () => {
		const h = setup({
			entries,
			config: { extraction: { every: 1, minMessages: 1 } },
			reply: () =>
				JSON.stringify({
					memories: [
						{
							name: "Use pnpm",
							description: "Package manager",
							type: "feedback",
							body: "Use pnpm for installs.",
						},
					],
				}),
			completeDelayMs: 250,
		});
		const started = Date.now();
		await emit(h, "agent_settled", { aborted: false });
		expect(Date.now() - started).toBeLessThan(200);
		await flushMemoryWork();
		expect(h.store.files()).toHaveLength(1);
	});

	it("retries after a failed extraction instead of giving up for the session", async () => {
		let calls = 0;
		const h = setup({
			entries,
			config: { extraction: { every: 1, minMessages: 1 } },
			reply: () => {
				calls++;
				if (calls === 1) return "I could not find anything.";
				return JSON.stringify({
					memories: [
						{
							name: "Use pnpm",
							description: "Package manager",
							type: "feedback",
							body: "Use pnpm for installs.",
						},
					],
				});
			},
		});
		await emit(h, "agent_settled", { aborted: false });
		await flushMemoryWork();
		expect(h.store.files()).toHaveLength(0);
		expect(h.store.readState().lastError).toContain("extraction failed");
		await emit(h, "agent_settled", { aborted: false });
		await flushMemoryWork();
		expect(calls).toBe(2);
		expect(h.store.files()).toHaveLength(1);
		expect(h.store.readState().lastError).toBeUndefined();
	});

	it("shows AGENTS.md to the extractor so it does not restate it", async () => {
		const cwd = tmp();
		writeFileSync(join(cwd, "AGENTS.md"), "Always use pnpm.\n");
		const h = setup({
			cwd,
			entries,
			config: { extraction: { every: 1, minMessages: 1 } },
			reply: () => '{"memories":[]}',
		});
		await emit(h, "agent_settled", { aborted: false });
		await flushMemoryWork();
		expect(h.prompts[0]).toContain("Always use pnpm.");
		expect(h.prompts[0]).toContain("never duplicate these");
	});

	it("does not advance the cursor when the model returns junk", async () => {
		const h = setup({
			entries,
			config: { extraction: { every: 1, minMessages: 1 } },
			reply: () => "I could not find anything.",
		});
		await emit(h, "agent_settled", { aborted: false });
		await flushMemoryWork();
		expect(h.store.readState().sessions[h.sessionId]?.cursor).toBeUndefined();
		expect(h.store.readState().lastError).toContain("extraction failed");
	});

	it("is skipped when the main agent already saved this run", async () => {
		let calls = 0;
		const h = setup({
			entries,
			config: { extraction: { every: 1, minMessages: 1 } },
			reply: () => {
				calls++;
				return '{"memories":[]}';
			},
		});
		await h.tools.get("memory_save").execute(
			"call",
			{ name: "Use pnpm", description: "d", type: "feedback", body: "Use pnpm." },
			undefined,
			undefined,
			h.ctx
		);
		await emit(h, "agent_start", {});
		await h.tools.get("memory_save").execute(
			"call",
			{ name: "Use pnpm", description: "d", type: "feedback", body: "Still pnpm." },
			undefined,
			undefined,
			h.ctx
		);
		await emit(h, "agent_settled", { aborted: false });
		await flushMemoryWork();
		expect(calls).toBe(0);
	});

	it("is skipped on abort, without UI, and in a child session", async () => {
		for (const variant of [
			{ aborted: true },
			{ hasUI: false },
			{ header: { parentSession: "/tmp/parent.jsonl" } },
		]) {
			let calls = 0;
			const h = setup({
				...variant,
				entries,
				config: { extraction: { every: 1, minMessages: 1 } },
				reply: () => {
					calls++;
					return '{"memories":[]}';
				},
			});
			await emit(h, "agent_settled", { aborted: !!variant.aborted });
			expect(calls).toBe(0);
		}
	});
});

describe("/memory", () => {
	it("shows status, lists, pauses, and resumes", async () => {
		const h = setup();
		seed(h.store, "Use pnpm", "Use pnpm.");
		const command = h.commands.get("memory");
		await command.handler("status", h.ctx);
		expect(h.ctx.notifications.at(-1)).toContain("Store");
		expect(h.ctx.notifications.at(-1)).toContain("Files     1");

		await command.handler("list", h.ctx);
		expect(h.ctx.notifications.at(-1)).toContain("Use pnpm");

		await command.handler("off", h.ctx);
		const recalled = await emit(h, "before_agent_start", {
			messageType: "user",
			prompt: "pnpm",
			systemPromptOptions: { sections: {} },
		});
		expect(recalled).toBeUndefined();

		await command.handler("on", h.ctx);
		const after = await emit(h, "before_agent_start", {
			messageType: "user",
			prompt: "pnpm install",
			systemPromptOptions: { sections: {} },
		});
		expect(after?.message.customType).toBe(RECALL_CUSTOM_TYPE);
	});

	it("consolidates with /memory dream", async () => {
		const h = setup({
			reply: () =>
				JSON.stringify({
					writes: [
						{
							name: "Tooling",
							description: "Package manager and scripts",
							type: "feedback",
							body: "Use pnpm for everything.",
						},
					],
					deletes: ["feedback_old.md"],
				}),
		});
		seed(h.store, "Old", "Use npm.");
		await h.commands.get("memory").handler("dream", h.ctx);
		expect(h.store.find("Tooling")).toBeDefined();
		expect(h.store.find("feedback_old.md")).toBeUndefined();
		expect(h.ctx.notifications.at(-1)).toContain("written");
	});

	it("imports from Claude Code's store", async () => {
		const home = tmp();
		process.env.HOME = home;
		const cwd = tmp();
		const slug = cwd.replace(/[/\\:]/g, "-");
		const source = join(home, ".claude", "projects", slug, "memory");
		mkdirSync(source, { recursive: true });
		writeFileSync(
			join(source, "feedback_pnpm.md"),
			"---\nname: Use pnpm\ndescription: Package manager\ntype: feedback\n---\n\nUse pnpm for installs.\n"
		);
		const h = setup({ cwd });
		await h.commands.get("memory").handler("import", h.ctx);
		expect(h.ctx.notifications.at(-1)).toContain("1 imported");
		expect(h.store.files()).toHaveLength(1);
	});

	it("previews an import without writing", async () => {
		const home = tmp();
		process.env.HOME = home;
		const cwd = tmp();
		const slug = cwd.replace(/[/\\:]/g, "-");
		const source = join(home, ".claude", "projects", slug, "memory");
		mkdirSync(source, { recursive: true });
		writeFileSync(
			join(source, "feedback_pnpm.md"),
			"---\nname: Use pnpm\ndescription: Package manager\ntype: feedback\n---\n\nUse pnpm.\n"
		);
		const h = setup({ cwd });
		await h.commands.get("memory").handler("import --dry-run", h.ctx);
		expect(h.ctx.notifications.at(-1)).toContain("1 to import");
		expect(h.store.files()).toHaveLength(0);
	});

	it("refuses an ambiguous forget", async () => {
		const h = setup();
		seed(h.store, "Use pnpm for tools", "Use pnpm.");
		seed(h.store, "Use pnpm for tests", "Use pnpm for tests.");
		const result = await h.tools
			.get("memory_forget")
			.execute("call", { id: "pnpm" }, undefined, undefined, h.ctx);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("ambiguous");
		expect(h.store.files()).toHaveLength(2);
	});

	it("reports recall overhead over saved sessions", async () => {
		const h = setup();
		seed(h.store, "Use pnpm", "Use pnpm for installs.");
		const line = (id: string, text: string) =>
			JSON.stringify({
				id,
				type: "message",
				message: { role: "user", content: [{ type: "text", text }] },
			});
		writeFileSync(
			join(h.sessionDir, "s1.jsonl"),
			[line("1", "pnpm install"), line("2", "unrelated question")].join("\n")
		);
		await h.commands.get("memory").handler("eval", h.ctx);
		const message = h.ctx.notifications.at(-1) as string;
		expect(message).toContain("sessions");
		expect(message).toContain("Report:");
	});

	it("does not delete memories when a dream write is rejected", async () => {
		const h = setup({
			reply: () =>
				JSON.stringify({
					writes: [
						{
							name: "Bad",
							description: "A credential",
							type: "feedback",
							body: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
						},
					],
					deletes: ["feedback_old.md", "feedback_second.md"],
				}),
		});
		seed(h.store, "Old", "Use npm.");
		seed(h.store, "Second", "Another note.");
		expect(h.store.files()).toHaveLength(2);
		await h.commands.get("memory").handler("dream", h.ctx);
		expect(h.store.files()).toHaveLength(2);
		expect(h.ctx.notifications.at(-1)).toContain("deletes skipped");
	});

	it("drafts a promotion without writing AGENTS.md", async () => {
		const h = setup();
		seed(h.store, "Use pnpm", "Use pnpm for installs.");
		await h.commands.get("memory").handler("promote Use pnpm", h.ctx);
		expect(h.ctx.notifications.at(-1)).toContain("not written");
	});
});
