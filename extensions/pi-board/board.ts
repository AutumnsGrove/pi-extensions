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
 * - the sender is not flooding. Past `MAX_WAKES_PER_MINUTE` from one sender the
 *   message is still delivered, but queued for the next turn instead of starting
 *   one, so two lanes cannot ping-pong forever on someone's bill.
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
export const HEARTBEAT_MS = 20_000;
export const DRAFT_GRACE_MS = 60_000;
export const MAX_WAKES_PER_MINUTE = 6;

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
		this.timers.poll = setInterval(() => this.scheduleDrain(0), POLL_MS);
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
			// Someone else took our lane file (we were suspended long enough to go stale).
			// Take it back if it is free; otherwise pick a new name.
			const { lane, heartbeatAt: _beat, ...rest } = this.info;
			const claim = claimFreeLane(this.root, lane, { ...rest, state: this.state }, this.now());
			if (claim.ok) {
				if (claim.lane !== lane) this.deps.notify(`board: lane "${lane}" was taken, now "${claim.lane}"`);
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
			this.drain();
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
		const inbox = readInbox(this.root, this.info.lane).filter((message) => !this.seen.has(message.id));
		if (inbox.length === 0) {
			this.paint();
			return "empty";
		}
		for (const message of inbox) if (!this.firstSeen.has(message.id)) this.firstSeen.set(message.id, now);

		const wantsWake = inbox.some((message) => message.wake);
		if (this.deps.isBlocked()) return "deferred";

		if (wantsWake) {
			const draft = this.deps.draft().trim();
			const oldest = Math.min(...inbox.map((message) => this.firstSeen.get(message.id) ?? now));
			if (draft && this.deps.isIdle() && now - oldest < DRAFT_GRACE_MS) return "deferred";
		}

		const throttled = this.throttle(inbox, now);
		const trigger = wantsWake && !throttled;
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
		ackMessages(
			this.root,
			this.info.lane,
			inbox.map((message) => message.id),
		);
		for (const message of inbox) this.firstSeen.delete(message.id);
		if (throttled) {
			this.deps.notify(`board: ${throttled} is sending a lot of messages; queued for your next turn instead of waking you`);
		}
		this.deps.onWake?.({
			count: inbox.length,
			from: [...new Set(inbox.map((message) => message.from))],
			topics: [...new Set(inbox.flatMap((message) => (message.topic ? [message.topic] : [])))],
			summary: summarizeBatch(inbox),
		});
		this.paint();
		return "delivered";
	}

	/** The sender over the wake budget, if any. Records this batch's wakes. */
	private throttle(batch: BoardMessage[], now: number): string | undefined {
		let over: string | undefined;
		for (const sender of new Set(batch.filter((message) => message.wake).map((message) => message.from))) {
			const recent = (this.wakes.get(sender) ?? []).filter((at) => now - at < 60_000);
			if (recent.length >= MAX_WAKES_PER_MINUTE) over ??= sender;
			recent.push(now);
			this.wakes.set(sender, recent);
		}
		return over;
	}
}

export function laneFor(lane: string | undefined, root: string): LaneInfo | undefined {
	return lane ? readLane(root, lane) : undefined;
}
