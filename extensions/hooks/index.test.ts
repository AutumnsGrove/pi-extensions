import { describe, expect, it } from "vitest";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import hooks from "./index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface Harness {
	handlers: Map<string, Handler[]>;
	commands: Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>;
	bus: Map<string, Set<(data: unknown) => void>>;
	notices: string[];
	status: Array<string | undefined>;
}

function harness(settings: unknown): Harness {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
	const bus = new Map<string, Set<(data: unknown) => void>>();
	const notices: string[] = [];
	const status: Array<string | undefined> = [];

	const pi = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => undefined;
		},
		registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
			commands.set(name, options.handler);
		},
		getSettings: () => settings,
		events: {
			emit(channel: string, data: unknown) {
				for (const handler of bus.get(channel) ?? []) handler(data);
			},
			on(channel: string, handler: (data: unknown) => void) {
				const set = bus.get(channel) ?? new Set();
				set.add(handler);
				bus.set(channel, set);
				return () => set.delete(handler);
			},
		},
	} as unknown as ExtensionAPI;

	hooks(pi);

	return { handlers, commands, bus, notices, status };
}

async function fire(
	h: Harness,
	event: string,
	payload: unknown,
	ctx: ExtensionContext,
): Promise<unknown> {
	let last: unknown;
	for (const handler of h.handlers.get(event) ?? []) {
		last = await handler(payload, ctx);
	}
	return last;
}

const ctxOf = (h: Harness): ExtensionContext =>
	({
		cwd: process.cwd(),
		hasUI: true,
		sessionManager: {
			getSessionId: () => "session-1",
			getSessionFile: () => undefined,
		},
		ui: {
			confirm: async () => true,
			notify: (message: string) => h.notices.push(message),
			setStatus: (_key: string, value: string | undefined) => h.status.push(value),
		},
	}) as unknown as ExtensionContext;

describe("hooks extension wiring", () => {
	it("blocks a tool call when a command hook exits 2", async () => {
		const h = harness({
			hooks: {
				PreToolUse: [
					{
						hooks: [
							{
								type: "command",
								command: process.execPath,
								args: ["-e", "process.stderr.write('no rm -rf');process.exit(2)"],
							},
						],
					},
				],
			},
		});
		const event = {
			type: "tool_call",
			toolName: "bash",
			toolCallId: "call-1",
			input: { command: "rm -rf /" },
		} as ToolCallEvent;
		const result = (await fire(h, "tool_call", event, ctxOf(h))) as {
			block?: boolean;
			reason?: string;
		};
		expect(result.block).toBe(true);
		expect(result.reason).toBe("no rm -rf");
	});

	it("swallows a prompt when a UserPromptSubmit hook denies", async () => {
		const h = harness({
			hooks: {
				UserPromptSubmit: [
					{ hooks: [{ type: "command", command: process.execPath, args: ["-e", "process.exit(2)"] }] },
				],
			},
		});
		const result = await fire(
			h,
			"input",
			{ type: "input", text: "do it", source: "interactive" },
			ctxOf(h),
		);
		expect(result).toEqual({ action: "handled" });
	});

	it("lists hooks through /hooks", async () => {
		const h = harness({
			hooks: {
				PreToolUse: [{ hooks: [{ type: "command", command: "check.sh" }] }],
			},
		});
		const command = h.commands.get("hooks");
		expect(command).toBeDefined();
		await command?.("", ctxOf(h));
		expect(h.notices.join("\n")).toContain("PreToolUse");
		expect(h.notices.join("\n")).toContain("check.sh");
	});

	it("validates configuration through /hooks validate", async () => {
		const h = harness({ hooks: { NotAnEvent: [{ hooks: [] }] } });
		await h.commands.get("hooks")?.("validate", ctxOf(h));
		expect(h.notices.join("\n")).toContain("unknown hook event");
	});

	it("registers in-process handlers from other extensions", async () => {
		const h = harness({});
		h.bus.get("pi-hooks:register")?.forEach((handler) =>
			handler({
				event: "PreToolUse",
				source: "test-extension",
				handler: () => ({ decision: "deny", reason: "bus" }),
			}),
		);
		const event = {
			type: "tool_call",
			toolName: "bash",
			toolCallId: "call-1",
			input: { command: "ls" },
		} as ToolCallEvent;
		const result = (await fire(h, "tool_call", event, ctxOf(h))) as { block?: boolean };
		expect(result.block).toBe(true);
	});
});
