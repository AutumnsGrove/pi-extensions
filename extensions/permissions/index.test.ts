import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import permissions from "./index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface HarnessOptions {
	select?: string | string[];
	trusted?: boolean;
	cwd?: string;
	classify?: () => Promise<unknown>;
	complete?: () => Promise<unknown>;
}

interface Harness {
	handlers: Map<string, Handler[]>;
	commands: Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>;
	notices: string[];
	status: Array<string | undefined>;
	entries: Array<{ type: string; data: unknown }>;
	selects: string[];
	ctx: ExtensionContext;
	fire: (event: string, payload: unknown) => Promise<unknown>;
}

const dirs: string[] = [];

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function harness(settings: unknown, options: HarnessOptions = {}): Harness {
	delete (globalThis as Record<string, unknown>).__piHooksReady;
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
	const notices: string[] = [];
	const status: Array<string | undefined> = [];
	const entries: Array<{ type: string; data: unknown }> = [];
	const selects: string[] = [];
	const choices = Array.isArray(options.select)
		? [...options.select]
		: options.select
			? [options.select]
			: [];
	const flags = new Map<string, unknown>();

	const pi = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => undefined;
		},
		registerCommand(name: string, definition: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
			commands.set(name, definition.handler);
		},
		registerShortcut() {
			return undefined;
		},
		registerFlag() {
			return undefined;
		},
		getFlag(name: string) {
			return flags.get(name);
		},
		getSettings: () => settings,
		getAllTools: () => [
			{ name: "bash", annotations: { destructiveHint: true } },
			{ name: "write", annotations: { destructiveHint: true } },
			{ name: "edit", annotations: { destructiveHint: true } },
			{ name: "read", annotations: { readOnlyHint: true } },
			{ name: "mcp__docs__read", annotations: { readOnlyHint: true } },
			{ name: "mcp__jira__create", annotations: {} },
		],
		events: {
			emit() {
				return undefined;
			},
			on() {
				return () => undefined;
			},
		},
		appendEntry(type: string, data: unknown) {
			entries.push({ type, data });
		},
	} as unknown as ExtensionAPI;

	permissions(pi);

	const classifier = { provider: "openrouter", id: "typesafe/jev-1.14", type: "classifier" };
	const chat = { provider: "anthropic", id: "claude-haiku-4" };
	const ctx = {
		cwd: options.cwd ?? process.cwd(),
		hasUI: true,
		mode: "print",
		signal: undefined,
		isProjectTrusted: () => options.trusted ?? false,
		sessionManager: {
			getSessionId: () => "session-1",
			getSessionFile: () => undefined,
		},
		ui: {
			select: async (title: string, selectOptions: string[]) => {
				selects.push(title);
				return choices.shift() ?? "Deny";
			},
			notify: (message: string) => notices.push(message),
			setStatus: (_key: string, value: string | undefined) => status.push(value),
		},
		modelRegistry: {
			findOfType: () => classifier,
			getModelsOfType: () => [classifier],
			hasConfiguredAuth: () => true,
			classify:
				options.classify ??
				(async () => ({
					stopReason: "stop",
					answers: {
						destructive: { type: "bool", probability: 0.02 },
						exfiltration: { type: "bool", probability: 0.01 },
						user_intent: { type: "bool", probability: 0.97 },
						scope: { type: "choice", choice: "within_cwd" },
						risk: { type: "score", score: 1 },
					},
					provider: "openrouter",
					model: "typesafe/jev-1.14",
				})),
			find: () => chat,
			getAll: () => [chat],
			complete:
				options.complete ??
				(async () => ({
					content: [{ type: "text", text: '{"decision":"allow","confidence":0.9,"reason":"ok"}' }],
				})),
		},
	} as unknown as ExtensionContext;

	const fire = async (event: string, payload: unknown): Promise<unknown> => {
		let last: unknown;
		for (const handler of handlers.get(event) ?? []) {
			last = await handler(payload, ctx);
		}
		return last;
	};

	return { handlers, commands, notices, status, entries, selects, ctx, fire };
}

async function start(h: Harness): Promise<void> {
	await h.fire("session_start", { type: "session_start", reason: "startup" });
}

function toolCall(command: string, tool = "bash", input?: Record<string, unknown>): ToolCallEvent {
	return {
		type: "tool_call",
		toolName: tool,
		toolCallId: "call-1",
		input: input ?? { command },
	} as ToolCallEvent;
}

describe("permissions gate", () => {
	it("blocks a denied command", async () => {
		const h = harness({});
		await start(h);
		const result = (await h.fire("tool_call", toolCall("rm -rf /"))) as {
			block?: boolean;
			reason?: string;
		};
		expect(result.block).toBe(true);
		expect(result.reason).toContain("deny");
	});

	it("allows a rule-matched read command", async () => {
		const h = harness({});
		await start(h);
		expect(await h.fire("tool_call", toolCall("git status"))).toBeUndefined();
	});

	it("allows read-only tools", async () => {
		const h = harness({});
		await start(h);
		expect(
			await h.fire("tool_call", toolCall("", "read", { path: "src/a.ts" })),
		).toBeUndefined();
	});

	it("asks for an unmatched risky command in default mode", async () => {
		const h = harness({}, { select: "Deny" });
		await start(h);
		const result = (await h.fire("tool_call", toolCall("npm install"))) as {
			block?: boolean;
		};
		expect(result.block).toBe(true);
		expect(h.selects).toHaveLength(1);
	});

	it("denies without prompting in dontAsk mode", async () => {
		const h = harness({ permissions: { mode: "dontAsk" } });
		await start(h);
		const result = (await h.fire("tool_call", toolCall("npm install"))) as {
			block?: boolean;
		};
		expect(result.block).toBe(true);
		expect(h.selects).toHaveLength(0);
	});

	it("allows unmatched commands in bypass mode", async () => {
		const h = harness({ permissions: { mode: "bypass" } });
		await start(h);
		expect(await h.fire("tool_call", toolCall("npm install"))).toBeUndefined();
	});

	it("cannot smuggle a write past a read-only allow rule", async () => {
		const h = harness({}, { select: "Deny" });
		await start(h);
		const result = (await h.fire("tool_call", toolCall("cat package.json > /tmp/leak"))) as {
			block?: boolean;
		};
		expect(result.block).toBe(true);
		expect(h.selects).toHaveLength(1);
	});

	it("blocks a compound command whose later segment is denied", async () => {
		const h = harness({});
		await start(h);
		const result = (await h.fire("tool_call", toolCall("git status && rm -rf /"))) as {
			block?: boolean;
		};
		expect(result.block).toBe(true);
	});

	it("remembers an allow-for-session choice", async () => {
		const h = harness({}, { select: ["Allow for this session", "Deny"] });
		await start(h);
		expect(await h.fire("tool_call", toolCall("npm install"))).toBeUndefined();
		expect(await h.fire("tool_call", toolCall("npm install"))).toBeUndefined();
		expect(h.selects).toHaveLength(1);
	});

	it("auto-allows edits inside the project in acceptEdits mode", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-accept-"));
		dirs.push(cwd);
		const h = harness({ permissions: { mode: "acceptEdits" } }, { cwd });
		await start(h);
		expect(
			await h.fire("tool_call", toolCall("", "write", { path: join(cwd, "a.ts") })),
		).toBeUndefined();
	});

	it("asks for edits outside the project in acceptEdits mode", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-accept-"));
		dirs.push(cwd);
		const h = harness({ permissions: { mode: "acceptEdits" } }, { cwd, select: "Deny" });
		await start(h);
		const result = (await h.fire(
			"tool_call",
			toolCall("", "write", { path: "/tmp/outside.ts" }),
		)) as { block?: boolean };
		expect(result.block).toBe(true);
		expect(h.selects).toHaveLength(1);
	});

	it("writes an always-allow rule to project settings", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-persist-"));
		dirs.push(cwd);
		await mkdir(join(cwd, ".pi"), { recursive: true });
		await writeFile(join(cwd, ".pi", "settings.json"), "{}\n", "utf8");
		const h = harness({}, { cwd, trusted: true, select: "Always allow (write a rule)" });
		await start(h);
		expect(await h.fire("tool_call", toolCall("npm install"))).toBeUndefined();
		const saved = JSON.parse(await readFile(join(cwd, ".pi", "settings.json"), "utf8"));
		expect(saved.permissions.allow).toContain("Bash(npm install)");
	});

	it("logs a session entry and a JSONL decision", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-permissions-log-"));
		dirs.push(cwd);
		const h = harness({}, { cwd });
		await start(h);
		await h.fire("tool_call", toolCall("rm -rf /"));
		expect(h.entries.some((entry) => entry.type === "permissions-decision")).toBe(true);
		const log = await readFile(join(cwd, ".pi", "permissions", "decisions.jsonl"), "utf8");
		expect(log).toContain('"decision":"deny"');
	});
});

describe("auto mode", () => {
	it("allows when the classifier is confident", async () => {
		const h = harness({
			permissions: { mode: "auto", reviewer: { provider: "jev" } },
		});
		await start(h);
		expect(await h.fire("tool_call", toolCall("npm install"))).toBeUndefined();
		expect(h.selects).toHaveLength(0);
	});

	it("denies when the classifier is confident it is destructive", async () => {
		const h = harness(
			{ permissions: { mode: "auto", reviewer: { provider: "jev" } } },
			{
				classify: async () => ({
					stopReason: "stop",
					answers: {
						destructive: { type: "bool", probability: 0.97 },
						exfiltration: { type: "bool", probability: 0.02 },
						user_intent: { type: "bool", probability: 0.9 },
						scope: { type: "choice", choice: "within_cwd" },
						risk: { type: "score", score: 1 },
					},
				}),
			},
		);
		await start(h);
		const result = (await h.fire("tool_call", toolCall("npm install"))) as {
			block?: boolean;
		};
		expect(result.block).toBe(true);
	});

	it("fails closed when every reviewer is unavailable", async () => {
		const h = harness(
			{ permissions: { mode: "auto", reviewer: { provider: "jev" } } },
			{
				classify: async () => ({ stopReason: "error", errorMessage: "no key" }),
				complete: async () => {
					throw new Error("gateway down");
				},
			},
		);
		await start(h);
		const result = (await h.fire("tool_call", toolCall("npm install"))) as {
			block?: boolean;
			reason?: string;
		};
		expect(result.block).toBe(true);
		expect(result.reason).toContain("reviewer unavailable");
	});
});

describe("commands", () => {
	it("shows the summary", async () => {
		const h = harness({});
		await start(h);
		await h.commands.get("permissions")?.("", h.ctx);
		expect(h.notices.join("\n")).toContain("Mode:");
		expect(h.notices.join("\n")).toContain("Reviewer:");
	});

	it("changes mode", async () => {
		const h = harness({});
		await start(h);
		await h.commands.get("permissions")?.("mode bypass", h.ctx);
		expect(h.notices.join("\n")).toContain("Bypass");
	});

	it("diagnoses a call with test", async () => {
		const h = harness({});
		await start(h);
		await h.commands.get("permissions")?.(
			`test bash '{"command":"rm -rf /"}'`,
			h.ctx,
		);
		expect(h.notices.join("\n")).toContain("rule: deny");
	});
});
