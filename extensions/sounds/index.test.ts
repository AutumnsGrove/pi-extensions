import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createSounds } from "./index.ts";

interface Registration {
	event: string;
	source: string;
	handler: (input: { hook_event_name?: string }) => unknown;
}

interface Harness {
	registered: Registration[];
	handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>;
	commands: Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>;
	notices: string[];
	emit: (channel: string, data: unknown) => void;
	ctx: ExtensionContext;
	fire: (event: string, payload: unknown) => Promise<unknown>;
}

function harness(settings: unknown, deps: { play: (file: string) => void; now: () => number }): Harness {
	(globalThis as Record<string, unknown>).__piHooksReady = true;
	const registered: Registration[] = [];
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
	const notices: string[] = [];
	const bus = new Map<string, Set<(data: unknown) => void>>();

	const pi = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => undefined;
		},
		registerCommand(name: string, definition: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
			commands.set(name, definition.handler);
		},
		registerFlag() {
			return undefined;
		},
		getFlag() {
			return undefined;
		},
		getSettings: () => settings,
		events: {
			emit(channel: string, data: unknown) {
				if (channel === "pi-hooks:register") {
					registered.push(data as Registration);
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

	createSounds(pi, deps);

	const ctx = {
		hasUI: false,
		ui: {
			notify: (message: string) => notices.push(message),
		},
	} as unknown as ExtensionContext;

	const fire = async (event: string, payload: unknown): Promise<unknown> => {
		let last: unknown;
		for (const handler of handlers.get(event) ?? []) last = await handler(payload, ctx);
		return last;
	};

	return {
		registered,
		handlers,
		commands,
		notices,
		emit: (channel, data) => pi.events.emit(channel, data),
		ctx,
		fire,
	};
}

afterEach(() => {
	(globalThis as Record<string, unknown>).__piHooksReady = false;
});

const handlerFor = (h: Harness, event: string) =>
	h.registered.find((entry) => entry.event === event)?.handler;

describe("sounds extension", () => {
	it("plays the mapped file for a hook event", async () => {
		const played: string[] = [];
		const h = harness({ sounds: { directory: "/sounds" } }, { play: (file) => played.push(file), now: () => 0 });
		await h.fire("session_start", { type: "session_start", reason: "startup" });
		handlerFor(h, "PreToolUse")?.({ hook_event_name: "PreToolUse" });
		expect(played).toEqual(["/sounds/tool_start.wav"]);
	});

	it("debounces the same file", async () => {
		const played: string[] = [];
		let clock = 1000;
		const h = harness(
			{ sounds: { directory: "/sounds", debounceMs: 150 } },
			{ play: (file) => played.push(file), now: () => clock },
		);
		await h.fire("session_start", { type: "session_start", reason: "startup" });
		const pre = handlerFor(h, "PreToolUse");
		pre?.({ hook_event_name: "PreToolUse" });
		clock = 1050;
		pre?.({ hook_event_name: "PreToolUse" });
		expect(played).toHaveLength(1);
		clock = 1300;
		pre?.({ hook_event_name: "PreToolUse" });
		expect(played).toHaveLength(2);
	});

	it("stays silent when disabled", async () => {
		const played: string[] = [];
		const h = harness({ sounds: { enabled: false } }, { play: (file) => played.push(file), now: () => 0 });
		await h.fire("session_start", { type: "session_start", reason: "startup" });
		handlerFor(h, "PreToolUse")?.({ hook_event_name: "PreToolUse" });
		expect(played).toEqual([]);
	});

	it("ignores events with no mapping", async () => {
		const played: string[] = [];
		const h = harness({ sounds: {} }, { play: (file) => played.push(file), now: () => 0 });
		await h.fire("session_start", { type: "session_start", reason: "startup" });
		handlerFor(h, "TurnStart")?.({ hook_event_name: "TurnStart" });
		expect(played).toEqual([]);
	});

	it("plays a cue on a permission prompt", async () => {
		const played: string[] = [];
		const h = harness({ sounds: { directory: "/sounds" } }, { play: (file) => played.push(file), now: () => 0 });
		await h.fire("session_start", { type: "session_start", reason: "startup" });
		h.emit("pi-permissions:prompt", { tool: "bash" });
		expect(played).toEqual(["/sounds/permission_request.wav"]);
	});

	it("tests a mapping through /sounds", async () => {
		const played: string[] = [];
		const h = harness({ sounds: { directory: "/sounds" } }, { play: (file) => played.push(file), now: () => 0 });
		await h.fire("session_start", { type: "session_start", reason: "startup" });
		await h.commands.get("sounds")?.("test Stop", h.ctx);
		expect(played).toEqual(["/sounds/stop.wav"]);
		expect(h.notices.join("\n")).toContain("stop.wav");
	});
});
