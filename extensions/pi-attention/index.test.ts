import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { attentionActive } from "../_shared/attention.ts";
import { createAttention, type AttentionDeps } from "./index.ts";
import type { VerdictRecord } from "./types.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface Harness {
	handler: (name: string) => Handler | undefined;
	emit: (channel: string, data: unknown) => void;
	hookEvents: Array<{ event: string; input: Record<string, unknown> }>;
	commands: Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>;
	notices: string[];
	ctx: ExtensionContext;
	settle: () => Promise<void>;
}

const settings = (overrides: Record<string, unknown> = {}) => ({
	attention: { ...overrides },
});

async function load(
	options: { settings?: unknown; deps?: AttentionDeps } = {},
): Promise<Harness> {
	const handlers = new Map<string, Handler[]>();
	const bus = new Map<string, Set<(data: unknown) => void>>();
	const hookEvents: Harness["hookEvents"] = [];
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
	const notices: string[] = [];

	const pi = {
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
			return () => undefined;
		},
		registerCommand(name: string, definition: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
			commands.set(name, definition.handler);
		},
		getSettings: () => options.settings ?? settings(),
		events: {
			emit(channel: string, data: unknown) {
				if (channel === "pi-hooks:emit") {
					hookEvents.push(data as { event: string; input: Record<string, unknown> });
				}
				for (const listener of bus.get(channel) ?? []) listener(data);
			},
			on(channel: string, listener: (data: unknown) => void) {
				const set = bus.get(channel) ?? new Set();
				set.add(listener);
				bus.set(channel, set);
				return () => set.delete(listener);
			},
		},
	} as unknown as ExtensionAPI;

	// Never write the real verdict log from a test.
	createAttention(pi, { log: () => undefined, ...options.deps });

	const ctx = {
		hasUI: false,
		mode: "print",
		cwd: "/tmp/project",
		sessionManager: { getSessionId: () => "session-1", getSessionFile: () => undefined },
		ui: { notify: (message: string) => notices.push(message) },
	} as unknown as ExtensionContext;

	const fire = async (name: string, event: unknown): Promise<void> => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};

	return {
		handler: (name) => handlers.get(name)?.[0],
		emit: (channel, data) => pi.events.emit(channel, data),
		hookEvents,
		commands,
		notices,
		ctx,
		settle: async () => {
			await fire("agent_settled", { type: "agent_settled", aborted: false });
			// The model path is fire-and-forget; let its microtasks run.
			await new Promise((resolve) => setTimeout(resolve, 0));
		},
	};
}

const wake = (informational: boolean) => ({
	event: "PrWake",
	input: {
		owner: "AutumnsGrove",
		repo: "pi-extensions",
		pullNumber: 63,
		eventTypes: ["checks.settled"],
		informational,
		summary: "checks settled on 7d62b8f: success (1 total)",
	},
});

const states = (h: Harness): Array<string> =>
	h.hookEvents.filter((event) => event.event === "AttentionChanged").map((event) => String(event.input.state));

afterEach(() => {
	(globalThis as Record<string, unknown>).__piAttentionActive = false;
});

describe("session lifecycle", () => {
	it("announces itself so sounds stops owning the settle cue", async () => {
		const h = await load();
		expect(attentionActive()).toBe(false);
		await h.handler("session_start")?.({ type: "session_start", reason: "startup" }, h.ctx);
		expect(attentionActive()).toBe(true);
	});

	it("does not announce itself while disabled, so sounds keeps its cue", async () => {
		const h = await load({ settings: settings({ enabled: false }) });
		await h.handler("session_start")?.({ type: "session_start", reason: "startup" }, h.ctx);
		expect(attentionActive()).toBe(false);
	});

	it("re-syncs the announcement through /attention reload and off", async () => {
		const settingsValue = settings();
		const h = await load({ settings: settingsValue });
		await h.handler("session_start")?.({ type: "session_start", reason: "startup" }, h.ctx);
		expect(attentionActive()).toBe(true);

		(settingsValue.attention as Record<string, unknown>).enabled = false;
		await h.commands.get("attention")?.("reload", h.ctx);
		expect(attentionActive()).toBe(false);

		(settingsValue.attention as Record<string, unknown>).enabled = true;
		await h.commands.get("attention")?.("reload", h.ctx);
		expect(attentionActive()).toBe(true);

		await h.commands.get("attention")?.("off", h.ctx);
		expect(attentionActive()).toBe(false);
	});

	it("withdraws the announcement on quit but not on reload", async () => {
		const h = await load();
		await h.handler("session_start")?.({ type: "session_start", reason: "startup" }, h.ctx);
		await h.handler("session_shutdown")?.({ type: "session_shutdown", reason: "reload" }, h.ctx);
		expect(attentionActive()).toBe(true);
		await h.handler("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, h.ctx);
		expect(attentionActive()).toBe(false);
	});
});

describe("states", () => {
	it("works while a turn runs", async () => {
		const h = await load();
		await h.handler("session_start")?.({ type: "session_start", reason: "startup" }, h.ctx);
		await h.handler("agent_start")?.({ type: "agent_start" }, h.ctx);
		expect(states(h)).toEqual(["working"]);
	});

	it("waits on an informational wake that made no tool calls", async () => {
		const h = await load();
		await h.handler("session_start")?.({ type: "session_start", reason: "startup" }, h.ctx);
		h.emit("pi-hooks:emit", wake(true));
		await h.handler("agent_start")?.({ type: "agent_start" }, h.ctx);
		await h.settle();
		expect(states(h)).toEqual(["working", "waiting"]);
	});

	it("needs you for a wake that failed or got a comment", async () => {
		const h = await load();
		await h.handler("session_start")?.({ type: "session_start", reason: "startup" }, h.ctx);
		h.emit("pi-hooks:emit", wake(false));
		await h.handler("agent_start")?.({ type: "agent_start" }, h.ctx);
		await h.handler("tool_call")?.({ toolName: "bash" }, h.ctx);
		await h.settle();
		expect(states(h).at(-1)).toBe("needs_you");
		const last = h.hookEvents.at(-1);
		expect(last?.input.reason).toBe("the pull request needs you");
		expect(last?.input.source).toBe("rule");
	});

	it("is ready the moment a done release lands, before the turn settles", async () => {
		const h = await load();
		await h.handler("session_start")?.({ type: "session_start", reason: "startup" }, h.ctx);
		h.emit("pi-hooks:emit", {
			event: "PrReadyToMerge",
			input: { owner: "o", repo: "r", pullNumber: 63, reason: "green, reviews addressed" },
		});
		expect(states(h)).toEqual(["ready"]);
		expect(h.hookEvents.at(-1)?.input.reason).toBe("released as done: green, reviews addressed");
		await h.handler("agent_start")?.({ type: "agent_start" }, h.ctx);
		await h.settle();
		// The release sticks: the turn that released it settles as ready.
		expect(states(h).at(-1)).toBe("ready");
	});

	it("is idle for an ordinary turn", async () => {
		const h = await load();
		await h.handler("session_start")?.({ type: "session_start", reason: "startup" }, h.ctx);
		await h.handler("agent_start")?.({ type: "agent_start" }, h.ctx);
		await h.settle();
		expect(states(h).at(-1)).toBe("idle");
	});

	it("needs you while a prompt is open", async () => {
		const h = await load();
		await h.handler("session_start")?.({ type: "session_start", reason: "startup" }, h.ctx);
		await h.handler("ui_prompt_start")?.({ type: "ui_prompt_start" }, h.ctx);
		expect(states(h)).toEqual(["needs_you"]);
		await h.handler("ui_prompt_end")?.({ type: "ui_prompt_end" }, h.ctx);
		expect(states(h)).toEqual(["needs_you", "working"]);

		const permission = await load();
		await permission.handler("session_start")?.({ type: "session_start", reason: "startup" }, permission.ctx);
		permission.emit("pi-permissions:prompt", { tool: "bash" });
		expect(states(permission)).toEqual(["needs_you"]);
	});

	it("does not repeat an identical consecutive state", async () => {
		const h = await load();
		await h.handler("session_start")?.({ type: "session_start", reason: "startup" }, h.ctx);
		await h.handler("agent_start")?.({ type: "agent_start" }, h.ctx);
		await h.handler("agent_start")?.({ type: "agent_start" }, h.ctx);
		await h.settle();
		await h.settle();
		// Two ordinary turns settle to the same `idle`: one cue, not two.
		expect(states(h)).toEqual(["working", "idle"]);
	});
});

describe("the decision model", () => {
	it("classifies an informational wake that did work", async () => {
		const logs: VerdictRecord[] = [];
		const h = await load({
			deps: {
				log: (record) => logs.push(record),
				decide: async () => ({
					ok: true,
					model: "openrouter/typesafe/jev-1.14",
					durationMs: 42,
					answers: {
						needs_you: { type: "bool", probability: 0.1 },
						outcome: {
							type: "choice",
							choice: "nothing_to_do",
							probabilities: { nothing_to_do: 0.93, reported: 0.06, blocked: 0.01 },
							confidence: 0.93,
						},
					},
				}),
			},
		});
		await h.handler("session_start")?.({ type: "session_start", reason: "startup" }, h.ctx);
		h.emit("pi-hooks:emit", wake(true));
		await h.handler("agent_start")?.({ type: "agent_start" }, h.ctx);
		await h.handler("tool_call")?.({ toolName: "bash" }, h.ctx);
		await h.handler("message_end")?.(
			{
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "Checked the logs; all fine." }] },
			},
			h.ctx,
		);
		await h.settle();

		const last = h.hookEvents.at(-1);
		expect(last?.input.state).toBe("waiting");
		expect(last?.input.source).toBe("model");
		const verdict = logs.at(-1);
		expect(verdict?.model).toBe("openrouter/typesafe/jev-1.14");
		expect(verdict?.answers).toBeDefined();
		expect(verdict?.input).toMatchObject({
			pull: "AutumnsGrove/pi-extensions#63",
			informational: true,
			lastText: "Checked the logs; all fine.",
			toolCalls: 1,
		});
	});

	it("needs you when the model reports something", async () => {
		const h = await load({
			deps: {
				log: () => undefined,
				decide: async () => ({
					ok: true,
					model: "m",
					durationMs: 10,
					answers: {
						needs_you: { type: "bool", probability: 0.9 },
						outcome: {
							type: "choice",
							choice: "reported",
							probabilities: { nothing_to_do: 0.05, reported: 0.9, blocked: 0.05 },
							confidence: 0.9,
						},
					},
				}),
			},
		});
		await h.handler("session_start")?.({ type: "session_start", reason: "startup" }, h.ctx);
		h.emit("pi-hooks:emit", wake(true));
		await h.handler("agent_start")?.({ type: "agent_start" }, h.ctx);
		await h.handler("tool_call")?.({ toolName: "bash" }, h.ctx);
		await h.settle();
		expect(h.hookEvents.at(-1)?.input.state).toBe("needs_you");
	});

	it("fails loud when every model is unavailable", async () => {
		const logs: VerdictRecord[] = [];
		const h = await load({
			deps: {
				log: (record) => logs.push(record),
				decide: async () => ({ ok: false, errors: ["a: timed out", "b: no auth"], durationMs: 2500 }),
			},
		});
		await h.handler("session_start")?.({ type: "session_start", reason: "startup" }, h.ctx);
		h.emit("pi-hooks:emit", wake(true));
		await h.handler("agent_start")?.({ type: "agent_start" }, h.ctx);
		await h.handler("tool_call")?.({ toolName: "bash" }, h.ctx);
		await h.settle();
		const last = h.hookEvents.at(-1);
		expect(last?.input.state).toBe("needs_you");
		expect(String(last?.input.reason)).toContain("b: no auth");
		expect(logs.at(-1)?.error).toContain("timed out");
	});

	it("drops a decision whose turn was replaced while the model was thinking", async () => {
		let resolveDecide: ((result: unknown) => void) | undefined;
		const h = await load({
			deps: {
				log: () => undefined,
				decide: () =>
					new Promise((resolve) => {
						resolveDecide = resolve as (result: unknown) => void;
					}),
			},
		});
		await h.handler("session_start")?.({ type: "session_start", reason: "startup" }, h.ctx);

		// An informational wake with work: the model is asked and hangs.
		h.emit("pi-hooks:emit", wake(true));
		await h.handler("agent_start")?.({ type: "agent_start" }, h.ctx);
		await h.handler("tool_call")?.({ toolName: "bash" }, h.ctx);
		await h.handler("agent_settled")?.({ type: "agent_settled", aborted: false }, h.ctx);
		expect(states(h)).toEqual(["working"]);

		// Steered: a wake that needs you starts the next turn before it resolves.
		h.emit("pi-hooks:emit", wake(false));
		await h.handler("agent_start")?.({ type: "agent_start" }, h.ctx);
		await h.settle();
		// The second turn's `working` is not a new state for a consumer.
		expect(states(h)).toEqual(["working", "needs_you"]);

		// The stale answer must not overwrite `needs_you` or clear the new facts.
		resolveDecide?.({
			ok: true,
			model: "m",
			durationMs: 5,
			answers: {
				needs_you: { type: "bool", probability: 0.99 },
				outcome: {
					type: "choice",
					choice: "nothing_to_do",
					probabilities: { nothing_to_do: 0.99 },
					confidence: 0.99,
				},
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(states(h)).toEqual(["working", "needs_you"]);
	});

	it("does not call a model when the rules already decided", async () => {
		let calls = 0;
		const h = await load({
			deps: {
				log: () => undefined,
				decide: async () => {
					calls += 1;
					return { ok: false, errors: [], durationMs: 0 };
				},
			},
		});
		await h.handler("session_start")?.({ type: "session_start", reason: "startup" }, h.ctx);
		h.emit("pi-hooks:emit", wake(false));
		await h.handler("agent_start")?.({ type: "agent_start" }, h.ctx);
		await h.settle();
		expect(calls).toBe(0);
	});

	it("asks for you, with no request, when no model is configured", async () => {
		let calls = 0;
		const h = await load({
			settings: settings({ models: [] }),
			deps: {
				log: () => undefined,
				decide: async () => {
					calls += 1;
					return { ok: false, errors: [], durationMs: 0 };
				},
			},
		});
		await h.handler("session_start")?.({ type: "session_start", reason: "startup" }, h.ctx);
		h.emit("pi-hooks:emit", wake(true));
		await h.handler("agent_start")?.({ type: "agent_start" }, h.ctx);
		await h.handler("tool_call")?.({ toolName: "bash" }, h.ctx);
		await h.settle();
		expect(calls).toBe(0);
		expect(h.hookEvents.at(-1)?.input.state).toBe("needs_you");
		expect(String(h.hookEvents.at(-1)?.input.reason)).toContain("no decision model");
	});
});

describe("configuration", () => {
	it("does nothing at all when disabled", async () => {
		const h = await load({ settings: settings({ enabled: false }) });
		await h.handler("session_start")?.({ type: "session_start", reason: "startup" }, h.ctx);
		h.emit("pi-hooks:emit", wake(false));
		await h.handler("agent_start")?.({ type: "agent_start" }, h.ctx);
		await h.settle();
		expect(states(h)).toEqual([]);
	});

	it("toggles and reports through /attention", async () => {
		const h = await load();
		await h.handler("session_start")?.({ type: "session_start", reason: "startup" }, h.ctx);
		const command = h.commands.get("attention");
		if (!command) throw new Error("missing command");

		await command("", h.ctx);
		expect(h.notices.at(-1)).toContain("openrouter/typesafe/jev-1.14");
		expect(h.notices.at(-1)).toContain("State: (nothing decided yet)");

		await command("off", h.ctx);
		expect(h.notices.at(-1)).toContain("Attention off");
		expect(attentionActive()).toBe(false);

		await command("on", h.ctx);
		expect(attentionActive()).toBe(true);

		await command("state", h.ctx);
		expect(h.notices.at(-1)).toContain("Nothing decided yet");

		await command("nonsense", h.ctx);
		expect(h.notices.at(-1)).toContain("Usage: /attention");
	});
});
