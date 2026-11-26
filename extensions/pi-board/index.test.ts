import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginBlocker, resetBlockers } from "../_shared/blockers.ts";
import { HOOK_EVENT_CHANNEL } from "../_shared/hook-events.ts";
import piBoard, { WATCHDOG_MS } from "./index.ts";
import { readInbox, readLane, sendDirect, postTopic } from "./store.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface Rig {
	tools: Map<string, ToolDefinition>;
	handlers: Map<string, Handler>;
	commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
	sent: Array<{ message: { customType: string; content: string }; options: Record<string, unknown> }>;
	userMessages: string[];
	notes: string[];
	status: Array<string | undefined>;
	emitted: Array<{ event: string; input: Record<string, unknown> }>;
	flags: { idle: boolean; draft: string };
	ctx: ExtensionContext;
}

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-board-index-"));
	process.env.PI_BOARD_DIR = root;
	process.env.PI_BOARD_LANE = "b";
	delete process.env.PI_BOARD;
	vi.useFakeTimers();
});
afterEach(() => {
	resetBlockers();
	vi.useRealTimers();
	delete process.env.PI_BOARD_DIR;
	delete process.env.PI_BOARD_LANE;
	delete process.env.PI_BOARD;
	rmSync(root, { recursive: true, force: true });
});

function load(over: { hasUI?: boolean } = {}): Rig {
	const rig: Rig = {
		tools: new Map(),
		handlers: new Map(),
		commands: new Map(),
		sent: [],
		userMessages: [],
		notes: [],
		status: [],
		emitted: [],
		flags: { idle: true, draft: "" },
		ctx: undefined as never,
	};
	rig.ctx = {
		hasUI: over.hasUI ?? true,
		mode: "tui",
		cwd: "/work/proj",
		isIdle: () => rig.flags.idle,
		hasPendingMessages: () => false,
		sessionManager: { getSessionId: () => "sess-1", getSessionName: () => undefined },
		ui: {
			notify: (message: string) => rig.notes.push(message),
			setStatus: (_key: string, text: string | undefined) => rig.status.push(text),
			getEditorText: () => rig.flags.draft,
		},
	} as unknown as ExtensionContext;
	const pi = {
		registerTool: (definition: ToolDefinition) => rig.tools.set(definition.name, definition),
		registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => rig.commands.set(name, def),
		on: (event: string, handler: Handler) => {
			rig.handlers.set(event, handler);
			return () => {};
		},
		sendMessage: (message: { customType: string; content: string }, options: Record<string, unknown>) => rig.sent.push({ message, options }),
		sendUserMessage: (text: string) => rig.userMessages.push(text),
		exec: async () => ({ stdout: "feature-x\n", stderr: "", code: 0 }),
		events: { emit: (channel: string, data: { event: string; input: Record<string, unknown> }) => channel === HOOK_EVENT_CHANNEL && rig.emitted.push(data) },
	} as unknown as ExtensionAPI;
	piBoard(pi);
	return rig;
}

const start = async (rig: Rig, reason = "startup") => {
	await rig.handlers.get("session_start")?.({ reason }, rig.ctx);
};
const quit = async (rig: Rig) => rig.handlers.get("session_shutdown")?.({ reason: "quit" }, rig.ctx);
const call = (rig: Rig, name: string, params: Record<string, unknown>) =>
	rig.tools.get(name)!.execute("id", params as never, undefined, undefined, rig.ctx as never);
const textOf = (r: { content: Array<{ type: string; text?: string }> }) => r.content.map((c) => c.text ?? "").join("\n");

describe("lifecycle", () => {
	it("registers four tools and /board", () => {
		const rig = load();
		expect([...rig.tools.keys()].sort()).toEqual(["board_lanes", "board_post", "board_send", "board_wait"]);
		expect(rig.commands.has("board")).toBe(true);
	});

	it("claims a lane with cwd and branch, and releases it on quit", async () => {
		const rig = load();
		await start(rig);
		expect(readLane(root, "b")).toMatchObject({ cwd: "/work/proj", branch: "feature-x", tty: expect.any(Boolean) });
		expect(rig.status.at(-1)).toBe("board:b");
		await quit(rig);
		expect(readLane(root, "b")).toBeUndefined();
	});

	it("keeps the lane across a /reload", async () => {
		const rig = load();
		await start(rig);
		await rig.handlers.get("session_shutdown")?.({ reason: "reload" }, rig.ctx);
		expect(readLane(root, "b")).toBeDefined();
	});

	it("stays out of non-interactive runs and when disabled", async () => {
		const headless = load({ hasUI: false });
		await start(headless);
		expect(readLane(root, "b")).toBeUndefined();
		expect(textOf(await call(headless, "board_lanes", {}))).toContain("not active");
		process.env.PI_BOARD = "off";
		const off = load();
		await start(off);
		expect(readLane(root, "b")).toBeUndefined();
	});

	it("falls back to the directory name when no lane is configured", async () => {
		delete process.env.PI_BOARD_LANE;
		const rig = load();
		await start(rig);
		expect(readLane(root, "proj")).toBeDefined();
		await quit(rig);
	});

	it("mirrors working and idle into the lane file", async () => {
		const rig = load();
		await start(rig);
		await rig.handlers.get("agent_start")?.({}, rig.ctx);
		expect(readLane(root, "b")?.state).toBe("working");
		await rig.handlers.get("agent_settled")?.({}, rig.ctx);
		expect(readLane(root, "b")?.state).toBe("idle");
		await quit(rig);
	});
});

describe("tools", () => {
	it("board_wait parks, then a post from another process wakes the lane", async () => {
		const rig = load();
		await start(rig);
		const waited = textOf(await call(rig, "board_wait", { topics: ["task:42-done"] }));
		expect(waited).toContain("End your turn now");
		expect(rig.status.at(-1)).toBe("board:b · waiting on 1");

		postTopic(root, { from: "a", topic: "task:42-done", body: "merged" });
		await vi.advanceTimersByTimeAsync(4000);
		expect(rig.sent).toHaveLength(1);
		expect(rig.sent[0]!.options).toEqual({ triggerTurn: true, deliverAs: "steer" });
		expect(rig.sent[0]!.message.customType).toBe("pi-board");
		expect(rig.sent[0]!.message.content).toContain('topic="task:42-done"');
		expect(rig.emitted[0]).toMatchObject({ event: "BoardWake", input: { count: 1, from: ["a"], topics: ["task:42-done"] } });
		await quit(rig);
	});

	it("board_wait returns an event that was posted first", async () => {
		postTopic(root, { from: "a", topic: "task:42-done", body: "merged early" });
		const rig = load();
		await start(rig);
		const out = textOf(await call(rig, "board_wait", { topics: ["task:42-done"] }));
		expect(out).toContain("Already posted");
		expect(out).toContain("merged early");
		expect(out).toContain("not an instruction from the user");
		await quit(rig);
	});

	it("board_post tells the poster who was notified, and who was not", async () => {
		const rig = load();
		await start(rig);
		expect(textOf(await call(rig, "board_post", { topic: "t" }))).toContain("no lane is waiting");
		expect(textOf(await call(rig, "board_post", { topic: " " }))).toContain("Not posted");
		await quit(rig);
	});

	it("board_send reaches a live lane and flags unknown ones", async () => {
		const rig = load();
		await start(rig);
		expect(textOf(await call(rig, "board_send", { to: "ghost", body: "hi" }))).toContain("no lane has that name yet");
		expect(readInbox(root, "ghost")).toHaveLength(1);
		expect(textOf(await call(rig, "board_send", { to: "x", body: "" }))).toContain("Not sent");
		await quit(rig);
	});

	it("board_lanes marks the caller", async () => {
		const rig = load();
		await start(rig);
		expect(textOf(await call(rig, "board_lanes", {}))).toMatch(/^b \(you\)  idle/);
		await quit(rig);
	});
});

describe("session replacement", () => {
	// Pi re-runs the extension factory for /new, /resume and /fork and invalidates the old
	// instance's API, but never stops what the old instance started.
	for (const reason of ["new", "resume", "fork"]) {
		it(`stops the old board on ${reason}, so only the new session receives the message`, async () => {
			const old = load();
			await start(old);
			await old.handlers.get("session_shutdown")?.({ reason }, old.ctx);
			// From here the old instance's pi.sendMessage throws, as a stale API does in pi.
			let staleCalls = 0;
			old.sent.push = (() => {
				staleCalls++;
				throw new Error("This extension ctx is stale after session replacement or reload.");
			}) as never;

			const next = load();
			await next.handlers.get("session_start")?.({ reason }, next.ctx);
			sendDirect(root, { from: "a", to: "b", body: "after the swap" });
			// An old board still polling would read, ack and throw here.
			await vi.advanceTimersByTimeAsync(5000);

			expect(staleCalls).toBe(0);
			expect(next.sent).toHaveLength(1);
			expect(next.sent[0]!.message.content).toContain("after the swap");
			await quit(next);
		});
	}

	it("releases the lane on a session swap but keeps it across a reload", async () => {
		const first = load();
		await start(first);
		await first.handlers.get("session_shutdown")?.({ reason: "new" }, first.ctx);
		expect(readLane(root, "b")).toBeUndefined();
		const second = load();
		await start(second);
		await second.handlers.get("session_shutdown")?.({ reason: "reload" }, second.ctx);
		expect(readLane(root, "b")).toBeDefined();
	});

	it("stops listening for blocker changes when the session is replaced", async () => {
		const old = load();
		await start(old);
		await old.handlers.get("session_shutdown")?.({ reason: "new" }, old.ctx);
		sendDirect(root, { from: "a", to: "b", body: "x" });
		const release = beginBlocker("pi-q-n-a");
		release();
		await vi.advanceTimersByTimeAsync(5000);
		expect(old.sent).toEqual([]);
	});
});

describe("wake rules in the extension", () => {
	it("follows up instead of steering when the agent is busy", async () => {
		const rig = load();
		await start(rig);
		rig.flags.idle = false;
		sendDirect(root, { from: "a", to: "b", body: "fyi" });
		await vi.advanceTimersByTimeAsync(4000);
		expect(rig.sent[0]!.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
		await quit(rig);
	});

	it("holds delivery while a question blocks the session, then delivers on release", async () => {
		const rig = load();
		await start(rig);
		const release = beginBlocker("pi-q-n-a");
		sendDirect(root, { from: "a", to: "b", body: "x" });
		await vi.advanceTimersByTimeAsync(4000);
		expect(rig.sent).toEqual([]);
		release();
		await vi.advanceTimersByTimeAsync(50);
		expect(rig.sent).toHaveLength(1);
		await quit(rig);
	});

	it("queues without a turn for wake:false", async () => {
		const rig = load();
		await start(rig);
		sendDirect(root, { from: "a", to: "b", body: "later", wake: false });
		await vi.advanceTimersByTimeAsync(4000);
		expect(rig.sent[0]!.options).toEqual({ deliverAs: "nextTurn" });
		await quit(rig);
	});

	it("delivers messages that arrived while the lane was not running", async () => {
		sendDirect(root, { from: "a", to: "b", body: "waiting for you" });
		const rig = load();
		await start(rig);
		await vi.advanceTimersByTimeAsync(50);
		expect(rig.sent[0]!.message.content).toContain("waiting for you");
		await quit(rig);
	});
});

describe("watchdog", () => {
	it("nudges once when a wake never starts a turn", async () => {
		const rig = load();
		await start(rig);
		sendDirect(root, { from: "a", to: "b", body: "x" });
		await vi.advanceTimersByTimeAsync(1000);
		expect(rig.sent).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(WATCHDOG_MS + 10);
		expect(rig.userMessages).toHaveLength(1);
		expect(rig.notes.some((n) => n.includes("no turn started"))).toBe(true);
		await quit(rig);
	});

	it("stays quiet when the turn started", async () => {
		const rig = load();
		await start(rig);
		sendDirect(root, { from: "a", to: "b", body: "x" });
		await vi.advanceTimersByTimeAsync(1000);
		await rig.handlers.get("agent_start")?.({}, rig.ctx);
		await vi.advanceTimersByTimeAsync(WATCHDOG_MS + 10);
		expect(rig.userMessages).toEqual([]);
		await quit(rig);
	});

	it("does not nudge a lane that is busy or blocked", async () => {
		const rig = load();
		await start(rig);
		sendDirect(root, { from: "a", to: "b", body: "x" });
		await vi.advanceTimersByTimeAsync(1000);
		rig.flags.idle = false;
		await vi.advanceTimersByTimeAsync(WATCHDOG_MS + 10);
		expect(rig.userMessages).toEqual([]);
		await quit(rig);
	});
});

describe("/board", () => {
	const board = async (rig: Rig, args: string) => rig.commands.get("board")!.handler(args, rig.ctx);

	it("sends, posts, waits, renames, and shows lanes", async () => {
		const rig = load();
		await start(rig);
		await board(rig, "send c hello there");
		expect(readInbox(root, "c")[0]).toMatchObject({ body: "hello there", from: "b" });
		await board(rig, "post task:1-done finished");
		await board(rig, "wait task:2-done");
		expect(rig.notes.at(-1)).toBe("waiting on task:2-done");
		await board(rig, "name zed");
		expect(rig.notes.at(-1)).toBe('lane is now "zed"');
		expect(readLane(root, "zed")).toBeDefined();
		await board(rig, "lanes");
		expect(rig.notes.at(-1)).toMatch(/^zed \(you\)/);
		await quit(rig);
	});

	it("explains bad usage and an inactive board", async () => {
		const rig = load();
		await start(rig);
		await board(rig, "send onlylane");
		expect(rig.notes.at(-1)).toContain("usage: /board send");
		await board(rig, "bogus");
		expect(rig.notes.at(-1)).toContain("/board lanes");
		const idle = load({ hasUI: false });
		await start(idle);
		await board(idle, "lanes");
		expect(idle.notes.at(-1)).toContain("not active");
		await quit(rig);
	});
});
