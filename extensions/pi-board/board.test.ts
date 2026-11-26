import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Board, DRAFT_GRACE_MS, MAX_WAKES_PER_MINUTE, type BoardDeps } from "./board.ts";
import { claimLane, readInbox, readLane, listLanes } from "./store.ts";

let root: string;
let clock: number;
const boards: Board[] = [];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-board-board-"));
	clock = 1_000_000;
	vi.useFakeTimers();
});
afterEach(() => {
	for (const b of boards.splice(0)) b.stop();
	vi.useRealTimers();
	rmSync(root, { recursive: true, force: true });
});

interface Rig {
	board: Board;
	delivered: Array<{ text: string; trigger: boolean; busy: boolean; ids: string[] }>;
	notes: string[];
	status: Array<string | undefined>;
	wakes: Array<{ count: number; from: string[]; topics: string[] }>;
	flags: { idle: boolean; pending: boolean; blocked: boolean; draft: string };
}

function rig(lane = "b", over: Partial<BoardDeps> = {}): Rig {
	const r: Rig = { board: undefined as never, delivered: [], notes: [], status: [], wakes: [], flags: { idle: true, pending: false, blocked: false, draft: "" } };
	r.board = new Board({
		root,
		now: () => clock,
		deliver: ({ text, trigger, busy, messages }) => r.delivered.push({ text, trigger, busy, ids: messages.map((m) => m.id) }),
		isIdle: () => r.flags.idle,
		hasPending: () => r.flags.pending,
		isBlocked: () => r.flags.blocked,
		draft: () => r.flags.draft,
		notify: (t) => r.notes.push(t),
		onStatus: (s) => r.status.push(s),
		onWake: (w) => r.wakes.push(w),
		...over,
	});
	boards.push(r.board);
	r.board.start({ desiredLane: lane, cwd: "/w", tty: true });
	return r;
}

const sender = () => {
	const a = rig("a");
	return a.board;
};

describe("presence", () => {
	it("claims a lane and shows it as idle", () => {
		const r = rig("b");
		expect(r.board.lane).toBe("b");
		expect(readLane(root, "b")).toMatchObject({ pid: process.pid, tty: true, state: "idle" });
	});

	it("tracks working/idle in the lane file", () => {
		const r = rig("b");
		r.board.setState("working");
		expect(readLane(root, "b")?.state).toBe("working");
		r.board.setState("idle");
		expect(readLane(root, "b")?.state).toBe("idle");
	});

	it("takes the next free name instead of clobbering a live lane", () => {
		claimLane(root, "b", { pid: process.ppid, host: hostname(), tty: true, cwd: "/", startedAt: 1, state: "idle" }, clock);
		const r = rig("b");
		expect(r.board.lane).toBe("b-2");
	});

	it("renames atomically and refuses a taken name", () => {
		const r = rig("b");
		// Another live process (our parent) holds "a".
		claimLane(root, "a", { pid: process.ppid, host: hostname(), tty: true, cwd: "/", startedAt: 1, state: "idle" }, clock);
		expect(r.board.rename("a")).toMatchObject({ ok: false });
		expect(r.board.lane).toBe("b");
		expect(r.board.rename("c")).toEqual({ ok: true, lane: "c" });
		expect(listLanes(root).map((l) => l.lane).sort()).toEqual(["a", "c"]);
		expect(readLane(root, "b")).toBeUndefined();
	});

	it("removes its lane on stop but not when keeping it for a reload", () => {
		const r = rig("b");
		r.board.stop({ keepLane: true });
		expect(readLane(root, "b")).toBeDefined();
		const r2 = rig("b");
		r2.board.stop();
		expect(readLane(root, "b")).toBeUndefined();
	});

	it("reclaims its lane if the file was taken while suspended", () => {
		const r = rig("b");
		const file = join(root, "lanes", "b.json");
		rmSync(file);
		vi.advanceTimersByTime(21_000);
		expect(readLane(root, "b")?.pid).toBe(process.pid);
	});

	it("paints unread count and waits in the status line", () => {
		const r = rig("b");
		r.board.wait(["task:1-done"]);
		expect(r.status.at(-1)).toBe("board:b · waiting on 1");
	});
});

describe("delivery", () => {
	it("wakes an idle lane with a steer turn and acks the file", () => {
		const r = rig("b");
		sender().send("b", "task 42 done");
		expect(r.board.drain()).toBe("delivered");
		expect(r.delivered).toHaveLength(1);
		expect(r.delivered[0]).toMatchObject({ trigger: true, busy: false });
		expect(r.delivered[0]!.text).toContain("task 42 done");
		expect(r.delivered[0]!.text).toContain("Rules for board messages");
		expect(readInbox(root, "b")).toEqual([]);
		expect(r.wakes[0]).toMatchObject({ count: 1, from: ["a"] });
	});

	it("sends rules once, then plain batches", () => {
		const r = rig("b");
		const a = sender();
		a.send("b", "one");
		r.board.drain();
		a.send("b", "two");
		r.board.drain();
		expect(r.delivered[0]!.text).toContain("Rules for board messages");
		expect(r.delivered[1]!.text).not.toContain("Rules for board messages");
	});

	it("delivers as a follow-up while the agent is working", () => {
		const r = rig("b");
		r.flags.idle = false;
		sender().send("b", "fyi");
		r.board.drain();
		expect(r.delivered[0]).toMatchObject({ trigger: true, busy: true });
	});

	it("treats pending queued messages as busy", () => {
		const r = rig("b");
		r.flags.pending = true;
		sender().send("b", "fyi");
		r.board.drain();
		expect(r.delivered[0]!.busy).toBe(true);
	});

	it("queues without a turn when the sender asked for no wake", () => {
		const r = rig("b");
		sender().send("b", "later", false);
		r.board.drain();
		expect(r.delivered[0]).toMatchObject({ trigger: false });
	});

	it("batches several messages into one turn", () => {
		const r = rig("b");
		const a = sender();
		a.send("b", "one");
		a.send("b", "two");
		r.board.drain();
		expect(r.delivered).toHaveLength(1);
		expect(r.delivered[0]!.ids).toHaveLength(2);
		expect(r.delivered[0]!.text.startsWith("2 board messages")).toBe(true);
	});

	it("does nothing when the inbox is empty", () => {
		expect(rig("b").board.drain()).toBe("empty");
	});

	it("does not deliver the same message twice if the ack was slow", () => {
		const r = rig("b");
		sender().send("b", "once");
		r.board.drain();
		r.board.drain();
		expect(r.delivered).toHaveLength(1);
	});

	it("keeps the message when delivery throws, and retries", () => {
		let fail = true;
		const r = rig("b", {
			deliver: () => {
				if (fail) throw new Error("boom");
			},
		});
		sender().send("b", "x");
		expect(() => r.board.drain()).toThrow("boom");
		expect(readInbox(root, "b")).toHaveLength(1);
		fail = false;
		expect(r.board.drain()).toBe("delivered");
		expect(readInbox(root, "b")).toEqual([]);
	});
});

describe("gates", () => {
	it("holds everything while a blocking question is open, then delivers on nudge", () => {
		const r = rig("b");
		r.flags.blocked = true;
		sender().send("b", "x");
		expect(r.board.drain()).toBe("deferred");
		expect(r.delivered).toEqual([]);
		r.flags.blocked = false;
		r.board.nudge();
		vi.advanceTimersByTime(10);
		expect(r.delivered).toHaveLength(1);
	});

	it("waits for a half-written draft, then wakes anyway after the grace period", () => {
		const r = rig("b");
		r.flags.draft = "fix the thing so that";
		sender().send("b", "x");
		expect(r.board.drain()).toBe("deferred");
		clock += DRAFT_GRACE_MS + 1;
		expect(r.board.drain()).toBe("delivered");
	});

	it("ignores a draft for a no-wake message and while busy", () => {
		const r = rig("b");
		r.flags.draft = "typing";
		sender().send("b", "quiet", false);
		expect(r.board.drain()).toBe("delivered");
		r.flags.idle = false;
		sender().send("b", "busy");
		expect(r.board.drain()).toBe("delivered");
	});

	it("stops waking a lane when one sender floods it, but still delivers", () => {
		const r = rig("b");
		const a = sender();
		for (let i = 0; i < MAX_WAKES_PER_MINUTE; i++) {
			a.send("b", `n${i}`);
			r.board.drain();
		}
		a.send("b", "one too many");
		r.board.drain();
		const last = r.delivered.at(-1)!;
		expect(last.trigger).toBe(false);
		expect(r.notes.some((n) => n.includes("sending a lot"))).toBe(true);
		expect(readInbox(root, "b")).toEqual([]);
		// A minute later the budget is back.
		clock += 61_000;
		a.send("b", "fresh");
		r.board.drain();
		expect(r.delivered.at(-1)!.trigger).toBe(true);
	});
});

describe("topics end to end", () => {
	it("a waiting lane wakes on a post from another lane", () => {
		const r = rig("b");
		const a = sender();
		r.board.wait(["task:42-done"]);
		const posted = a.post("task:42-done", "merged");
		expect("notified" in posted && posted.notified).toEqual(["b"]);
		r.board.drain();
		expect(r.delivered[0]!.text).toContain('topic="task:42-done"');
		expect(r.wakes[0]!.topics).toEqual(["task:42-done"]);
	});

	it("a lane that posts before the other waits is still satisfied", () => {
		const a = sender();
		a.post("task:42-done", "merged");
		const r = rig("b");
		const w = r.board.wait(["task:42-done"]);
		expect("replayed" in w && w.replayed).toHaveLength(1);
	});

	it("an offline lane's messages wait for the next session that claims the name", () => {
		const a = sender();
		const first = rig("b");
		first.board.stop();
		expect(a.send("b", "while you were out")).toMatchObject({ ok: true, delivered: "queued-unknown" });
		const second = rig("b");
		vi.advanceTimersByTime(10);
		expect(second.delivered).toHaveLength(1);
		expect(second.delivered[0]!.text).toContain("while you were out");
	});

	it("refuses to act when not started", () => {
		const board = new Board({
			root,
			deliver: () => undefined,
			isIdle: () => true,
			hasPending: () => false,
			isBlocked: () => false,
			draft: () => "",
			notify: () => undefined,
		});
		expect(board.send("x", "y")).toMatchObject({ ok: false });
		expect(board.post("x", "y")).toMatchObject({ ok: false });
		expect(board.wait(["x"])).toMatchObject({ ok: false });
		expect(board.rename("z")).toMatchObject({ ok: false });
		expect(board.drain()).toBe("empty");
	});
});
