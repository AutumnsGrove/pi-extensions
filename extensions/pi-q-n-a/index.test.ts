import type { ExtensionToolContext, ToolDefinition, Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import piQnA from "./index.ts";
import type { QuestionnaireResult } from "./schema.ts";

function loadTool(): ToolDefinition {
	let registered: ToolDefinition | undefined;
	const pi = {
		registerTool: (definition: ToolDefinition) => {
			registered = definition;
		},
	} as unknown as Parameters<typeof piQnA>[0];
	piQnA(pi);
	if (!registered) throw new Error("pi-q-n-a did not register a tool");
	return registered;
}

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

	it("aborts the turn when the user interrupts", async () => {
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
	});

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
