import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import piReview from "./index.ts";

type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

interface Harness {
	command: { name: string; handler: Handler; getArgumentCompletions?: (prefix: string) => unknown };
	tools: ToolDefinition[];
	notify: ReturnType<typeof vi.fn>;
	sendMessage: ReturnType<typeof vi.fn>;
	ctx: ExtensionCommandContext;
}

function load(): Harness {
	const tools: ToolDefinition[] = [];
	const notify = vi.fn();
	const sendMessage = vi.fn();
	let command: Harness["command"] | undefined;
	const pi = {
		registerCommand: (name: string, options: Omit<Harness["command"], "name">) => {
			command = { name, ...options };
		},
		registerTool: (tool: ToolDefinition) => {
			tools.push(tool);
		},
		on: () => () => {},
		exec: async () => ({ stdout: "", stderr: "", code: 1, killed: false, truncated: false }),
		sendMessage,
	} as unknown as Parameters<typeof piReview>[0];
	piReview(pi);
	if (!command) throw new Error("pi-review did not register a command");
	const ctx = {
		cwd: "/repo",
		model: undefined,
		thinkingLevel: "medium",
		isProjectTrusted: () => true,
		ui: {
			notify,
			setStatus: vi.fn(),
			setWorkingMessage: vi.fn(),
		},
	} as unknown as ExtensionCommandContext;
	return { command, tools, notify, sendMessage, ctx };
}

const original = process.env.PI_REVIEW;

afterEach(() => {
	if (original === undefined) delete process.env.PI_REVIEW;
	else process.env.PI_REVIEW = original;
});

describe("pi-review command", () => {
	it("registers the command and stays out of runner mode by default", () => {
		delete process.env.PI_REVIEW;
		const { command, tools } = load();
		expect(command.name).toBe("pi-review");
		expect(tools).toEqual([]);
	});

	it("registers submit_review in runner mode", () => {
		process.env.PI_REVIEW = "1";
		const { tools } = load();
		expect(tools.map((tool) => tool.name)).toEqual(["submit_review"]);
	});

	it("shows help with no arguments", async () => {
		delete process.env.PI_REVIEW;
		const { command, sendMessage, ctx } = load();
		await command.handler("", ctx);
		const message = sendMessage.mock.calls[0]![0] as { content: string; customType: string };
		expect(message.customType).toBe("pi-review");
		expect(message.content).toContain("## pi-review");
		expect(message.content).toContain("`/pi-review run");
	});

	it("explains that install is not implemented yet", async () => {
		delete process.env.PI_REVIEW;
		const { command, sendMessage, ctx } = load();
		await command.handler("install", ctx);
		const message = sendMessage.mock.calls[0]![0] as { content: string };
		expect(message.content).toContain("not implemented yet");
	});

	it("rejects an unknown subcommand", async () => {
		delete process.env.PI_REVIEW;
		const { command, notify, ctx } = load();
		await command.handler("nope", ctx);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("unknown subcommand"), "error");
	});

	it("suggests subcommands for completion", () => {
		delete process.env.PI_REVIEW;
		const { command } = load();
		const items = command.getArgumentCompletions?.("st") as { value: string }[];
		expect(items.map((item) => item.value)).toEqual(["status"]);
		expect(command.getArgumentCompletions?.("zzz")).toBeNull();
	});
});
