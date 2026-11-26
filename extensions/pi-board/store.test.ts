import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	LANE_STALE_MS,
	TOPIC_TTL_MS,
	ackMessages,
	claimFreeLane,
	clearWaits,
	claimLane,
	heartbeat,
	isLaneAlive,
	isValidName,
	listLanes,
	listWaits,
	moveWaits,
	nextId,
	postTopic,
	readInbox,
	readLane,
	readWaits,
	releaseLane,
	safeName,
	sendDirect,
	topicMatches,
	waitOn,
	type LaneInfo,
} from "./store.ts";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pi-board-store-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const info = (over: Record<string, unknown> = {}) => ({
	pid: process.pid,
	host: hostname(),
	tty: true,
	cwd: "/work",
	startedAt: 1,
	state: "idle" as const,
	...over,
});

describe("names", () => {
	it("keeps names path-safe", () => {
		expect(safeName("../../etc/passwd")).toBe("etc-passwd");
		expect(safeName("lane auth")).toBe("lane-auth");
		expect(safeName("task:42-done")).toBe("task:42-done");
		expect(isValidName("task:42-done")).toBe(true);
		expect(isValidName("a b")).toBe(false);
	});
	it("matches topic patterns with only * special", () => {
		expect(topicMatches("task:*-done", "task:42-done")).toBe(true);
		expect(topicMatches("task:*-done", "task:42-open")).toBe(false);
		expect(topicMatches("a.b", "aXb")).toBe(false);
		expect(topicMatches("(x+)+", "xxxx")).toBe(false);
	});
	it("makes sortable unique ids", () => {
		const ids = Array.from({ length: 50 }, () => nextId(1000));
		expect(new Set(ids).size).toBe(50);
		expect([...ids].sort()).toEqual(ids);
	});
});

describe("lanes", () => {
	it("claims, lists, and releases a lane", () => {
		const claim = claimLane(root, "auth", info());
		expect(claim.ok).toBe(true);
		expect(listLanes(root).map((l) => l.lane)).toEqual(["auth"]);
		releaseLane(root, "auth", process.pid);
		expect(listLanes(root)).toEqual([]);
	});

	it("refuses a name held by a live process and takes a stale one", () => {
		const t = 1_000_000;
		claimLane(root, "auth", info({ pid: process.pid }), t);
		// Same host, different pid that is alive (our parent) and fresh: refused.
		const other = claimLane(root, "auth", info({ pid: process.ppid }), t + 1000);
		expect(other.ok).toBe(false);
		// Heartbeat gone stale: the name is free.
		const taken = claimLane(root, "auth", info({ pid: process.ppid }), t + LANE_STALE_MS + 1);
		expect(taken.ok).toBe(true);
	});

	it("takes a name whose pid is dead even when the heartbeat is fresh", () => {
		claimLane(root, "auth", info({ pid: 2_147_483_000 }), 5);
		const taken = claimLane(root, "auth", info({ pid: process.pid }), 6);
		expect(taken.ok).toBe(true);
	});

	it("gives simultaneous claimants different lanes", async () => {
		// Two sessions starting at the same instant both read "free" and both wrote the
		// same name before the create was exclusive, so they shared one inbox and one
		// waits file until the next beat. Real processes, because the bug is a race.
		const script = join(root, "claimer.mjs");
		writeFileSync(
			script,
			`import { claimFreeLane } from ${JSON.stringify(new URL("./store.ts", import.meta.url).href)};
import { hostname } from "node:os";
const [, , startAt] = process.argv;
const started = Date.now();
while (Date.now() < Number(startAt)) {}
const r = claimFreeLane(process.env.BOARD_ROOT, "shared", { pid: process.pid, host: hostname(), tty: true, cwd: "/", startedAt: started, state: "idle" });
process.stdout.write((r.ok ? r.lane : "REFUSED") + "\\n");
// Stay alive so our lane looks alive to the claimants that run after us.
setTimeout(() => process.exit(0), 900);`,
		);
		const claimants = 6;
		const startAt = Date.now() + 900;
		const granted = await Promise.all(
			Array.from({ length: claimants }, () => {
				const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", script, String(startAt)], {
					env: { ...process.env, BOARD_ROOT: root },
					stdio: ["ignore", "pipe", "ignore"],
				});
				let out = "";
				child.stdout.setEncoding("utf8");
				child.stdout.on("data", (chunk) => {
					out += chunk;
				});
				return new Promise<string>((resolve) => child.on("close", () => resolve(out.trim())));
			}),
		);
		expect(granted.filter((lane) => lane === "REFUSED")).toEqual([]);
		expect(new Set(granted).size).toBe(claimants);
	});

	it("recovers a lane file that is not a lane record", () => {
		mkdirSync(join(root, "lanes"), { recursive: true });
		writeFileSync(join(root, "lanes", "auth.json"), "{ half a fi");
		// It cannot belong to a live lane, so it must not lock the name out for good.
		expect(claimLane(root, "auth", info())).toMatchObject({ ok: true, lane: "auth" });
		expect(readLane(root, "auth")?.pid).toBe(process.pid);
	});

	it("falls back to a numbered name", () => {
		claimLane(root, "auth", info({ pid: process.ppid }));
		const next = claimFreeLane(root, "auth", info());
		expect(next.ok && next.lane).toBe("auth-2");
	});

	it("only the owner may heartbeat or release", () => {		claimLane(root, "auth", info());
		expect(heartbeat(root, "auth", process.pid + 1)).toBe(false);
		expect(heartbeat(root, "auth", process.pid, { state: "working" })).toBe(true);
		expect(readLane(root, "auth")?.state).toBe("working");
		releaseLane(root, "auth", process.pid + 1);
		expect(readLane(root, "auth")).toBeDefined();
	});

	it("carries a lane's waits to a new name, and only its waits", () => {
		waitOn(root, { lane: "b", topics: ["task:1-done"], persistent: true });
		writeFileSync(join(root, "waits", "c.json"), JSON.stringify({ lane: "c", topics: ["other"], persistent: false, since: 0 }));
		moveWaits(root, "b", "c");
		expect(readWaits(root, "c")?.topics).toEqual(["task:1-done"]);
		expect(readWaits(root, "b")).toBeUndefined();
		// A lane that was not waiting on anything moves nothing, and overwrites nothing.
		moveWaits(root, "auth", "c");
		expect(readWaits(root, "c")?.topics).toEqual(["task:1-done"]);
	});

	it("treats a remote host by heartbeat alone", () => {
		const lane: LaneInfo = { lane: "x", ...info(), host: "elsewhere", pid: 2_147_483_000, heartbeatAt: 10 };
		expect(isLaneAlive(lane, 11)).toBe(true);
		expect(isLaneAlive(lane, 10 + LANE_STALE_MS + 1)).toBe(false);
	});
});

describe("direct messages", () => {
	it("lands whole files in the inbox and acks them", () => {
		claimLane(root, "b", info());
		const sent = sendDirect(root, { from: "a", to: "b", body: "hi" });
		expect(sent).toMatchObject({ ok: true, delivered: "live" });
		const inbox = readInbox(root, "b");
		expect(inbox).toHaveLength(1);
		expect(inbox[0]).toMatchObject({ from: "a", to: "b", body: "hi", wake: true });
		expect(readdirSync(join(root, "inbox", "b")).some((n) => n.endsWith(".tmp"))).toBe(false);
		ackMessages(root, "b", [inbox[0]!.id]);
		expect(readInbox(root, "b")).toEqual([]);
	});

	it("reports offline and unknown recipients but still queues", () => {
		expect(sendDirect(root, { from: "a", to: "ghost", body: "x" })).toMatchObject({ ok: true, delivered: "queued-unknown" });
		claimLane(root, "b", info({ pid: 2_147_483_000 }));
		expect(sendDirect(root, { from: "a", to: "b", body: "x" })).toMatchObject({ ok: true, delivered: "queued-offline" });
	});

	it("rejects empty, oversized, and flooding sends", () => {
		expect(sendDirect(root, { from: "a", to: "b", body: "" }).ok).toBe(false);
		expect(sendDirect(root, { from: "a", to: "b", body: "x".repeat(20_001) }).ok).toBe(false);
		for (let i = 0; i < 200; i++) sendDirect(root, { from: "a", to: "b", body: "x" });
		expect(sendDirect(root, { from: "a", to: "b", body: "x" }).ok).toBe(false);
	});

	it("skips corrupt files instead of throwing", () => {
		mkdirSync(join(root, "inbox", "b"), { recursive: true });
		writeFileSync(join(root, "inbox", "b", "bad.json"), "{nope");
		sendDirect(root, { from: "a", to: "b", body: "ok" });
		expect(readInbox(root, "b").map((m) => m.body)).toEqual(["ok"]);
	});

	it("never writes the body to the audit log", () => {
		sendDirect(root, { from: "a", to: "b", body: "SECRET-BODY" });
		const log = readdirSync(root).includes("log.jsonl");
		expect(log).toBe(true);
		const text = readFileSync(join(root, "log.jsonl"), "utf8");
		expect(text).not.toContain("SECRET-BODY");
		expect(text).toContain('"to":"b"');
	});
});

describe("topics and waits", () => {
	it("fans a post out to waiters and clears one-shot waits", () => {
		waitOn(root, { lane: "b", topics: ["task:42-done"] });
		const result = postTopic(root, { from: "a", topic: "task:42-done", body: "merged" });
		expect("notified" in result && result.notified).toEqual(["b"]);
		expect(readInbox(root, "b")[0]).toMatchObject({ topic: "task:42-done", from: "a", body: "merged" });
		expect(readWaits(root, "b")).toBeUndefined();
	});

	it("keeps persistent waits and supports wildcards", () => {
		waitOn(root, { lane: "b", topics: ["task:*-done"], persistent: true });
		postTopic(root, { from: "a", topic: "task:1-done", body: "1" });
		postTopic(root, { from: "a", topic: "task:2-done", body: "2" });
		expect(readInbox(root, "b").map((m) => m.body)).toEqual(["1", "2"]);
		expect(readWaits(root, "b")?.topics).toEqual(["task:*-done"]);
	});

	it("does not notify the poster, non-matching lanes, or a lane that already consumed its wait", () => {
		waitOn(root, { lane: "a", topics: ["t"] });
		waitOn(root, { lane: "c", topics: ["other"] });
		const first = postTopic(root, { from: "a", topic: "t", body: "x" });
		expect("notified" in first && first.notified).toEqual([]);
		expect(readInbox(root, "c")).toEqual([]);
	});

	it("replays an event posted before the wait, closing the race", () => {
		postTopic(root, { from: "a", topic: "task:42-done", body: "merged", wake: true });
		const result = waitOn(root, { lane: "b", topics: ["task:42-done", "task:43-done"] });
		expect(result.replayed.map((e) => e.body)).toEqual(["merged"]);
		// Satisfied topic is not registered; the unmet one is.
		expect(result.waitingOn).toEqual(["task:43-done"]);
		expect(readWaits(root, "b")?.topics).toEqual(["task:43-done"]);
	});

	it("replays a wildcard against existing topics, but not your own posts or expired ones", () => {
		postTopic(root, { from: "b", topic: "task:1-done", body: "mine" });
		postTopic(root, { from: "a", topic: "task:2-done", body: "theirs" }, 1000);
		const stale = waitOn(root, { lane: "b", topics: ["task:*-done"] }, 1000 + TOPIC_TTL_MS + 5);
		expect(stale.replayed).toEqual([]);
		const fresh = waitOn(root, { lane: "b", topics: ["task:*-done"] }, 2000);
		expect(fresh.replayed.map((e) => e.body)).toEqual(["theirs"]);
	});

	it("hands a topic event over once, not again on every later wait", () => {
		postTopic(root, { from: "a", topic: "task:42-done", body: "merged", wake: true });
		const first = waitOn(root, { lane: "b", topics: ["task:42-done"] });
		const second = waitOn(root, { lane: "b", topics: ["task:42-done"] });
		const third = waitOn(root, { lane: "b", topics: ["task:42-done"] });
		expect(first.replayed.map((e) => e.body)).toEqual(["merged"]);
		// Otherwise a lane that asks again believes an old task just finished again.
		expect(second.replayed).toEqual([]);
		expect(third.replayed).toEqual([]);
	});

	it("keeps the replay watermark even when nothing is left waiting", () => {
		postTopic(root, { from: "a", topic: "task:42-done", body: "merged" });
		waitOn(root, { lane: "b", topics: ["task:42-done"] });
		// A one-shot wait that was satisfied leaves no topics but must keep the mark.
		expect(readWaits(root, "b")).toMatchObject({ topics: [] });
		expect(readWaits(root, "b")?.since).toBeGreaterThan(0);
	});

	it("still replays an event posted after the watermark", () => {
		waitOn(root, { lane: "b", topics: ["task:42-done"] }, 1000);
		clearWaits(root, "b");
		postTopic(root, { from: "a", topic: "task:42-done", body: "late" }, 2000);
		const later = waitOn(root, { lane: "b", topics: ["task:42-done"] }, 3000);
		expect(later.replayed.map((e) => e.body)).toEqual(["late"]);
	});

	it("lists waits and posts with no waiter without error", () => {
		const result = postTopic(root, { from: "a", topic: "nobody", body: "x" });
		expect("notified" in result && result.notified).toEqual([]);
		expect(listWaits(root)).toEqual([]);
	});

	it("rejects an empty topic", () => {
		expect(postTopic(root, { from: "a", topic: "  ", body: "x" })).toEqual({ ok: false, reason: "topic is empty" });
	});
});
