/**
 * The board's store: plain files, no daemon.
 *
 * ```
 * <root>/lanes/<lane>.json          presence: pid, host, tty, cwd, heartbeat, state
 * <root>/inbox/<lane>/<seq>.json    one pending message per file
 * <root>/topics/<topic>/<seq>.json  posted events, kept for a while so a late waiter can replay
 * <root>/waits/<lane>.json          topics a lane wants to be woken on
 * <root>/log.jsonl                  audit log: who sent what to whom, never the body
 * ```
 *
 * One file per message means a writer never edits a shared file, so there are
 * no locks: a message is written to a temp name and renamed into place, which
 * is atomic on one filesystem, and a reader only ever sees whole messages.
 * Delivery is at-least-once: a receiver removes a message only after it handed
 * it to the agent, and every message has an id so a repeat is recognisable.
 *
 * Everything here is synchronous and takes the root as an argument (or reads
 * `PI_BOARD_DIR`), which keeps it testable and lets a plain Node CLI share it.
 */

import { randomBytes } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	linkSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

/** A lane with no heartbeat for this long is treated as gone, even if its pid exists. */
export const LANE_STALE_MS = 90_000;
/** How long a topic event stays replayable for a waiter that subscribes late. */
export const TOPIC_TTL_MS = 24 * 60 * 60_000;
export const MAX_BODY_CHARS = 20_000;
export const MAX_PENDING_PER_LANE = 200;

export type LaneState = "idle" | "working";

export interface LaneInfo {
	lane: string;
	pid: number;
	host: string;
	tty: boolean;
	ttyPath?: string;
	cwd: string;
	branch?: string;
	sessionId?: string;
	startedAt: number;
	heartbeatAt: number;
	state: LaneState;
}

export interface BoardMessage {
	id: string;
	from: string;
	/** The lane this copy is for. */
	to: string;
	/** Set when the message is a topic event fanned out to a waiter. */
	topic?: string;
	body: string;
	/** False means "queue it for the next turn, do not start one". */
	wake: boolean;
	at: number;
}

export interface TopicEvent {
	id: string;
	from: string;
	topic: string;
	body: string;
	wake: boolean;
	at: number;
}

export interface Waits {
	lane: string;
	topics: string[];
	/** Keep waiting after the first match instead of clearing the topic. */
	persistent: boolean;
	/**
	 * Per-topic watermark: the newest event time this lane has already been handed,
	 * keyed by topic. One number per lane is not enough: a lane that consumed
	 * `build:green` at t+100 would then be blind to a `task:42-done` posted at t+50,
	 * which is still inside the TTL and will never be posted again.
	 */
	since: Record<string, number>;
}

/** Read a watermark map defensively: an older file may hold a single number. */
function marksFrom(since: unknown, now: number): Record<string, number> {
	const out: Record<string, number> = {};
	if (!since || typeof since !== "object") return out;
	for (const [topic, at] of Object.entries(since as Record<string, unknown>)) {
		// An event older than the TTL has been pruned, so its mark is dead weight.
		if (typeof at === "number" && now - at <= TOPIC_TTL_MS) out[topic] = at;
	}
	return out;
}

export function boardRoot(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.PI_BOARD_DIR?.trim();
	if (override) return override.replace(/^~(?=$|\/)/, homedir());
	return join(homedir(), ".pi", "agent", "board");
}

/** Lane and topic names become path segments, so keep them to a safe alphabet. */
export function safeName(value: string): string {
	return value.trim().replace(/[^A-Za-z0-9._:-]+/g, "-").replace(/^[.-]+/, "").slice(0, 64);
}

export function isValidName(value: string): boolean {
	return safeName(value).length > 0 && safeName(value) === value.trim();
}

const laneFile = (root: string, lane: string) => join(root, "lanes", `${safeName(lane)}.json`);
const inboxDir = (root: string, lane: string) => join(root, "inbox", safeName(lane));
const topicDir = (root: string, topic: string) => join(root, "topics", topicDirName(topic));
const waitsFile = (root: string, lane: string) => join(root, "waits", `${safeName(lane)}.json`);

/** Topics contain `:`, which is fine on Linux and macOS; keep it readable on disk. */
const topicDirName = (topic: string) => safeName(topic);

let counter = 0;
/** Sortable, unique across processes: time, then a per-process counter, then entropy. */
export function nextId(now = Date.now()): string {
	const seq = String(counter++ % 1_000_000).padStart(6, "0");
	return `${String(now).padStart(14, "0")}-${seq}-${randomBytes(3).toString("hex")}`;
}

function ensure(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function writeAtomic(path: string, value: unknown): void {
	const tmp = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(tmp, path);
}

/**
 * Create `path` with `value` only if nothing is there. link(2) is the portable
 * atomic test-and-set: it fails with EEXIST instead of overwriting, and the
 * target appears whole or not at all, so a reader never sees half a lane.
 */
function createExclusive(path: string, value: unknown): boolean {
	const tmp = `${path}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
	try {
		linkSync(tmp, path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw error;
	} finally {
		rmSync(tmp, { force: true });
	}
}

function readJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means it exists but belongs to someone else.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Alive means the heartbeat is fresh and, on this host, the pid still exists. */
export function isLaneAlive(lane: LaneInfo, now = Date.now()): boolean {
	if (now - lane.heartbeatAt > LANE_STALE_MS) return false;
	if (lane.host === hostname() && !pidAlive(lane.pid)) return false;
	return true;
}

// -- lanes -------------------------------------------------------------------

export function readLane(root: string, lane: string): LaneInfo | undefined {
	return readJson<LaneInfo>(laneFile(root, lane));
}

export function listLanes(root: string): LaneInfo[] {
	const dir = join(root, "lanes");
	if (!existsSync(dir)) return [];
	const out: LaneInfo[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".json")) continue;
		const info = readJson<LaneInfo>(join(dir, name));
		if (info && typeof info.lane === "string") out.push(info);
	}
	return out.sort((a, b) => a.lane.localeCompare(b.lane));
}

export type ClaimResult = { ok: true; lane: string; info: LaneInfo } | { ok: false; reason: string };

/**
 * Take a lane name. A name held by a live process other than us is refused with
 * a suffix suggestion by the caller; a stale or our own entry is overwritten.
 *
 * A read, a decision and a write are not one step across processes: two lanes
 * starting in the same instant both read "free" and both wrote the same name,
 * which left them sharing one inbox and one waits file until the next beat. The
 * create is exclusive, so only one can win a free name and the loser takes the
 * next one.
 */
export function claimLane(
	root: string,
	desired: string,
	info: Omit<LaneInfo, "lane" | "heartbeatAt">,
	now = Date.now(),
): ClaimResult {
	const lane = safeName(desired);
	if (!lane) return { ok: false, reason: "lane name is empty" };
	ensure(join(root, "lanes"));
	const path = laneFile(root, lane);
	const record: LaneInfo = { ...info, lane, heartbeatAt: now };

	const existing = readLane(root, lane);
	if (existing?.pid === info.pid) {
		// Our own lane: a reload, or taking back a name we let go stale.
		writeAtomic(path, record);
		return { ok: true, lane, info: record };
	}
	if (existing && isLaneAlive(existing, now)) {
		return { ok: false, reason: `lane "${lane}" is held by live pid ${existing.pid}` };
	}
	// Free, or held by a process that is gone. Drop the dead file so the exclusive
	// create below starts from nothing.
	if (existing) rmSync(path, { force: true });
	if (createExclusive(path, record)) return { ok: true, lane, info: record };

	// Something beat us to it. A file that is not a lane record at all (hand-edited,
	// or written by an older version) cannot belong to a live lane, so recover it.
	if (!readLane(root, lane)) {
		rmSync(path, { force: true });
		if (createExclusive(path, record)) return { ok: true, lane, info: record };
	}
	const winner = readLane(root, lane);
	if (winner?.pid === info.pid) return { ok: true, lane, info: record };
	return { ok: false, reason: `lane "${lane}" is held by live pid ${winner?.pid ?? "unknown"}` };
}

/** Pick the first free name: `base`, `base-2`, `base-3`, … */
export function claimFreeLane(
	root: string,
	base: string,
	info: Omit<LaneInfo, "lane" | "heartbeatAt">,
	now = Date.now(),
): ClaimResult {
	for (let n = 1; n <= 50; n++) {
		const name = n === 1 ? base : `${base}-${n}`;
		const result = claimLane(root, name, info, now);
		if (result.ok) return result;
	}
	return { ok: false, reason: `no free lane name near "${base}"` };
}

/**
 * Refresh our heartbeat. Refuses when the file now belongs to another process,
 * so a suspended laptop that woke up cannot overwrite the lane that replaced it.
 */
export function heartbeat(root: string, lane: string, pid: number, patch: Partial<LaneInfo> = {}, now = Date.now()): boolean {
	const current = readLane(root, lane);
	if (!current || current.pid !== pid) return false;
	writeAtomic(laneFile(root, lane), { ...current, ...patch, lane: current.lane, pid, heartbeatAt: now });
	return true;
}

export function releaseLane(root: string, lane: string, pid: number): void {
	const current = readLane(root, lane);
	if (current && current.pid !== pid) return;
	rmSync(laneFile(root, lane), { force: true });
	rmSync(waitsFile(root, lane), { force: true });
}

/**
 * Carry a lane's waiting topics to its new name. A rename and a re-claim are both
 * the same session continuing, so its waits must follow it: left behind, they
 * point at a lane nobody holds, every post fans out to a dead inbox, and the
 * session that registered them never wakes again — silently.
 */
export function moveWaits(root: string, from: string, to: string): void {
	if (safeName(from) === safeName(to)) return;
	const waits = readWaits(root, from);
	if (!waits) return;
	ensure(join(root, "waits"));
	writeAtomic(waitsFile(root, to), { ...waits, lane: safeName(to) });
	rmSync(waitsFile(root, from), { force: true });
}

// -- sending -----------------------------------------------------------------

export type SendResult =
	| { ok: true; id: string; delivered: "live" | "queued-offline" | "queued-unknown" }
	| { ok: false; reason: string };

function audit(root: string, entry: Record<string, unknown>): void {
	try {
		ensure(root);
		appendFileSync(join(root, "log.jsonl"), `${JSON.stringify({ at: Date.now(), ...entry })}\n`, { mode: 0o600 });
	} catch {
		// An audit failure must not lose the message.
	}
}

export function pendingCount(root: string, lane: string): number {
	const dir = inboxDir(root, lane);
	if (!existsSync(dir)) return 0;
	return readdirSync(dir).filter((name) => name.endsWith(".json")).length;
}

function dropMessage(root: string, message: BoardMessage): void {
	const dir = inboxDir(root, message.to);
	ensure(dir);
	writeAtomic(join(dir, `${message.id}.json`), message);
}

/**
 * Send a direct message. An offline lane still gets the file: it is delivered
 * when a session next claims that name. An unknown lane is allowed too (the
 * recipient may simply not have started yet) but the result says so.
 */
export function sendDirect(
	root: string,
	input: { from: string; to: string; body: string; wake?: boolean },
	now = Date.now(),
): SendResult {
	const to = safeName(input.to);
	if (!to) return { ok: false, reason: "recipient lane name is empty" };
	if (input.body.length === 0) return { ok: false, reason: "message body is empty" };
	if (input.body.length > MAX_BODY_CHARS) return { ok: false, reason: `message is over ${MAX_BODY_CHARS} characters` };
	if (pendingCount(root, to) >= MAX_PENDING_PER_LANE) {
		return { ok: false, reason: `lane "${to}" already has ${MAX_PENDING_PER_LANE} unread messages` };
	}
	const lane = readLane(root, to);
	const delivered = !lane ? "queued-unknown" : isLaneAlive(lane, now) ? "live" : "queued-offline";
	const message: BoardMessage = {
		id: nextId(now),
		from: safeName(input.from) || "unknown",
		to,
		body: input.body,
		wake: input.wake !== false,
		at: now,
	};
	dropMessage(root, message);
	audit(root, { kind: "send", id: message.id, from: message.from, to, wake: message.wake, bytes: input.body.length });
	return { ok: true, id: message.id, delivered };
}

// -- topics and waits --------------------------------------------------------

/** `task:*` matches `task:42-done`. Only `*` is special, so a topic cannot smuggle a regex. */
export function topicMatches(pattern: string, topic: string): boolean {
	if (pattern === topic) return true;
	if (!pattern.includes("*")) return false;
	const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`).test(topic);
}

export function readWaits(root: string, lane: string): Waits | undefined {
	return readJson<Waits>(waitsFile(root, lane));
}

export function listWaits(root: string): Waits[] {
	const dir = join(root, "waits");
	if (!existsSync(dir)) return [];
	const out: Waits[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".json")) continue;
		const waits = readJson<Waits>(join(dir, name));
		if (waits && Array.isArray(waits.topics)) out.push(waits);
	}
	return out;
}

export function listTopicEvents(root: string, topic: string, sinceMs = 0): TopicEvent[] {
	const dir = topicDir(root, topic);
	if (!existsSync(dir)) return [];
	const out: TopicEvent[] = [];
	for (const name of readdirSync(dir).sort()) {
		if (!name.endsWith(".json")) continue;
		const event = readJson<TopicEvent>(join(dir, name));
		if (event && event.at >= sinceMs) out.push(event);
	}
	return out;
}

/** Every topic directory that exists, as the original topic names recorded in events. */
export function listTopics(root: string): string[] {
	const dir = join(root, "topics");
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory());
}

export interface PostResult {
	id: string;
	/** Lanes that received a copy. */
	notified: string[];
}

/**
 * Publish a topic event. It is recorded for replay and fanned out to the inbox
 * of every lane currently waiting on a matching topic (waiters are one-shot per
 * topic unless persistent). The poster never receives its own event.
 */
export function postTopic(
	root: string,
	input: { from: string; topic: string; body: string; wake?: boolean },
	now = Date.now(),
): PostResult | { ok: false; reason: string } {
	const topic = safeName(input.topic);
	if (!topic) return { ok: false, reason: "topic is empty" };
	if (input.body.length > MAX_BODY_CHARS) return { ok: false, reason: `message is over ${MAX_BODY_CHARS} characters` };
	const from = safeName(input.from) || "unknown";
	const event: TopicEvent = { id: nextId(now), from, topic, body: input.body, wake: input.wake !== false, at: now };
	const dir = topicDir(root, topic);
	ensure(dir);
	writeAtomic(join(dir, `${event.id}.json`), event);
	pruneTopic(root, topic, now);

	const notified: string[] = [];
	for (const waits of listWaits(root)) {
		if (waits.lane === from) continue;
		const matched = waits.topics.filter((pattern) => topicMatches(pattern, topic));
		if (matched.length === 0) continue;
		if (pendingCount(root, waits.lane) >= MAX_PENDING_PER_LANE) continue;
		dropMessage(root, {
			id: nextId(now),
			from,
			to: waits.lane,
			topic,
			body: input.body,
			wake: event.wake,
			at: now,
		});
		notified.push(waits.lane);
		// The lane has been handed this event, so record it as handed over: this is the
		// normal path (register, then someone posts), and a mark kept only on replay left
		// the same `task finished` event ready to be delivered again on the next wait.
		const since = marksFrom(waits.since, now);
		since[topic] = Math.max(since[topic] ?? 0, event.at);
		// Keep the file even when the last pattern is spent, so the mark survives it.
		const remaining = waits.persistent ? waits.topics : waits.topics.filter((pattern) => !matched.includes(pattern));
		writeAtomic(waitsFile(root, waits.lane), { ...waits, topics: remaining, since });
	}
	audit(root, { kind: "post", id: event.id, from, topic, notified, bytes: input.body.length });
	return { id: event.id, notified };
}

function pruneTopic(root: string, topic: string, now: number): void {
	const dir = topicDir(root, topic);
	for (const name of readdirSync(dir)) {
		const stamp = Number(name.slice(0, 14));
		if (Number.isFinite(stamp) && now - stamp > TOPIC_TTL_MS) rmSync(join(dir, name), { force: true });
	}
}

export interface WaitResult {
	/** Events that already existed and are returned now. */
	replayed: TopicEvent[];
	/** Patterns still registered, i.e. not satisfied by a replay. */
	waitingOn: string[];
}

/**
 * Register interest in topics. Events posted before this call (within the TTL,
 * from any lane but our own) satisfy the wait immediately, which closes the race
 * where the other lane finishes before this one subscribes.
 *
 * Replay stops at the per-topic watermark so a topic is handed over once, and only
 * that topic is filtered: a lane that was already handed an event on one topic can
 * still be handed an older one on another.
 */
export function waitOn(
	root: string,
	input: { lane: string; topics: string[]; persistent?: boolean; replay?: boolean },
	now = Date.now(),
): WaitResult {
	const lane = safeName(input.lane);
	const patterns = [...new Set(input.topics.map((topic) => topic.trim()).filter(Boolean))];
	const replayed: TopicEvent[] = [];
	const waitingOn: string[] = [];
	const replay = input.replay !== false;
	const wanted = readWaits(root, lane);
	const floor = now - TOPIC_TTL_MS;
	const marks = marksFrom(wanted?.since, now);

	for (const pattern of patterns) {
		let hit = false;
		if (replay) {
			for (const topic of topicsMatching(root, pattern)) {
				// One millisecond past this topic's mark: an event at the mark itself was handed over already.
				const mark = marks[topic] ?? 0;
				for (const event of listTopicEvents(root, topic, mark > floor ? mark + 1 : floor)) {
					if (event.from === lane || replayed.some((seen) => seen.id === event.id)) continue;
					replayed.push(event);
					hit = true;
				}
			}
		}
		if (!hit || input.persistent) waitingOn.push(pattern);
	}

	for (const event of replayed) marks[event.topic] = Math.max(marks[event.topic] ?? 0, event.at);

	// A pattern satisfied by a replay was asked for and answered, so drop it from the
	// registry instead of leaving it to fan out the next post as well.
	const answered = new Set(patterns.filter((pattern) => !waitingOn.includes(pattern)));
	const merged = [...new Set([...(wanted?.topics ?? []), ...waitingOn])].filter((pattern) => !answered.has(pattern));
	if (merged.length > 0 || Object.keys(marks).length > 0) {
		ensure(join(root, "waits"));
		writeAtomic(waitsFile(root, lane), {
			lane,
			topics: merged,
			persistent: input.persistent === true || wanted?.persistent === true,
			since: marks,
		} satisfies Waits);
	}
	return { replayed, waitingOn };
}

/** Topic directories matching a pattern, by their recorded topic name. */
function topicsMatching(root: string, pattern: string): string[] {
	if (!pattern.includes("*")) return existsSync(topicDir(root, pattern)) ? [pattern] : [];
	return listTopics(root).filter((name) => topicMatches(pattern, name));
}

export function clearWaits(root: string, lane: string): void {
	rmSync(waitsFile(root, lane), { force: true });
}

// -- receiving ---------------------------------------------------------------

/** Pending messages for a lane, oldest first. Unreadable files are skipped, never thrown. */
export function readInbox(root: string, lane: string): BoardMessage[] {
	const dir = inboxDir(root, lane);
	if (!existsSync(dir)) return [];
	const out: BoardMessage[] = [];
	for (const name of readdirSync(dir).sort()) {
		if (!name.endsWith(".json")) continue;
		const message = readJson<BoardMessage>(join(dir, name));
		if (message && typeof message.id === "string" && typeof message.body === "string") out.push(message);
	}
	return out;
}

/** Remove delivered messages. Call only after handing them to the agent. */
export function ackMessages(root: string, lane: string, ids: string[]): void {
	const dir = inboxDir(root, lane);
	for (const id of ids) rmSync(join(dir, `${id}.json`), { force: true });
}
