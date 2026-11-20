/**
 * pi-pr-subscribe — subscribe to a pull request and get woken when it changes.
 *
 *   subscribe_pr_activity({})              defaults: origin + the branch's open PR
 *   unsubscribe_pr_activity({})            idempotent, same defaults
 *   /subscribe                             list
 *   /subscribe <n> | owner/repo#<n>        subscribe
 *   /subscribe off [<n>]                   stop
 *   /subscribe status                      cursor, next poll, last error
 *
 * The transport is polling through the user's `gh` login: a laptop has no
 * inbound address, and a relay is real infrastructure for a few seconds of
 * latency. Events arrive as their own turns, wrapped in an `<pr-activity>`
 * envelope that marks GitHub's text as untrusted.
 *
 * The first "event" is the tool result itself (`subscription.created` with the
 * rules of engagement). Sending it as a message on top of the tool result would
 * be the same text twice in one turn, so the rules travel with the data there.
 */

import {
	isBashToolResult,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { isBlocked, onBlockersChange } from "../_shared/blockers.ts";
import { extractPostedIds, extractPostedTarget, targetMatches } from "./capture.ts";
import { initCursor, type Cursor } from "./diff.ts";
import {
	SECOND_SESSION_TEXT,
	formatCompactionReminder,
	formatCreated,
	formatList,
	formatStatus,
	formatWidgetLine,
	type ListEntry,
	type WidgetState,
} from "./format.ts";
import {
	GhApiError,
	fetchSnapshot,
	requiredChecks,
	type Exec,
} from "./gh.ts";
import {
	AUTH_HINT,
	NO_PR_HINT,
	hasGhAuth,
	listRemotes,
	matchesRemote,
	resolvePullForBranch,
	resolveRepo,
	type RepoRef,
} from "./github.ts";
import { apiFor, startPoller, stopPoller, type PollerDeps } from "./poller.ts";
import { prKey, parsePrSpec, type PrRef } from "./ref.ts";
import {
	MAX_SUBSCRIPTIONS,
	acquireLock,
	addSubscription,
	getSubscription,
	listSubscriptions,
	persistedSubscriptions,
	registry,
	releaseLock,
	removeSubscription,
	resetRegistry,
	isPersistedSubscription,
	subscriptionFromPersisted,
	type PersistedSubscription,
	type Subscription,
} from "./registry.ts";
import { SUBSCRIBE_GUIDELINES, UNSUBSCRIBE_GUIDELINES } from "./rules.ts";

const CUSTOM_TYPE = "pi-pr-subscribe";
const ENTRY_TYPE = "pi-pr-subscribe";
const COMMAND = "subscribe";
const WIDGET_KEY = "pi-pr-subscribe";
const UI_TICK_MS = 5_000;
const BLOCKED_RETRY_TICKS = 12;

const SubscribeParams = Type.Object({
	owner: Type.Optional(Type.String({ description: "Repository owner; defaults to the origin remote" })),
	repo: Type.Optional(Type.String({ description: "Repository name; defaults to the origin remote" })),
	pullNumber: Type.Optional(
		Type.Number({ description: "Pull request number; defaults to the current branch's open PR" })
	),
});
type SubscribeArgs = Static<typeof SubscribeParams>;

interface SubscribeDetails {
	owner?: string;
	repo?: string;
	number?: number;
	subscribed: boolean;
	blockedBy?: string;
	reason?: string;
}

function basePollMs(env: NodeJS.ProcessEnv = process.env): number {
	const seconds = Number(env.PI_PR_POLL);
	return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 20_000;
}

/** Text parts of a tool result, joined. */
function resultText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text") {
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string") parts.push(text);
		}
	}
	return parts.join("\n");
}

export default function piPrSubscribe(pi: ExtensionAPI): void {
	const deps: PollerDeps = { cwd: process.cwd(), basePollMs: basePollMs() };
	let currentSessionId = "";
	let uiCtx: ExtensionContext | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;
	let widgetVisible = false;
	let blockedTicks = 0;

	const exec: Exec = (command, args, options) => pi.exec(command, args, options);

	// Everything the pollers call is looked up from the registry, so a `/reload`
	// can replace these closures under a timer that is already running.
	registry().exec = exec;
	registry().deliver = (text) => {
		pi.sendMessage(
			{ customType: CUSTOM_TYPE, content: text, display: true },
			{ triggerTurn: true, deliverAs: "steer" }
		);
	};
	registry().blocked = () => isBlocked();
	registry().persist = () => persist();
	registry().paint = () => paint();

	const notify = (ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info"): void => {
		if (ctx.hasUI) ctx.ui.notify(text, level);
	};

	/** A tool or command can run before `session_start` in tests; bind once here. */
	function bindContext(ctx: ExtensionContext): void {
		currentSessionId = ctx.sessionManager.getSessionId();
		if (ctx.hasUI && ctx.mode === "tui") uiCtx = ctx;
	}

	// ---------------------------------------------------------------------
	// Persistence and the widget
	// ---------------------------------------------------------------------

	function persist(): void {
		if (!currentSessionId) return;
		try {
			pi.appendEntry(ENTRY_TYPE, { subscriptions: persistedSubscriptions(currentSessionId) });
		} catch {
			// A detached or shutting-down session can refuse entries; the cursor in
			// memory is still correct for this process.
		}
	}

	function paint(): void {
		const ctx = uiCtx;
		if (!ctx || !ctx.hasUI || ctx.mode !== "tui") return;
		const subs = listSubscriptions(currentSessionId);
		if (subs.length === 0) {
			if (widgetVisible) {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
				widgetVisible = false;
			}
			return;
		}
		ctx.ui.setWidget(
			WIDGET_KEY,
			(_tui, factoryTheme) => ({
				render: (width: number) => {
					const theme = ctx.ui.theme ?? factoryTheme;
					return subs.slice(0, 3).map((sub) => {
						const line = formatWidgetLine(widgetState(sub));
						const colored = sub.blockedBy
							? theme.fg("dim", `${line}  ·  another session is watching`)
							: theme.fg("accent", line.slice(0, 2)) + theme.fg("muted", line.slice(2));
						return truncateToWidth(colored, width, "…");
					});
				},
				invalidate: () => {},
			}),
			{ placement: "aboveEditor" }
		);
		widgetVisible = true;
	}

	function widgetState(sub: Subscription): WidgetState {
		return {
			ref: sub.ref,
			state: sub.state,
			checks: sub.checks,
			...(sub.title ? { title: sub.title } : {}),
			...(sub.lastEvent ? { lastEvent: sub.lastEvent } : {}),
			...(sub.lastEventAt ? { lastEventAt: sub.lastEventAt } : {}),
			...(sub.lastError ? { error: sub.lastErrorKind ?? "error" } : {}),
		};
	}

	function listEntry(sub: Subscription): ListEntry {
		return {
			ref: sub.ref,
			state: sub.state,
			checks: sub.checks,
			...(sub.title ? { title: sub.title } : {}),
			...(sub.lastEvent ? { lastEvent: sub.lastEvent } : {}),
			...(sub.lastEventAt ? { lastEventAt: sub.lastEventAt } : {}),
			...(sub.nextPollAt ? { nextPollInMs: Math.max(0, sub.nextPollAt - Date.now()) } : {}),
			...(sub.lastError ? { error: sub.lastError } : {}),
		};
	}

	/** Record ids as seen and self-posted, oldest first, with the same cap as diff. */
	function addOwnIds(cursor: Cursor, ids: string[]): Cursor {
		const merge = (value: string[]): string[] => {
			const next = [...new Set([...value, ...ids])];
			return next.length > 500 ? next.slice(next.length - 500) : next;
		};
		return { ...cursor, commentIds: merge(cursor.commentIds), ownIds: merge(cursor.ownIds) };
	}

	function deliverDeferred(): void {
		const state = registry();
		const queued = [...state.deferred];
		state.deferred.length = 0;
		for (const text of queued) state.deliver?.(text);
	}

	const unsubscribeBlockers = onBlockersChange(() => {
		if (!isBlocked()) deliverDeferred();
	});

	// ---------------------------------------------------------------------
	// Subscribing
	// ---------------------------------------------------------------------

	interface Target {
		ref: PrRef;
		remotes: RepoRef[];
	}

	/**
	 * Resolve what to watch. `crossRepo` is false for the model-facing tool: a
	 * model-supplied owner/repo must match a git remote, so an injected comment
	 * cannot point the session at another repository.
	 */
	async function resolveTarget(
		args: SubscribeArgs,
		cwd: string,
		options: { crossRepo: boolean }
	): Promise<{ target?: Target; error?: string }> {
		const remotes = await listRemotes(exec, cwd);
		const origin = remotes[0];
		const owner = args.owner?.trim();
		const repo = args.repo?.trim();
		const number = args.pullNumber;

		if (Boolean(owner) !== Boolean(repo)) {
			return { error: "Pass both owner and repo, or neither to use the origin remote." };
		}
		let resolvedOwner = owner;
		let resolvedRepo = repo;
		if (!resolvedOwner || !resolvedRepo) {
			if (!origin) {
				return {
					error:
						"This directory has no GitHub remote, so there is no default repository. Pass owner, repo, and pullNumber.",
				};
			}
			resolvedOwner ??= origin.owner;
			resolvedRepo ??= origin.repo;
		}
		if (!options.crossRepo) {
			if (!matchesRemote(remotes, resolvedOwner, resolvedRepo)) {
				return {
					error: `${resolvedOwner}/${resolvedRepo} is not a remote of this repository. subscribe_pr_activity only watches PRs in this repository's remotes; ask the user to run /subscribe ${resolvedOwner}/${resolvedRepo}#${number ?? "<n>"} if they want it.`,
				};
			}
		}

		let resolvedNumber = number;
		if (resolvedNumber === undefined) {
			const pull = await resolvePullForBranch(exec, cwd);
			if (!pull) return { error: NO_PR_HINT };
			resolvedNumber = pull.number;
		}
		if (!Number.isInteger(resolvedNumber) || resolvedNumber <= 0) {
			return { error: "pullNumber must be a positive integer." };
		}
		return { target: { ref: { owner: resolvedOwner, repo: resolvedRepo, number: resolvedNumber }, remotes } };
	}

	async function subscribe(ref: PrRef, cwd: string): Promise<{ text: string; blockedBy?: string }> {
		const existing = getSubscription(ref);
		if (existing && !existing.ended) {
			return {
				text: `Already subscribed to ${prKey(ref)}${existing.blockedBy ? ` (another session is watching; this session is not receiving events)` : ""}.`,
				...(existing.blockedBy ? { blockedBy: existing.blockedBy } : {}),
			};
		}
		const mine = listSubscriptions(currentSessionId);
		if (mine.length >= MAX_SUBSCRIPTIONS) {
			return {
				text: `Already watching ${MAX_SUBSCRIPTIONS} pull requests in this session. Unsubscribe one first with unsubscribe_pr_activity or /subscribe off <n>.`,
			};
		}
		if (!(await hasGhAuth(exec, cwd))) {
			return { text: `\`gh\` is not authenticated. ${AUTH_HINT}` };
		}

		const api = apiFor(currentSessionId, { ...deps, cwd });
		let snapshot;
		try {
			snapshot = await fetchSnapshot(api, ref);
		} catch (error) {
			const message = error instanceof GhApiError ? error.message : error instanceof Error ? error.message : String(error);
			return { text: `Could not read ${prKey(ref)}: ${message}. Nothing was subscribed.` };
		}

		if (snapshot.pull.state === "closed") {
			const how = snapshot.pull.merged ? "merged" : "closed";
			return { text: `${prKey(ref)} is already ${how}; there is nothing to watch. Nothing was subscribed.` };
		}

		let required: string[] | undefined;
		try {
			required = await requiredChecks(api, ref, snapshot.pull.baseRef);
		} catch {
			// No admin scope is the common case; every check then counts.
		}

		const lock = acquireLock(ref, currentSessionId);
		const sub: Subscription = {
			ref,
			sessionId: currentSessionId,
			cwd,
			cursor: initCursor(snapshot),
			checks: snapshot.checks,
			state: snapshot.pull.state,
			title: snapshot.pull.title,
			draft: snapshot.pull.draft,
			...(snapshot.pull.author ? { author: snapshot.pull.author } : {}),
			...(required ? { required } : {}),
			createdAt: Date.now(),
			consecutiveErrors: 0,
			notifiedErrors: [],
			catchUp: false,
			ended: false,
			pending: [],
			pendingLogs: new Map(),
		};
		if (lock.ok) {
			sub.lock = lock.lock;
			addSubscription(sub);
			startPoller(sub, { ...deps, cwd });
		} else {
			sub.blockedBy = `${lock.holder.sessionId || "another session"} (pid ${lock.holder.pid})`;
			addSubscription(sub);
		}
		persist();
		paint();

		const created = formatCreated({ ref, snapshot, required });
		if (sub.blockedBy) return { text: `${created}\n\n${SECOND_SESSION_TEXT(ref, sub.blockedBy)}`, blockedBy: sub.blockedBy };
		return { text: created };
	}

	function unsubscribe(ref: PrRef): string {
		const sub = getSubscription(ref);
		if (!sub || sub.ended) return `Not subscribed to ${prKey(ref)}.`;
		stopPoller(sub);
		releaseLock(sub.lock);
		removeSubscription(ref);
		persist();
		paint();
		return `Unsubscribed from ${prKey(ref)}. No more events will arrive for it.`;
	}

	// ---------------------------------------------------------------------
	// Restore, session lifecycle
	// ---------------------------------------------------------------------

	function restore(ctx: ExtensionContext): void {
		let data: { subscriptions?: unknown } | undefined;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			data = entry.data as { subscriptions?: unknown } | undefined;
		}
		if (!Array.isArray(data?.subscriptions)) return;
		for (const value of data.subscriptions) {
			if (!isPersistedSubscription(value)) continue;
			const persisted: PersistedSubscription = value;
			const ref: PrRef = { owner: persisted.owner, repo: persisted.repo, number: persisted.number };
			if (getSubscription(ref)) continue;
			const sub = subscriptionFromPersisted(persisted, currentSessionId);
			sub.sessionId = currentSessionId;
			const lock = acquireLock(ref, currentSessionId);
			if (lock.ok) {
				sub.lock = lock.lock;
				addSubscription(sub);
				startPoller(sub, { ...deps, cwd: sub.cwd });
			} else {
				sub.blockedBy = `${lock.holder.sessionId || "another session"} (pid ${lock.holder.pid})`;
				addSubscription(sub);
			}
		}
		paint();
	}

	function startTicker(): void {
		if (ticker) return;
		ticker = setInterval(() => {
			blockedTicks += 1;
			if (blockedTicks % BLOCKED_RETRY_TICKS === 0) retryBlocked();
			paint();
		}, UI_TICK_MS);
		ticker.unref?.();
	}

	/** A subscription that lost the lock tries again while the other session holds it. */
	function retryBlocked(): void {
		for (const sub of listSubscriptions(currentSessionId)) {
			if (!sub.blockedBy) continue;
			const lock = acquireLock(sub.ref, currentSessionId);
			if (!lock.ok) {
				sub.blockedBy = `${lock.holder.sessionId || "another session"} (pid ${lock.holder.pid})`;
				continue;
			}
			sub.lock = lock.lock;
			sub.blockedBy = undefined;
			sub.catchUp = true;
			startPoller(sub, { ...deps, cwd: sub.cwd });
		}
		paint();
	}

	pi.on("session_start", (event, ctx) => {
		currentSessionId = ctx.sessionManager.getSessionId();
		if (ctx.hasUI && ctx.mode === "tui") uiCtx = ctx;
		registry().exec = exec;
		registry().deliver = (text) =>
			pi.sendMessage(
				{ customType: CUSTOM_TYPE, content: text, display: true },
				{ triggerTurn: true, deliverAs: "steer" }
			);
		registry().persist = () => persist();
		registry().paint = () => paint();

		if (event.reason !== "reload") {
			// Jobs and subscriptions from an earlier session in this process must
			// not keep running invisibly. A `/reload` deliberately keeps them.
			for (const sub of listSubscriptions()) {
				if (sub.sessionId === currentSessionId) continue;
				stopPoller(sub);
				releaseLock(sub.lock);
				removeSubscription(sub.ref);
			}
		}
		restore(ctx);
		startTicker();
		paint();
	});

	pi.on("session_shutdown", (event) => {
		unsubscribeBlockers();
		if (event.reason === "reload") {
			// Pollers stay on `globalThis`; the new module re-binds the callbacks.
			if (ticker) clearInterval(ticker);
			ticker = undefined;
			uiCtx = undefined;
			widgetVisible = false;
			return;
		}
		for (const sub of listSubscriptions()) {
			stopPoller(sub);
			releaseLock(sub.lock);
			removeSubscription(sub.ref);
		}
		if (ticker) clearInterval(ticker);
		ticker = undefined;
		uiCtx = undefined;
		widgetVisible = false;
	});

	pi.on("session_compact", (_event, ctx) => {
		const subs = listSubscriptions(ctx.sessionManager.getSessionId());
		const text = formatCompactionReminder(
			subs.map((sub) => ({
				ref: sub.ref,
				checks: sub.checks,
				...(sub.lastEvent ? { lastEvent: sub.lastEvent } : {}),
				...(sub.lastEventAt ? { lastEventAt: sub.lastEventAt } : {}),
			}))
		);
		if (text) pi.sendMessage({ customType: CUSTOM_TYPE, content: text, display: false });
	});

	// A comment the session just posted must not wake it a few seconds later.
	pi.on("tool_result", async (event, ctx) => {
		if (!isBashToolResult(event) || event.isError === true) return;
		const command = (event.input as { command?: unknown } | undefined)?.command;
		if (typeof command !== "string" || !/\bgh\b/.test(command)) return;
		const target = extractPostedTarget(command);
		if (!target) return;
		const ids = extractPostedIds(resultText(event.content));
		if (ids.length === 0) return;
		const subs = listSubscriptions(currentSessionId || ctx.sessionManager.getSessionId());
		if (subs.length === 0) return;
		const cwdRepo = await resolveRepo(exec, ctx.cwd);
		let changed = false;
		for (const sub of subs) {
			if (!targetMatches(target, sub.ref, cwdRepo ?? undefined)) continue;
			sub.cursor = addOwnIds(sub.cursor, ids);
			changed = true;
		}
		if (changed) persist();
	});

	// ---------------------------------------------------------------------
	// Tools
	// ---------------------------------------------------------------------

	const toolResult = (text: string, details: SubscribeDetails) => ({
		content: [{ type: "text" as const, text }],
		details,
	});

	pi.registerTool<typeof SubscribeParams, SubscribeDetails>({
		name: "subscribe_pr_activity",
		label: "Subscribe to PR activity",
		description:
			"Subscribe to a GitHub pull request and get CI results, reviews, comments, and merge/close events as their own turns. Defaults to the origin remote and the current branch's open PR. After subscribing, end the turn instead of polling; the next event wakes you. Idempotent.",
		promptSnippet: "Subscribe to a pull request and be woken when it changes",
		promptGuidelines: SUBSCRIBE_GUIDELINES,
		parameters: SubscribeParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			bindContext(ctx);
			const resolved = await resolveTarget(params, ctx.cwd, { crossRepo: false });
			if (!resolved.target) {
				return toolResult(resolved.error ?? "Could not resolve the pull request.", {
					subscribed: false,
					reason: resolved.error,
				});
			}
			const { ref } = resolved.target;
			const { text, blockedBy } = await subscribe(ref, ctx.cwd);
			return toolResult(text, {
				owner: ref.owner,
				repo: ref.repo,
				number: ref.number,
				subscribed: blockedBy === undefined,
				...(blockedBy ? { blockedBy } : {}),
			});
		},
	});

	pi.registerTool<typeof SubscribeParams, SubscribeDetails>({
		name: "unsubscribe_pr_activity",
		label: "Unsubscribe from PR activity",
		description:
			"Stop receiving events for a pull request. Defaults to the origin remote and the current branch's open PR. Idempotent.",
		promptSnippet: "Stop PR wakeups",
		promptGuidelines: UNSUBSCRIBE_GUIDELINES,
		parameters: SubscribeParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			bindContext(ctx);
			const resolved = await resolveTarget(params, ctx.cwd, { crossRepo: false });
			if (!resolved.target) {
				return toolResult(resolved.error ?? "Could not resolve the pull request.", {
					subscribed: false,
					reason: resolved.error,
				});
			}
			const { ref } = resolved.target;
			return toolResult(unsubscribe(ref), {
				owner: ref.owner,
				repo: ref.repo,
				number: ref.number,
				subscribed: false,
			});
		},
	});

	// ---------------------------------------------------------------------
	// /subscribe
	// ---------------------------------------------------------------------

	pi.registerCommand(COMMAND, {
		description: "List, add, inspect, or stop PR subscriptions",
		handler: async (args, ctx) => {
			bindContext(ctx);
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const first = parts[0];

			const usage = [
				"/subscribe                 list subscriptions",
				"/subscribe <n>             subscribe (current repo, or owner/repo#n)",
				"/subscribe off [<n>]       stop",
				"/subscribe status          cursor, next poll, last error",
			].join("\n");

			if (!first || first === "list") {
				notify(ctx, formatList(listSubscriptions(currentSessionId).map(listEntry)));
				return;
			}
			if (first === "help") {
				notify(ctx, usage);
				return;
			}
			if (first === "status") {
				notify(
					ctx,
					formatStatus(
						listSubscriptions(currentSessionId).map((sub) => ({
							...listEntry(sub),
							headSha: sub.cursor.headSha,
							commentsSeen: sub.cursor.commentIds.length,
							reviewsSeen: sub.cursor.reviewIds.length,
							...(sub.required ? { required: sub.required } : {}),
							...(sub.lastErrorKind ? { lastErrorKind: sub.lastErrorKind } : {}),
							...(sub.lock
								? {
										lock: {
											pid: sub.lock.pid,
											sessionId: sub.lock.sessionId,
											heartbeatAt: sub.lock.heartbeatAt,
											foreign: Boolean(sub.blockedBy),
										},
									}
								: {}),
						}))
					)
				);
				return;
			}

			// `off [<n>]`
			if (first === "off") {
				const spec = parts[1];
				if (!spec) {
					const resolved = await resolveTarget({}, ctx.cwd, { crossRepo: true });
					if (!resolved.target) {
						notify(ctx, resolved.error ?? "Could not resolve the pull request.", "warning");
						return;
					}
					notify(ctx, unsubscribe(resolved.target.ref));
					return;
				}
				const parsed = parsePrSpec(spec);
				if (!parsed) {
					notify(ctx, `Not a pull request: ${spec}`, "warning");
					return;
				}
				const ref = await refFromSpec(parsed, ctx.cwd);
				if (!ref) {
					notify(ctx, `Could not resolve ${spec}.`, "warning");
					return;
				}
				notify(ctx, unsubscribe(ref));
				return;
			}

			const parsed = parsePrSpec(first);
			if (!parsed) {
				notify(ctx, usage, "warning");
				return;
			}

			// The user's own command may reach another repository; the tool cannot.
			const crossRepo = Boolean(parsed.owner && parsed.repo);
			if (crossRepo) {
				const result = await subscribe({ owner: parsed.owner!, repo: parsed.repo!, number: parsed.number }, ctx.cwd);
				notify(ctx, result.text);
				return;
			}
			const resolved = await resolveTarget(
				{ ...(parsed.number ? { pullNumber: parsed.number } : {}) },
				ctx.cwd,
				{ crossRepo: true }
			);
			if (!resolved.target) {
				notify(ctx, resolved.error ?? "Could not resolve the pull request.", "warning");
				return;
			}
			const result = await subscribe(resolved.target.ref, ctx.cwd);
			notify(ctx, result.text);
		},
	});

	async function refFromSpec(
		parsed: { owner?: string; repo?: string; number: number },
		cwd: string
	): Promise<PrRef | undefined> {
		if (parsed.owner && parsed.repo) {
			return { owner: parsed.owner, repo: parsed.repo, number: parsed.number };
		}
		const repo = await resolveRepo(exec, cwd);
		if (!repo) return undefined;
		return { owner: repo.owner, repo: repo.repo, number: parsed.number };
	}

}
