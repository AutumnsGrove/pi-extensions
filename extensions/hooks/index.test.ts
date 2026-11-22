import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("external producers", () => {
	const emit = (h: Harness, payload: unknown): void => {
		h.bus.get("pi-hooks:emit")?.forEach((handler) => handler(payload));
	};

	it("dispatches PrWake to in-process handlers with the session envelope", async () => {
		const h = harness({});
		const seen: Array<Record<string, unknown>> = [];
		h.bus.get("pi-hooks:register")?.forEach((handler) =>
			handler({
				event: "PrWake",
				source: "attention",
				handler: (input: Record<string, unknown>) => {
					seen.push(input);
				},
			}),
		);

		await fire(h, "session_start", { type: "session_start", reason: "startup" }, ctxOf(h));
		emit(h, {
			event: "PrWake",
			input: {
				owner: "o",
				repo: "r",
				pullNumber: 7,
				eventTypes: ["checks.settled"],
				informational: true,
				summary: "checks settled: success",
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			hook_event_name: "PrWake",
			session_id: "session-1",
			owner: "o",
			repo: "r",
			pullNumber: 7,
			informational: true,
		});
	});

	it("runs configured hooks for a produced event", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-hooks-emit-"));
		const out = join(dir, "seen.json");
		try {
			const h = harness({
				hooks: {
					PrReadyToMerge: [
						{
							hooks: [
								{
									type: "command",
									command: process.execPath,
									args: [
										"-e",
										`process.stdin.pipe(require("fs").createWriteStream(${JSON.stringify(out)}))`,
									],
								},
							],
						},
					],
				},
			});
			await fire(h, "session_start", { type: "session_start", reason: "startup" }, ctxOf(h));
			emit(h, {
				event: "PrReadyToMerge",
				input: { owner: "o", repo: "r", pullNumber: 7, reason: "green" },
			});

			let seen: Record<string, unknown> | undefined;
			for (let attempt = 0; attempt < 40 && !seen; attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 25));
				try {
					seen = JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;
				} catch {
					// The hook has not written yet.
				}
			}
			expect(seen).toMatchObject({
				hook_event_name: "PrReadyToMerge",
				session_id: "session-1",
				pullNumber: 7,
				reason: "green",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("ignores an unknown event, a malformed payload, and a missing session", async () => {
		const h = harness({});
		const seen: string[] = [];
		h.bus.get("pi-hooks:register")?.forEach((handler) =>
			handler({
				event: "PrWake",
				source: "test",
				handler: (input: Record<string, unknown>) => {
					seen.push(String(input.hook_event_name));
				},
			}),
		);
		// No session_start yet: there is no context to build an envelope from.
		emit(h, { event: "PrWake", input: { informational: true } });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(seen).toEqual([]);

		await fire(h, "session_start", { type: "session_start", reason: "startup" }, ctxOf(h));
		emit(h, "not an emission");
		emit(h, { event: "NotAnEvent", input: {} });
		emit(h, { event: "PreToolUse", input: { tool_name: "bash" } });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(seen).toEqual([]);
	});
});
