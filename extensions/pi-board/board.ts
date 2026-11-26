/**
 * The board controller: presence, receiving, and the rules for when a message
 * may start a turn. `index.ts` wires it to pi; every pi-facing call arrives
 * through `BoardDeps`, so the wake rules can be tested without a TUI.
 *
 * A message waits in the lane's inbox until it is safe to hand over. It is safe
 * when:
 *
 * - no blocking question is open (`pi-q-n-a` owns the session while its form is up);
 * - the editor holds no half-written draft, or the draft has sat for `DRAFT_GRACE_MS`
 *   (a leftover line must not stop a lane from ever waking);
 * - the sender is not flooding. Past `MAX_WAKES_PER_MINUTE` from one sender its
 *   waking messages are held in the inbox, not dropped, and delivered when the
 *   minute's budget frees up, so two lanes cannot ping-pong forever on someone's
 *   bill and a parked lane still gets what it was waiting for.
 *
 * Delivery while the agent is running is a follow-up: it lands after the
 * current work and never interrupts an edit.
 */

import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { formatWake, summarizeBatch } from "./format.ts";
import {
	ackMessages,
	boardRoot,
	claimFreeLane,
	claimLane,
	clearWaits,
	heartbeat,
	listLanes,
	moveWaits,
	postTopic,
	readInbox,
	readLane,
	readWaits,
	releaseLane,
	safeName,
	sendDirect,
	waitOn,
	type BoardMessage,
	type LaneInfo,
	type LaneState,
	type PostResult,
	type SendResult,
	type WaitResult,
} from "./store.ts";

export const COALESCE_MS = 800;
export const POLL_MS = 3_000;
/** How soon to look again after holding a wake for a draft; independent of the poll so a watcher-only setup still retries. */
export const DRAFT_RETRY_MS = 2_000;

/** `PI_BOARD_POLL_MS` overrides the poll interval (tests use a huge value to prove the watcher alone works). */
export function pollInterval(env: NodeJS.ProcessEnv = process.env): number {
	const value = Number(env.PI_BOARD_POLL_MS);
	return Number.isFinite(value) && value >= 250 ? value : POLL_MS;
}
export const HEARTBEAT_MS = 20_000;
export const DRAFT_GRACE_MS = 60_000;
export const MAX_WAKES_PER_MINUTE = 6;
const WAKE_WINDOW_MS = 60_000;

export interface BoardDeps {
	root?: string;
	now?: () => number;
	/** Hand a wake to the agent. */
	deliver(input: { text: string; trigger: boolean; busy: boolean; messages: BoardMessage[] }): void;
	isIdle(): boolean;
	hasPending(): boolean;
	isBlocked(): boolean;
	/** Text in the editor, or "" when none or unknown. */
	draft(): string;
	notify(text: string): void;
	onWake?(summary: { count: number; from: string[]; topics: string[]; summary: string }): void;
	onStatus?(text: string | undefined): void;
}

export interface BoardStart {
	desiredLane: string;
	cwd: string;
	branch?: string;
	sessionId?: string;
	tty: boolean;
	ttyPath?: string;
}

export class Board {
	readonly root: string;
	private readonly deps: BoardDeps;
	private info: LaneInfo | undefined;
	private state: LaneState = "idle";
	private seen = new Set<string>();
	private firstSeen = new Map<string, number>();
	private wakes = new Map<string, number[]>();
	/** Senders the user has already been told about, so a flood is announced once. */
	private announced = new Set<string>();
	private rulesSent = false;
	private timers: { poll?: ReturnType<typeof setInterval>; beat?: ReturnType<typeof setInterval>; drain?: ReturnType<typeof setTimeout> } = {};
	private watcher: { close(): void } | undefined;

	constructor(deps: BoardDeps) {
		this.deps = deps;
		this.root = deps.root ?? boardRoot();
	}

	private now(): number {
		return this.deps.now ? this.deps.now() : Date.now();
	}

	get lane(): string | undefined {
		return this.info?.lane;
	}

	get active(): boolean {
		return this.info !== undefined;
	}

	/** Claim a lane and begin listening. Returns the lane name actually granted. */
	start(input: BoardStart, startWatcher?: (dir: string, onChange: () => void) => { close(): void }): string {
		const base = safeName(input.desiredLane) || "lane";
		const claim = claimFreeLane(
			this.root,
			base,
			{
				pid: process.pid,
				host: hostname(),
				tty: input.tty,
				...(input.ttyPath ? { ttyPath: input.ttyPath } : {}),
				cwd: input.cwd,
				...(input.branch ? { branch: input.branch } : {}),
				...(input.sessionId ? { sessionId: input.sessionId } : {}),
				startedAt: this.now(),
				state: this.state,
			},
			this.now(),
		);
		if (!claim.ok) throw new Error(claim.reason);
		this.info = claim.info;
		this.timers.beat = setInterval(() => this.beat(), HEARTBEAT_MS);
		this.timers.poll = setInterval(() => this.scheduleDrain(0), pollInterval());
		this.timers.beat.unref?.();
		this.timers.poll.unref?.();
		if (startWatcher) {
			try {
				mkdirSync(`${this.root}/inbox/${claim.lane}`, { recursive: true, mode: 0o700 });
				this.watcher = startWatcher(`${this.root}/inbox/${claim.lane}`, () => this.scheduleDrain(COALESCE_MS));
			} catch {
				// fs.watch is not available everywhere; the poll covers it.
			}
		}
		this.paint();
		this.scheduleDrain(0);
		return claim.lane;
	}

	/** Rename the lane: claim the new name first so a clash leaves the old one intact. */
	rename(name: string): { ok: true; lane: string } | { ok: false; reason: string } {
		if (!this.info) return { ok: false, reason: "board is not active in this session" };
		const next = safeName(name);
		if (!next) return { ok: false, reason: "lane name is empty" };
		if (next === this.info.lane) return { ok: true, lane: next };
		const { lane: old, heartbeatAt: _beat, ...rest } = this.info;
		const claim = claimLane(this.root, next, { ...rest, state: this.state }, this.now());
		if (!claim.ok) return claim;
		// The waits belong to this session, not to the name it used to answer to.
		moveWaits(this.root, old, next);
		releaseLane(this.root, old, process.pid);
		this.info = claim.info;
		this.paint();
		return { ok: true, lane: next };
	}

	stop(options: { keepLane?: boolean } = {}): void {
		for (const handle of [this.timers.poll, this.timers.beat]) if (handle) clearInterval(handle);
		if (this.timers.drain) clearTimeout(this.timers.drain);
		this.timers = {};
		this.watcher?.close();
		this.watcher = undefined;
		if (this.info && !options.keepLane) releaseLane(this.root, this.info.lane, process.pid);
		this.info = undefined;
		this.deps.onStatus?.(undefined);
	}

	setState(state: LaneState): void {
		this.state = state;
		this.beat();
		if (state === "idle") this.scheduleDrain(0);
	}

	/** Re-run delivery soon, for a caller that knows the gate just opened (a blocker released). */
	nudge(): void {
		this.scheduleDrain(0);
	}

	private beat(): void {
		if (!this.info) return;
		const ok = heartbeat(this.root, this.info.lane, process.pid, { state: this.state }, this.now());
		if (!ok) {
			// Someone else took our lane file (we were suspended long enough to go stale,
			// or two sessions started at once). Take it back if it is free; otherwise pick
			// a new name and take the waits with us, or this session would never wake again.
			const { lane, heartbeatAt: _beat, ...rest } = this.info;
			const claim = claimFreeLane(this.root, lane, { ...rest, state: this.state }, this.now());
			if (claim.ok) {
				if (claim.lane !== lane) {
					moveWaits(this.root, lane, claim.lane);
					this.deps.notify(`board: lane "${lane}" was taken, now "${claim.lane}"`);
				}
				this.info = claim.info;
				this.paint();
			}
		}
	}

	private paint(): void {
		if (!this.info) return;
		const pending = readInbox(this.root, this.info.lane).length;
		const waits = readWaits(this.root, this.info.lane);
		const parts = [`board:${this.info.lane}`];
		if (waits && waits.topics.length > 0) parts.push(`waiting on ${waits.topics.length}`);
		if (pending > 0) parts.push(`${pending} unread`);
		this.deps.onStatus?.(parts.join(" · "));
	}

	private scheduleDrain(delayMs: number): void {
		if (!this.info) return;
		if (this.timers.drain) clearTimeout(this.timers.drain);
		this.timers.drain = setTimeout(() => {
			this.timers.drain = undefined;
			// A delivery that throws (a stale context after a session swap, say) must stay
			// in the inbox for the next attempt, never escape a timer as an uncaught error.
			try {
				this.drain();
			} catch (error) {
				try {
					this.deps.notify(`board: could not deliver a message (${error instanceof Error ? error.message : String(error)})`);
				} catch {
					// The UI may be gone too.
				}
			}
		}, delayMs);
		this.timers.drain.unref?.();
	}

	// -- sending ---------------------------------------------------------------

	send(to: string, body: string, wake = true): SendResult {
		if (!this.info) return { ok: false, reason: "board is not active in this session" };
		return sendDirect(this.root, { from: this.info.lane, to, body, wake }, this.now());
	}

	post(topic: string, body: string, wake = true): PostResult | { ok: false; reason: string } {
		if (!this.info) return { ok: false, reason: "board is not active in this session" };
		return postTopic(this.root, { from: this.info.lane, topic, body, wake }, this.now());
	}

	wait(topics: string[], persistent = false): WaitResult | { ok: false; reason: string } {
		if (!this.info) return { ok: false, reason: "board is not active in this session" };
		const result = waitOn(this.root, { lane: this.info.lane, topics, persistent }, this.now());
		this.paint();
		return result;
	}

	stopWaiting(): void {
		if (this.info) clearWaits(this.root, this.info.lane);
		this.paint();
	}

	lanes(): LaneInfo[] {
		return listLanes(this.root);
	}

	// -- receiving -------------------------------------------------------------

	/**
	 * Hand every deliverable message to the agent as one batch. Exposed for tests;
	 * in a session it runs from the watcher, the poll, and state changes.
	 */
	drain(): "delivered" | "empty" | "deferred" {
		if (!this.info) return "empty";
		const now = this.now();
		const all = readInbox(this.root, this.info.lane);
		// A file we already handed over but could not remove (the ack failed, or a copy came
		// back) is cleaned up, never delivered twice.
		const repeats = all.filter((message) => this.seen.has(message.id));
		if (repeats.length > 0) {
			ackMessages(
				this.root,
				this.info.lane,
				repeats.map((message) => message.id),
			);
		}
		const pending = all.filter((message) => !this.seen.has(message.id));
		if (pending.length === 0) {
			this.paint();
			return "empty";
		}
		for (const message of pending) if (!this.firstSeen.has(message.id)) this.firstSeen.set(message.id, now);

		if (this.deps.isBlocked()) return "deferred";

		if (pending.some((message) => message.wake)) {
			const draft = this.deps.draft().trim();
			const oldest = Math.min(...pending.map((message) => this.firstSeen.get(message.id) ?? now));
			if (draft && this.deps.isIdle() && now - oldest < DRAFT_GRACE_MS) {
				this.scheduleDrain(DRAFT_RETRY_MS);
				return "deferred";
			}
		}

		// A flooding sender is rate limited, not silenced: its waking messages stay in the
		// inbox until the minute's budget frees up. Delivering them without a turn would
		// lose them for a parked lane, which has no next turn, and a topic's one-shot wait
		// is already spent.
		const held = this.heldSenders(pending, now);
		const inbox = pending.filter((message) => !(message.wake && held.has(message.from)));
		if (held.size > 0) {
			this.scheduleDrain(this.retryDelay(held, now));
			for (const sender of held) {
				if (this.announced.has(sender)) continue;
				this.announced.add(sender);
				this.deps.notify(`board: ${sender} is sending a lot of messages; holding them for up to a minute instead of waking you`);
			}
		}
		if (inbox.length === 0) return "deferred";
		for (const sender of [...this.announced]) if (!held.has(sender)) this.announced.delete(sender);

		const trigger = inbox.some((message) => message.wake);
		const busy = !this.deps.isIdle() || this.deps.hasPending();
		const text = formatWake(inbox, !this.rulesSent);

		// Ack before handing over would lose a message on a crash; ack after, and
		// remember the ids so a slow ack cannot deliver the same message twice.
		for (const message of inbox) this.seen.add(message.id);
		try {
			this.deps.deliver({ text, trigger, busy, messages: inbox });
		} catch (error) {
			for (const message of inbox) this.seen.delete(message.id);
			throw error;
		}
		this.rulesSent = true;
		this.recordWakes(inbox, now);
		ackMessages(
			this.root,
			this.info.lane,
			inbox.map((message) => message.id),
		);
		for (const message of inbox) this.firstSeen.delete(message.id);
		this.deps.onWake?.({
			count: inbox.length,
			from: [...new Set(inbox.map((message) => message.from))],
			topics: [...new Set(inbox.flatMap((message) => (message.topic ? [message.topic] : [])))],
			summary: summarizeBatch(inbox),
		});
		this.paint();
		return held.size > 0 ? "deferred" : "delivered";
	}

	/** Senders already at the wake budget for the last minute. */
	private heldSenders(batch: BoardMessage[], now: number): Set<string> {
		const held = new Set<string>();
		for (const sender of new Set(batch.filter((message) => message.wake).map((message) => message.from))) {
			if (this.recentWakes(sender, now).length >= MAX_WAKES_PER_MINUTE) held.add(sender);
		}
		return held;
	}

	private recentWakes(sender: string, now: number): number[] {
		return (this.wakes.get(sender) ?? []).filter((at) => now - at < WAKE_WINDOW_MS);
	}

	/** One wake per sender per delivery, however many messages it carried. */
	private recordWakes(delivered: BoardMessage[], now: number): void {
		for (const sender of new Set(delivered.filter((message) => message.wake).map((message) => message.from))) {
			this.wakes.set(sender, [...this.recentWakes(sender, now), now]);
		}
	}

	/** Milliseconds until the first held sender has budget again, plus a little slack. */
	private retryDelay(held: Set<string>, now: number): number {
		let soonest = WAKE_WINDOW_MS;
		for (const sender of held) {
			const recent = this.recentWakes(sender, now);
			const oldest = recent[0];
			if (oldest !== undefined) soonest = Math.min(soonest, oldest + WAKE_WINDOW_MS - now);
		}
		return Math.max(50, soonest + 50);
	}
}

export function laneFor(lane: string | undefined, root: string): LaneInfo | undefined {
	return lane ? readLane(root, lane) : undefined;
}
