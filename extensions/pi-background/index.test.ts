import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionToolContext,
	Theme,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginBlocker, resetBlockers } from "../_shared/blockers.ts";
import piBackground from "./index.ts";
import { getJob, killAllJobs, killJob, resetRegistry, startJob, summarize, waitForJob } from "./jobs.ts";

const plainTheme = { fg: (_color: string, text: string) => text } as unknown as Theme;

type Handler = (event: unknown, ctx: unknown) => unknown;

interface WidgetCall {
	key: string;
	content: unknown;
	options: { placement?: string } | undefined;
}

interface WidgetComponent {
	render(width: number): string[];
}

type WidgetFactory = (tui: unknown, theme: Theme) => WidgetComponent;

interface Harness {
	tools: Map<string, ToolDefinition>;
	handlers: Map<string, Handler>;
	commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
	shortcuts: Map<string, { handler: (ctx: unknown) => unknown }>;
	widgets: WidgetCall[];
	notifications: Array<{ message: string; level?: string }>;
	messages: Array<{ customType: string; content: string; display?: boolean }>;
	ctx: ExtensionToolContext;
	shutdown: () => void;
}

let logDir: string;

beforeEach(() => {
	logDir = mkdtempSync(join(tmpdir(), "pi-bg-index-"));
	process.env.PI_BG_LOG_DIR = logDir;
	resetRegistry();
});

afterEach(() => {
	resetBlockers();
	killAllJobs();
	resetRegistry();
	delete process.env.PI_BG_LOG_DIR;
	rmSync(logDir, { recursive: true, force: true });
});

function load(): Harness {
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const shortcuts = new Map<string, { handler: (ctx: unknown) => unknown }>();
	const widgets: WidgetCall[] = [];
	const notifications: Array<{ message: string; level?: string }> = [];
	const messages: Array<{ customType: string; content: string; display?: boolean }> = [];

	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: process.cwd(),
		model: undefined,
		thinkingLevel: undefined,
		sessionManager: {
			getSessionId: () => "session-1",
			getSessionFile: () => "/tmp/session.jsonl",
		},
		ui: {
			theme: plainTheme,
			setWidget: (key: string, content: unknown, options?: { placement?: string }) =>
				widgets.push({ key, content, options }),
			notify: (message: string, level?: string) => notifications.push({ message, level }),
		},
	} as unknown as ExtensionToolContext;

	const pi = {
		registerTool: (definition: ToolDefinition) => tools.set(definition.name, definition),
		registerCommand: (
			name: string,
			definition: { handler: (args: string, ctx: unknown) => Promise<void> }
		) => commands.set(name, definition),
		registerShortcut: (key: string, definition: { handler: (ctx: unknown) => unknown }) =>
			shortcuts.set(key, definition),
		registerFlag: () => {},
		getFlag: () => undefined,
		getSettings: () => ({}),
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler);
			return () => {};
		},
		sendMessage: (message: { customType: string; content: string; display?: boolean }) =>
			messages.push(message),
	} as unknown as ExtensionAPI;

	piBackground(pi);
	const shutdown = () => {
		handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
	};
	return { tools, handlers, commands, shortcuts, widgets, notifications, messages, ctx, shutdown };
}

function tool(h: Harness, name: string): ToolDefinition {
	const definition = h.tools.get(name);
	if (!definition) throw new Error(`missing tool ${name}`);
	return definition;
}

async function run(
	h: Harness,
	name: string,
	params: Record<string, unknown>
): Promise<Awaited<ReturnType<ToolDefinition["execute"]>>> {
	return tool(h, name).execute("call", params, undefined, undefined, h.ctx);
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function jobIdFrom(text: string): string {
	const match = /ID: (b[0-9a-z]+)/.exec(text);
	if (!match?.[1]) throw new Error(`no job id in: ${text}`);
	return match[1];
}

async function waitUntil(check: () => boolean, timeoutMs = 5000): Promise<void> {
	const started = Date.now();
	while (!check()) {
		if (Date.now() - started > timeoutMs) throw new Error("condition not met before timeout");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describe("pi-background registration", () => {
	it("registers the bash override, jobs tool, command, shortcut, and events", () => {
		const h = load();
		expect(h.tools.has("bash")).toBe(true);
		expect(h.tools.has("jobs")).toBe(true);
		expect(h.commands.has("bg")).toBe(true);
		expect(h.shortcuts.has("ctrl+shift+b")).toBe(true);
		for (const event of ["session_start", "session_shutdown", "session_compact"]) {
			expect(h.handlers.has(event)).toBe(true);
		}
		expect(tool(h, "bash").promptGuidelines?.length).toBeGreaterThan(0);
		expect(tool(h, "jobs").description).toContain("background shell jobs");
		h.shutdown();
	});
});

describe("bash override", () => {
	it("starts a command in the background immediately", async () => {
		const h = load();
		h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);

		const result = await run(h, "bash", {
			command: "printf 'hi\\n'",
			run_in_background: true,
		});
		const text = textOf(result);
		expect(text).toContain("Command running in the background with ID:");
		const id = jobIdFrom(text);
		const job = getJob(id);
		expect(job).toBeDefined();
		if (!job) return;

		expect(await waitForJob(job, 5000)).toBe("exited");
		expect(job.status).toBe("completed");
		await waitUntil(() => h.messages.length > 0);
		expect(h.messages[0]?.customType).toBe("pi-background");
		expect(h.messages[0]?.content).toContain("<task-notification>");
		h.shutdown();
	});

	it("moves a long foreground command to the background at the deadline", async () => {
		const h = load();
		h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);

		const result = await run(h, "bash", {
			command: "printf 'started\\n'; sleep 30",
			timeout: 1,
		});
		const text = textOf(result);
		expect(text).toContain("started");
		expect(text).toContain("Command running in the background with ID:");

		const job = getJob(jobIdFrom(text));
		expect(job?.status).toBe("running");
		if (job) killJob(job.id);
		h.shutdown();
	});

	it("defers completion notifications while a question is open", async () => {
		const h = load();
		h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
		const release = beginBlocker("pi-q-n-a");

		const result = await run(h, "bash", {
			command: "printf 'later\\n'",
			run_in_background: true,
		});
		const job = getJob(jobIdFrom(textOf(result)));
		if (!job) throw new Error("job missing");
		await waitForJob(job, 5000);

		// The job finished, but the agent must not be woken behind the form.
		expect(h.messages).toHaveLength(0);

		release();
		await waitUntil(() => h.messages.length > 0);
		expect(h.messages[0]?.content).toContain("<task-notification>");
		h.shutdown();
	});

	it("kills sleep-like commands instead of hiding them", async () => {
		const h = load();
		h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
		await expect(run(h, "bash", { command: "sleep 30", timeout: 1 })).rejects.toThrow(
			"Command timed out after 1 seconds"
		);
		h.shutdown();
	});
});

describe("jobs tool", () => {
	it("lists, reads, and clears background jobs", async () => {
		const h = load();
		h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);

		const started = await run(h, "bash", {
			command: "printf 'output line\\n'",
			run_in_background: true,
		});
		const id = jobIdFrom(textOf(started));
		const job = getJob(id);
		if (!job) throw new Error("job missing");
		await waitForJob(job, 5000);

		const list = await run(h, "jobs", { action: "list" });
		expect(textOf(list)).toContain(id);

		const output = await run(h, "jobs", { action: "output", id, lines: 10 });
		expect(textOf(output)).toContain("output line");
		expect(getJob(id)?.read).toBe(true);

		const killed = await run(h, "jobs", { action: "kill", id });
		expect(textOf(killed)).toContain("not running");

		const cleared = await run(h, "jobs", { action: "clear" });
		expect(textOf(cleared)).toContain("Cleared 1 finished job");
		h.shutdown();
	});

	it("searches log contents", async () => {
		const h = load();
		h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
		const started = await run(h, "bash", {
			command: "printf 'alpha\\nbeta\\n'",
			run_in_background: true,
		});
		const id = jobIdFrom(textOf(started));
		const job = getJob(id);
		if (!job) throw new Error("job missing");
		await waitForJob(job, 5000);

		const result = await run(h, "jobs", { action: "search", pattern: "bet." });
		expect(textOf(result)).toContain(`${id}: beta`);
		h.shutdown();
	});

	it("does not wake the agent while attach is already waiting", async () => {
		const h = load();
		h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
		const started = await run(h, "bash", {
			command: "sleep 1; printf 'woke\\n'",
			run_in_background: true,
		});
		const id = jobIdFrom(textOf(started));
		const attached = await run(h, "jobs", { action: "attach", id, timeout: 10, lines: 10 });
		expect(textOf(attached)).toContain("woke");
		expect(h.messages).toHaveLength(0);
		h.shutdown();
	});

	it("reports a missing job with a useful error", async () => {
		const h = load();
		await expect(run(h, "jobs", { action: "output", id: "nope" })).rejects.toThrow(
			'No background job with id "nope"'
		);
		h.shutdown();
	});
});

describe("human surfaces", () => {
	it("renders a widget for running jobs", async () => {
		const h = load();
		h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
		const job = startJob({
			command: "sleep 30",
			cwd: process.cwd(),
			notifyOnExit: true,
			ownerSessionId: "session-1",
		});

		const call = h.widgets.at(-1);
		expect(call?.key).toBe("pi-background");
		expect(call?.options).toEqual({ placement: "aboveEditor" });
		const component = (call?.content as WidgetFactory)({}, plainTheme);
		const lines = component.render(120);
		expect(lines.join("\n")).toContain("Background (1 running)");

		killJob(job.id);
		h.shutdown();
	});

	it("reminds the model about running jobs after compaction", async () => {
		const h = load();
		h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
		const job = startJob({
			command: "sleep 30",
			cwd: process.cwd(),
			notifyOnExit: true,
			ownerSessionId: "session-1",
		});

		h.handlers.get("session_compact")?.({}, h.ctx);
		const reminder = h.messages.at(-1);
		expect(reminder?.display).toBe(false);
		expect(reminder?.content).toContain("still running");

		killJob(job.id);
		h.shutdown();
	});

	it("lists and kills jobs through /bg", async () => {
		const h = load();
		h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
		const job = startJob({
			command: "sleep 30",
			cwd: process.cwd(),
			notifyOnExit: true,
			ownerSessionId: "session-1",
		});

		await h.commands.get("bg")?.handler("", h.ctx);
		expect(h.notifications.at(-1)?.message).toContain(job.id);

		await h.commands.get("bg")?.handler(`kill ${job.id}`, h.ctx);
		expect(h.notifications.at(-1)?.message).toContain(`Killed ${job.id}`);
		expect(summarize(job).status).toBe("killed");
		h.shutdown();
	});

	it("backgrounds foreground work via the shortcut", async () => {
		const h = load();
		h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
		const shortcut = h.shortcuts.get("ctrl+shift+b");
		await shortcut?.handler(h.ctx);
		expect(h.notifications.at(-1)?.message).toContain("No foreground command");
		h.shutdown();
	});

	it("refuses to detach while a question is open", async () => {
		const h = load();
		h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
		const release = beginBlocker("pi-q-n-a");
		try {
			await h.commands.get("bg")?.handler("detach", h.ctx);
			expect(h.notifications.at(-1)?.message).toContain("waiting for an answer");
			await h.shortcuts.get("ctrl+shift+b")?.handler(h.ctx);
			expect(h.notifications.at(-1)?.message).toContain("waiting for an answer");
		} finally {
			release();
		}
		h.shutdown();
	});
});
