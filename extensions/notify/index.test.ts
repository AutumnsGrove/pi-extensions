import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import notify from "./index.ts";
import { VERDICT_GRACE_MS } from "./notify.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface Harness {
	handlers: Map<string, Handler>;
	commands: Map<
		string,
		{ handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
	>;
	writes: string[];
	notices: Array<{ message: string; level?: string }>;
	entries: unknown[];
	sessionName: string | undefined;
	/** Listeners registered on a `pi.events` channel, by channel. */
	bus: Map<string, Set<(data: unknown) => void>>;
}

/** A session message entry, shaped like what `getEntries()` returns. */
function assistantEntry(
	text: string,
	stopReason = "stop",
	errorMessage?: string
): unknown {
	return {
		type: "message",
		id: "entry-1",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			stopReason,
			errorMessage,
			usage: {},
			api: "openai",
			provider: "openai",
			model: "gpt",
			timestamp: 0,
		},
	};
}

function harness(
	options: { sessionName?: string; entries?: unknown[] } = {}
): {
	h: Harness;
	fire: (event: string, payload?: unknown) => void;
	emit: (channel: string, data: unknown) => void;
	attention: (state: string) => void;
	ctx: ExtensionContext;
} {
	const h: Harness = {
		handlers: new Map(),
		commands: new Map(),
		writes: [],
		notices: [],
		entries: options.entries ?? [],
		sessionName: options.sessionName,
		bus: new Map(),
	};

	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: "/repo/auth-refactor",
		sessionManager: {
			getSessionName: () => h.sessionName,
			getEntries: () => h.entries,
		},
		ui: {
			notify: (message: string, level?: string) =>
				h.notices.push({ message, level }),
		},
	} as unknown as ExtensionContext;

	const pi = {
		on: (event: string, handler: Handler) => {
			h.handlers.set(event, handler);
			return () => {};
		},
		registerCommand: (
			name: string,
			options: {
				handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
			}
		) => {
			h.commands.set(name, options);
		},
		events: {
			on: (channel: string, listener: (data: unknown) => void) => {
				const set = h.bus.get(channel) ?? new Set();
				set.add(listener);
				h.bus.set(channel, set);
				return () => set.delete(listener);
			},
		},
	} as unknown as ExtensionAPI;

	notify(pi);

	const fire = (event: string, payload: unknown = {}): void => {
		const handler = h.handlers.get(event);
		if (!handler) throw new Error(`no handler registered for ${event}`);
		handler(payload, ctx);
	};

	/** Send a message on a `pi.events` channel, as another extension would. */
	const emit = (channel: string, data: unknown): void => {
		for (const listener of [...(h.bus.get(channel) ?? [])]) listener(data);
	};

	/** Publish an attention verdict the way `pi-attention` does. */
	const attention = (state: string): void => {
		emit("pi-hooks:emit", {
			event: "AttentionChanged",
			input: { state, reason: "test", source: "rule" },
		});
	};

	return { h, fire, emit, attention, ctx };
}

const originalTermProgram = process.env.TERM_PROGRAM;
const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

/** Pretend `pi-attention` announced itself at load time. */
function attentionLoaded(): void {
	(globalThis as Record<string, unknown>).__piAttentionActive = true;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(0);
	delete (globalThis as Record<string, unknown>).__piAttentionActive;
	process.env.TERM_PROGRAM = "ghostty";
	Object.defineProperty(process.stdout, "isTTY", {
		value: true,
		configurable: true,
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	delete (globalThis as Record<string, unknown>).__piAttentionActive;
	if (originalTermProgram === undefined) delete process.env.TERM_PROGRAM;
	else process.env.TERM_PROGRAM = originalTermProgram;
	if (originalIsTTY) Object.defineProperty(process.stdout, "isTTY", originalIsTTY);
	else delete (process.stdout as { isTTY?: boolean }).isTTY;
});

/** Capture OSC writes into the harness's own array. */
function captureWrites(h: Harness): void {
	vi.spyOn(process.stdout, "write").mockImplementation(((
		chunk: string | Uint8Array
	) => {
		h.writes.push(
			typeof chunk === "string" ? chunk : Buffer.from(chunk).toString()
		);
		return true;
	}) as never);
}

describe("notify lifecycle", () => {
	it("announces a finished run with duration and summary", () => {
		const { h, fire } = harness({
			sessionName: "auth-refactor",
			entries: [
				assistantEntry("Refactored the token refresh path and added tests."),
			],
		});
		captureWrites(h);

		fire("agent_start");
		vi.setSystemTime(84_000);
		fire("agent_before_settle", { outcome: "completed" });
		fire("agent_settled", { aborted: false });

		expect(h.writes).toHaveLength(1);
		expect(h.writes[0]).toBe(
			"\x1b]9;Pi · auth-refactor — Finished in 1m 24s — Refactored the token refresh path and added tests.\x07"
		);
	});

	it("stays quiet for a run under three seconds", () => {
		const { h, fire } = harness({
			entries: [assistantEntry("Done.")],
		});
		captureWrites(h);

		fire("agent_start");
		vi.setSystemTime(2_000);
		fire("agent_settled", { aborted: false });

		expect(h.writes).toHaveLength(0);
	});

	it("announces errors even when the run was quick", () => {
		const { h, fire } = harness({
			sessionName: "pi",
			entries: [assistantEntry("", "error", "rate limited")],
		});
		captureWrites(h);

		fire("agent_start");
		vi.setSystemTime(1_000);
		fire("agent_before_settle", { outcome: "error" });
		fire("agent_settled", { aborted: false });

		expect(h.writes).toHaveLength(1);
		expect(h.writes[0]).toContain("Pi hit an error · pi");
		expect(h.writes[0]).toContain("Error after 1s — rate limited");
	});

	it("suppresses a quick user-stopped run but reports a long one", () => {
		const short = harness({ entries: [assistantEntry("", "aborted")] });
		captureWrites(short.h);
		short.fire("agent_start");
		vi.setSystemTime(1_000);
		short.fire("agent_settled", { aborted: true });
		expect(short.h.writes).toHaveLength(0);

		const long = harness({ entries: [assistantEntry("", "aborted")] });
		captureWrites(long.h);
		vi.setSystemTime(5_000);
		long.fire("agent_start");
		vi.setSystemTime(9_000);
		long.fire("agent_settled", { aborted: true });
		expect(long.h.writes).toHaveLength(1);
		expect(long.h.writes[0]).toContain("Stopped after 4s");
	});

	it("does not notify when no run start was seen", () => {
		const { h, fire } = harness({ entries: [assistantEntry("Done.")] });
		captureWrites(h);

		fire("agent_settled", { aborted: false });

		expect(h.writes).toHaveLength(0);
	});
});

describe("with pi-attention loaded", () => {
	/**
	 * Start a run the way the two extensions together actually do: attention
	 * announces `working` as the turn starts, and either extension may be loaded
	 * first, so the order within one event is not fixed.
	 */
	const start = (fire: (event: string, payload?: unknown) => void): void => {
		fire("agent_start");
	};

	it("holds the banner until the verdict arrives, and delivers it", () => {
		attentionLoaded();
		const { h, fire, attention } = harness({
			sessionName: "ci",
			entries: [assistantEntry("Checks are green on all three jobs.")],
		});
		captureWrites(h);

		attention("working");
		start(fire);
		vi.setSystemTime(60_000);
		fire("agent_settled", { aborted: false });
		expect(h.writes).toHaveLength(0);

		attention("needs_you");
		expect(h.writes).toHaveLength(1);
		expect(h.writes[0]).toContain("Finished in 1m —");
	});

	it("banners ready even for a run under three seconds", () => {
		attentionLoaded();
		const { h, fire, attention } = harness({ entries: [assistantEntry("Released.")] });
		captureWrites(h);

		attention("working");
		start(fire);
		vi.setSystemTime(1_000);
		fire("agent_settled", { aborted: false });
		attention("ready");

		expect(h.writes).toHaveLength(1);
		expect(h.writes[0]).toContain("Finished in 1s");
	});

	it("stays quiet when attention says waiting or idle", () => {
		for (const state of ["waiting", "idle"]) {
			attentionLoaded();
			const { h, fire, attention } = harness({ entries: [assistantEntry("Nothing to report.")] });
			captureWrites(h);

			attention("working");
			start(fire);
			vi.setSystemTime(90_000);
			fire("agent_settled", { aborted: false });
			attention(state);
			vi.advanceTimersByTime(VERDICT_GRACE_MS);

			expect(h.writes).toHaveLength(0);
			delete (globalThis as Record<string, unknown>).__piAttentionActive;
		}
	});

	it("takes a verdict that arrived before the settle handler ran", () => {
		attentionLoaded();
		const { h, fire, attention } = harness({ entries: [assistantEntry("Done.")] });
		captureWrites(h);

		// `pi-attention` loaded first, so it decides inside its own `agent_settled`
		// handler, before this extension's handler is awaited.
		attention("working");
		start(fire);
		vi.setSystemTime(30_000);
		attention("needs_you");
		fire("agent_settled", { aborted: false });

		expect(h.writes).toHaveLength(1);
	});

	it("keeps the error wording when attention says the failed run needs you", () => {
		attentionLoaded();
		const { h, fire, attention } = harness({
			sessionName: "pi",
			entries: [assistantEntry("", "error", "rate limited")],
		});
		captureWrites(h);

		attention("working");
		start(fire);
		vi.setSystemTime(1_000);
		fire("agent_before_settle", { outcome: "error" });
		fire("agent_settled", { aborted: false });
		attention("needs_you");

		expect(h.writes).toHaveLength(1);
		expect(h.writes[0]).toContain("Pi hit an error · pi");
		expect(h.writes[0]).toContain("rate limited");
	});

	it("ignores a verdict that belongs to the previous run", () => {
		attentionLoaded();
		const { h, fire, attention } = harness({ entries: [assistantEntry("Done.")] });
		captureWrites(h);

		attention("working");
		start(fire);
		vi.setSystemTime(60_000);
		fire("agent_settled", { aborted: false });
		attention("idle");
		expect(h.writes).toHaveLength(0);

		// The next run is quick and attention says nothing: the old `idle` must not
		// answer for it, so the duration rule decides.
		attention("working");
		start(fire);
		vi.setSystemTime(61_000);
		fire("agent_settled", { aborted: false });
		vi.advanceTimersByTime(VERDICT_GRACE_MS);

		expect(h.writes).toHaveLength(0);
	});

	it("falls back to the duration rule when no verdict arrives", () => {
		attentionLoaded();
		const quick = harness({ entries: [assistantEntry("Done.")] });
		captureWrites(quick.h);
		quick.attention("working");
		start(quick.fire);
		vi.setSystemTime(2_000);
		quick.fire("agent_settled", { aborted: false });
		vi.advanceTimersByTime(VERDICT_GRACE_MS);
		expect(quick.h.writes).toHaveLength(0);

		const long = harness({ entries: [assistantEntry("Done.")] });
		captureWrites(long.h);
		long.attention("working");
		start(long.fire);
		vi.setSystemTime(120_000);
		long.fire("agent_settled", { aborted: false });
		expect(long.h.writes).toHaveLength(0);
		vi.advanceTimersByTime(VERDICT_GRACE_MS);
		expect(long.h.writes).toHaveLength(1);
	});

	it("drops a held banner when the next run starts", () => {
		attentionLoaded();
		const { h, fire, attention } = harness({ entries: [assistantEntry("Done.")] });
		captureWrites(h);

		attention("working");
		start(fire);
		vi.setSystemTime(70_000);
		fire("agent_settled", { aborted: false });

		attention("working");
		start(fire);
		vi.advanceTimersByTime(VERDICT_GRACE_MS);

		expect(h.writes).toHaveLength(0);
	});

	it("leaves today's behaviour alone when attention is absent", () => {
		const quiet = harness({ entries: [assistantEntry("Done.")] });
		captureWrites(quiet.h);
		quiet.fire("agent_start");
		vi.setSystemTime(2_000);
		quiet.fire("agent_settled", { aborted: false });
		expect(quiet.h.writes).toHaveLength(0);

		const loud = harness({ entries: [assistantEntry("Done.")] });
		captureWrites(loud.h);
		loud.fire("agent_start");
		vi.setSystemTime(80_000);
		loud.fire("agent_settled", { aborted: false });
		expect(loud.h.writes).toHaveLength(1);
	});
});

describe("blocking prompts", () => {
	it("gives a pi-q-n-a form its own wording, once", () => {
		const { h, fire } = harness({ sessionName: "auth-refactor" });
		captureWrites(h);

		fire("agent_start");
		vi.setSystemTime(5_000);
		fire("tool_execution_start", {
			toolCallId: "t1",
			toolName: "pi-q-n-a",
			args: { questions: [{ prompt: "Which database?" }] },
		});
		fire("ui_prompt_start", { kind: "custom" });
		fire("ui_prompt_start", { kind: "custom" });

		expect(h.writes).toHaveLength(1);
		expect(h.writes[0]).toContain("Pi has a question · auth-refactor");
		expect(h.writes[0]).toContain("Which database?");

		fire("tool_execution_end", { toolCallId: "t1", toolName: "pi-q-n-a" });
	});

	it("announces a dialog raised during a run", () => {
		const { h, fire } = harness({ sessionName: "auth-refactor" });
		captureWrites(h);

		fire("agent_start");
		vi.setSystemTime(9_000);
		fire("ui_prompt_start", { kind: "confirm", title: "Allow rm -rf?" });

		expect(h.writes).toHaveLength(1);
		expect(h.writes[0]).toContain("Pi needs you · auth-refactor");
		expect(h.writes[0]).toContain("Allow rm -rf?");
		expect(h.writes[0]).toContain("after 9s");
	});

	it("ignores a dialog you opened yourself while idle", () => {
		const { h, fire } = harness({ sessionName: "auth-refactor" });
		captureWrites(h);

		fire("ui_prompt_start", { kind: "select", title: "Pick a theme" });

		expect(h.writes).toHaveLength(0);
	});
});

describe("/notify command", () => {
	it("toggles, previews even when off, and toggles back on", async () => {
		const { h, fire, ctx: extensionCtx } = harness({
			entries: [assistantEntry("Done.")],
		});
		captureWrites(h);
		const ctx = extensionCtx as unknown as ExtensionCommandContext;
		const command = h.commands.get("notify");
		if (!command) throw new Error("notify command missing");

		await command.handler("off", ctx);
		fire("agent_start");
		vi.setSystemTime(10_000);
		fire("agent_settled", { aborted: false });
		expect(h.writes).toHaveLength(0);

		await command.handler("test", ctx);
		expect(h.writes).toHaveLength(1);
		expect(h.writes[0]).toContain("Desktop notifications are working.");

		await command.handler("on", ctx);
		fire("agent_start");
		vi.setSystemTime(20_000);
		fire("agent_settled", { aborted: false });
		expect(h.writes).toHaveLength(2);
	});
});
