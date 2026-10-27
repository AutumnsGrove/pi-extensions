import type { ExtensionToolContext, ToolDefinition, Theme } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isBlocked, resetBlockers } from "../_shared/blockers.ts";
import piQnA from "./index.ts";
import type { QuestionnaireResult } from "./schema.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function load(): { tool: ToolDefinition; events: Map<string, Handler> } {
	let registered: ToolDefinition | undefined;
	const events = new Map<string, Handler>();
	const pi = {
		registerTool: (definition: ToolDefinition) => {
			registered = definition;
		},
		on: (event: string, handler: Handler) => {
			events.set(event, handler);
			return () => {};
		},
	} as unknown as Parameters<typeof piQnA>[0];
	piQnA(pi);
	if (!registered) throw new Error("pi-q-n-a did not register a tool");
	return { tool: registered, events };
}

function loadTool(): ToolDefinition {
	return load().tool;
}

afterEach(() => {
	resetBlockers();
});

const question = {
	id: "db",
	label: "Database",
	prompt: "Which database?",
	options: [{ label: "Postgres" }, { label: "SQLite" }],
};

function contextWithResult(
	result: QuestionnaireResult,
	onAbort: () => void = () => {}
): ExtensionToolContext {
	return {
		mode: "tui",
		ui: { custom: async () => result },
		abort: onAbort,
	} as unknown as ExtensionToolContext;
}

describe("pi-q-n-a registration", () => {
	it("registers a model-only, sequential tool", () => {
		const tool = loadTool();
		expect(tool.name).toBe("pi-q-n-a");
		expect(tool.exposure).toBe("model-only");
		expect(tool.executionMode).toBe("sequential");
		expect(tool.promptGuidelines?.join(" ")).toContain("note");
	});

	it("rejects an empty question list", async () => {
		const tool = loadTool();
		const result = await tool.execute(
			"call",
			{ questions: [] },
			undefined,
			undefined,
			contextWithResult({ questions: [], answers: [], interrupted: false })
		);
		expect(result.isError).toBe(true);
	});

	it("explains that the TUI is required outside tui mode", async () => {
		const tool = loadTool();
		const ctx = { mode: "json", ui: {}, abort: () => {} } as unknown as ExtensionToolContext;
		const result = await tool.execute("call", { questions: [question] }, undefined, undefined, ctx);
		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({ type: "text" });
	});
});

describe("pi-q-n-a execute", () => {
	it("returns a readable transcript with notes", async () => {
		const tool = loadTool();
		const result = await tool.execute(
			"call",
			{ questions: [question] },
			undefined,
			undefined,
			contextWithResult({
				questions: [],
				answers: [
					{
						id: "db",
						selections: ["Postgres"],
						skipped: false,
						note: "must support replication",
					},
				],
				interrupted: false,
			})
		);

		const block = result.content[0];
		const text = block?.type === "text" ? block.text : "";
		expect(text).toContain("Q: Which database?");
		expect(text).toContain("A: Postgres");
		expect(text).toContain("User note: must support replication");
		expect(result.isError).toBeFalsy();
	});

	it("aborts and terminates the turn when the user interrupts", async () => {
		const tool = loadTool();
		const abort = vi.fn();
		const result = await tool.execute(
			"call",
			{ questions: [question] },
			undefined,
			undefined,
			contextWithResult({ questions: [], answers: [], interrupted: true }, abort)
		);
		expect(abort).toHaveBeenCalledOnce();
		expect(result.details).toMatchObject({ interrupted: true });
		// `ctx.abort()` stops the stream but the loop would still answer the empty
		// result. `terminate` ends the batch so the model cannot keep working.
		expect(result.terminate).toBe(true);
	});

	it("does not terminate a normal answer", async () => {
		const tool = loadTool();
		const result = await tool.execute(
			"call",
			{ questions: [question] },
			undefined,
			undefined,
			contextWithResult({
				questions: [],
				answers: [{ id: "db", selections: ["SQLite"], skipped: false }],
				interrupted: false,
			})
		);
		expect(result.terminate).toBeUndefined();
	});
});

describe("pi-q-n-a is a hard blocker", () => {
	it("blocks every tool while the form is open and releases afterwards", async () => {
		const { tool, events } = load();
		let blockedDuringForm: boolean | undefined;
		let blockDuringForm: unknown;

		const ctx = {
			mode: "tui",
			abort: () => {},
			ui: {
				custom: async () => {
					blockedDuringForm = isBlocked();
					blockDuringForm = events.get("tool_call")!(
						{ type: "tool_call", toolCallId: "other", toolName: "bash", input: { command: "ls" } },
						{}
					);
					return { questions: [], answers: [], interrupted: false };
				},
			},
		} as unknown as ExtensionToolContext;

		await tool.execute("call", { questions: [question] }, undefined, undefined, ctx);

		expect(blockedDuringForm).toBe(true);
		expect(blockDuringForm).toMatchObject({ block: true, terminate: true });
		expect(isBlocked()).toBe(false);
		expect(events.get("tool_call")!({ type: "tool_call", toolCallId: "after", toolName: "bash" }, {})).toBeUndefined();
	});

	it("releases the blocker when the form throws", async () => {
		const { tool } = load();
		const ctx = {
			mode: "tui",
			abort: () => {},
			ui: {
				custom: async () => {
					throw new Error("UI closed unexpectedly");
				},
			},
		} as unknown as ExtensionToolContext;

		await expect(
			tool.execute("call", { questions: [question] }, undefined, undefined, ctx)
		).rejects.toThrow("UI closed unexpectedly");
		expect(isBlocked()).toBe(false);
	});
});

describe("pi-q-n-a rendering", () => {
	it("renders a summary in the transcript", () => {
		const tool = loadTool();
		const theme = {
			fg: (_token: string, text: string) => text,
			bg: (_token: string, text: string) => text,
			bold: (text: string) => text,
		} as unknown as Theme;
		const component = tool.renderResult?.(
			{
				content: [{ type: "text", text: "x" }],
				details: {
					questions: [
						{ ...question, allowOther: true, multiSelect: false },
					],
					answers: [
						{ id: "db", selections: ["SQLite"], skipped: false, note: "keep it small" },
					],
					interrupted: false,
				},
			},
			{ expanded: false, isError: false, showImages: false } as never,
			theme,
			{} as never
		);
		const rendered = component?.render(80).join("\n") ?? "";
		expect(rendered).toContain("SQLite");
		expect(rendered).toContain("keep it small");
	});
});
