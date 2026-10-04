import type { ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import piTasks from "./index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function load() {
	let tool: ToolDefinition | undefined;
	const events = new Map<string, Handler>();
	const commands = new Map<string, { handler: Handler }>();
	const messages: Array<{ customType: string; content: string; display: boolean }> = [];
	const pi = {
		registerTool: (definition: ToolDefinition) => {
			tool = definition;
		},
		registerCommand: (name: string, definition: { handler: Handler }) => {
			commands.set(name, definition);
		},
		on: (event: string, handler: Handler) => {
			events.set(event, handler);
			return () => {};
		},
		sendMessage: (message: { customType: string; content: string; display: boolean }) => {
			messages.push(message);
		},
	} as unknown as Parameters<typeof piTasks>[0];

	piTasks(pi);
	if (!tool) throw new Error("pi-tasks did not register a tool");
	return { tool, events, commands, messages };
}

const context = (sessionId: string): ExtensionToolContext =>
	({ sessionManager: { getSessionId: () => sessionId } }) as unknown as ExtensionToolContext;

function run(tool: ToolDefinition, ctx: ExtensionToolContext, params: Record<string, unknown>) {
	return tool.execute("call", params, undefined, undefined, ctx);
}

describe("pi-tasks registration", () => {
	it("registers the todo tool, the /todos command, and session events", () => {
		const { tool, events, commands } = load();
		expect(tool.name).toBe("todo");
		expect(tool.label).toBe("Todo");
		expect(tool.executionMode).toBe("sequential");
		expect(tool.promptGuidelines?.length).toBeGreaterThan(0);
		expect(commands.has("todos")).toBe(true);
		for (const event of ["session_start", "session_compact", "session_tree", "session_shutdown"]) {
			expect(events.has(event)).toBe(true);
		}
	});
});

describe("pi-tasks execute", () => {
	it("creates, updates, and lists tasks for a session", async () => {
		const { tool } = load();
		const ctx = context("execute-basic");

		const created = await run(tool, ctx, { action: "create", subject: "Write parser" });
		expect(created.content?.[0]).toMatchObject({ type: "text", text: "Created #1: Write parser (pending)" });
		expect(created.details).toMatchObject({ nextId: 2 });

		await run(tool, ctx, { action: "update", id: 1, status: "in_progress", activeForm: "writing" });
		const listed = await run(tool, ctx, { action: "list" });
		expect(listed.content?.[0]).toMatchObject({
			type: "text",
			text: "[in_progress] #1 Write parser (writing)",
		});
	});

	it("returns an in-band error and leaves state unchanged", async () => {
		const { tool } = load();
		const ctx = context("execute-error");

		const result = await run(tool, ctx, { action: "update", id: 42, status: "completed" });
		expect(result.content?.[0]).toMatchObject({ type: "text", text: "Error: #42 not found" });
		expect(result.details).toMatchObject({ todos: [], nextId: 1, error: "#42 not found" });
	});

	it("keeps sessions isolated", async () => {
		const { tool } = load();
		const a = context("session-a");
		const b = context("session-b");

		await run(tool, a, { action: "create", subject: "Only for A" });
		const listedB = await run(tool, b, { action: "list" });
		expect(listedB.content?.[0]).toMatchObject({ type: "text", text: "No todos" });
	});
});

function tuiContext(sessionId: string, setWidget = vi.fn(), branch: unknown[] = []) {
	return {
		hasUI: true,
		mode: "tui" as const,
		sessionManager: { getSessionId: () => sessionId, getBranch: () => branch },
		ui: { setWidget },
	};
}

describe("pi-tasks widget lifecycle", () => {
	it("stays blank on a fresh session", () => {
		const { events } = load();
		const setWidget = vi.fn();
		const ctx = tuiContext("widget-fresh", setWidget);

		events.get("session_start")!(undefined, ctx);
		expect(setWidget).not.toHaveBeenCalled();

		events.get("session_shutdown")!(undefined, ctx);
	});

	it("registers the panel once a task exists", async () => {
		const { tool, events } = load();
		const setWidget = vi.fn();
		const ctx = tuiContext("widget-create", setWidget);

		events.get("session_start")!(undefined, ctx);
		await run(tool, ctx as unknown as ExtensionToolContext, { action: "create", subject: "Write parser" });
		expect(setWidget).toHaveBeenCalledWith("pi-tasks", expect.any(Function), { placement: "aboveEditor" });

		events.get("session_shutdown")!(undefined, ctx);
	});

	it("re-registers on every change so the count can't go stale", async () => {
		const { tool, events } = load();
		const setWidget = vi.fn();
		const ctx = tuiContext("widget-update", setWidget);
		const toolCtx = ctx as unknown as ExtensionToolContext;

		events.get("session_start")!(undefined, ctx);
		await run(tool, toolCtx, { action: "create", subject: "A" });
		await run(tool, toolCtx, { action: "create", subject: "B" });
		await run(tool, toolCtx, { action: "update", id: 1, status: "completed" });
		await run(tool, toolCtx, { action: "delete", id: 2 });

		// create, create, complete, delete => a fresh setWidget each time, and the
		// last one removes the panel because nothing is left active.
		expect(setWidget).toHaveBeenCalledTimes(4);
		expect(setWidget).toHaveBeenLastCalledWith("pi-tasks", undefined);

		events.get("session_shutdown")!(undefined, ctx);
	});
});

describe("pi-tasks compaction reminder", () => {
	const branchWith = (subject: string) => [
		{
			type: "message",
			message: {
				role: "toolResult",
				toolName: "todo",
				details: { todos: [{ id: 1, subject, status: "in_progress" }], nextId: 2 },
			},
		},
	];

	it("re-injects a hidden one-line reminder after compaction", () => {
		const { events, messages } = load();
		const ctx = tuiContext("compact-1", vi.fn(), branchWith("Write parser"));

		events.get("session_compact")!(undefined, ctx);

		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({ customType: "pi-tasks", display: false });
		expect(messages[0]?.content).toContain("0/1 done");
		expect(messages[0]?.content).toContain("#1 [in_progress] Write parser");
	});

	it("stays silent when everything is done", () => {
		const { events, messages } = load();
		const ctx = tuiContext("compact-done", vi.fn(), [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: { todos: [{ id: 1, subject: "Done", status: "completed" }], nextId: 2 },
				},
			},
		]);

		events.get("session_compact")!(undefined, ctx);
		expect(messages).toHaveLength(0);
	});
});

describe("pi-tasks /todos command", () => {
	it("groups every task by status", async () => {
		const { tool, commands } = load();
		const ctx = context("command-1");
		await run(tool, ctx, { action: "create", subject: "A" });
		await run(tool, ctx, { action: "create", subject: "B" });
		await run(tool, ctx, { action: "update", id: 2, status: "in_progress", activeForm: "doing b" });
		await run(tool, ctx, { action: "update", id: 1, status: "completed" });

		const notify = vi.fn();
		const commandCtx = {
			...ctx,
			hasUI: true,
			ui: { notify, theme: { fg: (_role: string, text: string) => text } },
		};
		await commands.get("todos")!.handler("", commandCtx);

		expect(notify).toHaveBeenCalledTimes(1);
		const text = notify.mock.calls[0]?.[0] as string;
		expect(text).toContain("1/2 completed");
		expect(text).toContain("── In Progress ──");
		expect(text).toContain("◐ #2 B (doing b)");
		expect(text).toContain("── Completed ──");
		expect(text).toContain("✓ #1 A");
	});

	it("reports an empty list", async () => {
		const { commands } = load();
		const notify = vi.fn();
		await commands.get("todos")!.handler("", { ...context("command-empty"), hasUI: true, ui: { notify } });
		expect(notify).toHaveBeenCalledWith("No tasks yet. Ask the agent to add some!", "info");
	});
});
