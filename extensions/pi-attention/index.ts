/**
 * pi-attention — one place that decides whether a session needs you.
 *
 * Every settled turn used to play the same "finished" sound, including the
 * no-op turns a PR subscription causes when CI passes and nothing is left to
 * do. This extension answers one question — does this session need you? — and
 * publishes the answer as `AttentionChanged` on the hooks bus, for `sounds`,
 * `notify`, or a remote runner to map however they like.
 *
 * Two layers, rules first:
 *
 * 1. Deterministic rules decide the common cases and always win: a failure, a
 *    comment, a review request, a subscription error, an open prompt, a done
 *    release, an informational wake with no tool calls, an ordinary turn.
 * 2. A decision model classifies the one ambiguous case left: a wake that was
 *    informational but where the agent did do something. Did it report
 *    something worth reading, or was the turn a no-op?
 *
 * The model layer never calls a chat model, never blocks a turn (the answer
 * arrives after settlement), and fails loud: a missing answer, refused
 * request, or timeout is `needs_you`, never silence.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { announceAttention, retractAttention } from "../_shared/attention.ts";
import {
	decide as decideCascade,
	type DecideRequest,
	type DecideResult,
} from "../_shared/classifier.ts";
import {
	HOOK_EVENT_CHANNEL,
	emitHookEvent,
	isHookEventEmission,
	type PrReadyToMergePayload,
	type PrWakePayload,
} from "../_shared/hook-events.ts";
import { describeAttention, normalizeAttentionConfig, readAttentionConfig } from "./config.ts";
import { MAX_LAST_TEXT, attentionQuestions, attentionState, failedUpdate, interpretAttention } from "./model.ts";
import { appendVerdict, describeVerdicts, logPath, readVerdicts } from "./log.ts";
import { decideRules, isSameUpdate } from "./state.ts";
import type {
	AttentionConfig,
	AttentionUpdate,
	TurnFacts,
	VerdictRecord,
	WakeSignal,
} from "./types.ts";

export interface AttentionDeps {
	now?: () => number;
	/** Overrides the cascade; tests inject a scripted answer. */
	decide?: (request: DecideRequest) => Promise<DecideResult>;
	/** Overrides the verdict log sink. */
	log?: (record: VerdictRecord) => void;
}

const freshFacts = (): TurnFacts => ({
	toolCalls: 0,
	prompted: false,
	aborted: false,
	released: false,
});

/** Text blocks of an assistant message, joined. */
function messageText(message: unknown): string {
	const record = message as { role?: unknown; content?: unknown };
	if (record?.role !== "assistant" || !Array.isArray(record.content)) return "";
	const parts: string[] = [];
	for (const block of record.content) {
		if (!block || typeof block !== "object") continue;
		const part = block as { type?: unknown; text?: unknown };
		if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
	}
	const joined = parts.join("\n").trim();
	return joined.length > MAX_LAST_TEXT ? joined.slice(0, MAX_LAST_TEXT) : joined;
}

export function createAttention(pi: ExtensionAPI, deps: AttentionDeps = {}): void {
	const now = deps.now ?? (() => Date.now());
	const writeLog = deps.log ?? ((record: VerdictRecord) => appendVerdict(record));

	let loaded = normalizeAttentionConfig(undefined);
	const config = (): AttentionConfig => loaded.config;
	let last: AttentionUpdate | undefined;
	let ctxRef: ExtensionContext | undefined;
	let facts = freshFacts();
	/**
	 * Bumped whenever the facts change under an in-flight decision: a new turn,
	 * a steered wake, a release, a prompt. A settle that resolves after its turn
	 * is gone must not publish over the next turn or reset its facts.
	 */
	let generation = 0;

	const reload = (): void => {
		try {
			loaded = normalizeAttentionConfig(readAttentionConfig(pi.getSettings()), "settings.json");
		} catch {
			// Keep the previous configuration.
		}
	};

	/**
	 * Keep the flag `sounds` reads in step with the configuration. Announcing
	 * while disabled would suppress the settle cue with nothing to replace it.
	 */
	const syncOwnership = (): void => {
		if (config().enabled) announceAttention(pi);
		else retractAttention();
	};

	const refLabel = (turn: TurnFacts): string => {
		const wake = turn.wake?.payload;
		return wake ? `${wake.owner}/${wake.repo}#${wake.pullNumber}` : "no pull request";
	};

	function publish(
		update: AttentionUpdate,
		record: Partial<VerdictRecord> = {},
		turn: TurnFacts = facts,
	): void {
		if (!config().enabled) return;
		const same = isSameUpdate(last, update);
		last = update;
		if (config().log) {
			writeLog({
				at: now(),
				// Which session and directory this came from: the point of the log is
				// to go back to the transcript later and label what should have been.
				...(ctxRef ? { session: ctxRef.sessionManager.getSessionId(), cwd: ctxRef.cwd } : {}),
				state: update.state,
				source: update.source,
				reason: update.reason,
				...(update.confidence !== undefined ? { confidence: update.confidence } : {}),
				...record,
				thresholds: {
					needsYouAt: config().needsYouAt,
					nothingToDoAt: config().nothingToDoAt,
				},
				input: {
					...(turn.wake
						? {
								pull: refLabel(turn),
								informational: turn.wake.payload.informational,
								eventTypes: turn.wake.payload.eventTypes,
								wakeSummary: turn.wake.payload.summary,
							}
						: {}),
					...(turn.lastText ? { lastText: turn.lastText } : {}),
					toolCalls: turn.toolCalls,
				},
			});
		}
		// Identical consecutive states are noise for a consumer.
		if (same) return;
		emitHookEvent(pi, "AttentionChanged", {
			state: update.state,
			reason: update.reason,
			source: update.source,
			...(update.confidence !== undefined ? { confidence: update.confidence } : {}),
		});
	}

	const runModel = async (turn: TurnFacts): Promise<DecideResult> => {
		const request: DecideRequest = {
			state: attentionState(turn, refLabel(turn)),
			questions: attentionQuestions(),
		};
		if (deps.decide) return deps.decide(request);
		const ctx = ctxRef;
		if (!ctx) return { ok: false, errors: ["no session context"], durationMs: 0 };
		return decideCascade(ctx, config().models, request, {
			timeoutMs: config().timeoutSeconds * 1000,
		});
	};

	/** Decide the state for the turn that just settled. Never throws, never blocks. */
	async function settle(turn = generation, settling = facts): Promise<void> {
		/** Only clear the facts if this turn still owns them. */
		const finish = (): void => {
			if (generation === turn) facts = freshFacts();
		};
		if (!config().enabled) {
			finish();
			return;
		}
		const rules = decideRules(settling);
		if (rules.kind === "decided") {
			publish(rules.update, {}, settling);
			finish();
			return;
		}
		// `models: []` means rules only. Without a model the ambiguous middle
		// cannot be settled, and the safe answer is to ask rather than go quiet.
		if (config().models.length === 0) {
			publish(
				{
					state: "needs_you",
					source: "model",
					reason: "ambiguous wake, and no decision model is configured",
				},
				{},
				settling,
			);
			finish();
			return;
		}

		const result = await runModel(settling);
		// A new turn started while the model was thinking. Its facts are the
		// truth now, and this answer belongs to a turn that no longer exists.
		if (generation !== turn) return;
		let update: AttentionUpdate;
		const record: Partial<VerdictRecord> = { model: result.ok ? result.model : undefined, durationMs: result.durationMs };
		if (!result.ok) {
			update = failedUpdate(result);
			record.error = result.errors.join("; ");
		} else {
			const interpreted = interpretAttention(result.answers, config(), result.model, result.durationMs);
			update = interpreted?.update ?? {
				state: "needs_you",
				source: "model",
				reason: "the decision model omitted an answer",
			};
			record.answers = result.answers;
			if (!interpreted) record.error = "missing answer";
		}
		publish(update, record, settling);
		finish();
	}

	// ---------------------------------------------------------------------
	// Inputs
	// ---------------------------------------------------------------------

	pi.events.on(HOOK_EVENT_CHANNEL, (data) => {
		if (!isHookEventEmission(data)) return;
		if (data.event === "PrWake") {
			// The delivery starts a turn, and `agent_start` announces that. Only the
			// facts are recorded here, so the state is not reported twice.
			generation += 1;
			facts.wake = { payload: data.input as unknown as PrWakePayload, receivedAt: now() };
			return;
		}
		if (data.event === "PrReadyToMerge") {
			const payload = data.input as unknown as PrReadyToMergePayload;
			generation += 1;
			facts.released = true;
			facts.releaseReason = payload.reason;
			publish({
				state: "ready",
				source: "signal",
				reason: payload.reason ? `released as done: ${payload.reason}` : "released as done",
			});
		}
		// Everything else, including AttentionChanged, is not an input here.
	});

	pi.on("session_start", (_event, ctx) => {
		ctxRef = ctx;
		reload();
		if (ctx.hasUI && ctx.mode === "tui") {
			for (const warning of loaded.warnings) ctx.ui.notify(warning, "warning");
		}
		syncOwnership();
	});

	pi.on("session_shutdown", (event) => {
		// A reload re-announces from the new module instance.
		if (event.reason !== "reload") retractAttention();
		facts = freshFacts();
		last = undefined;
	});

	pi.on("agent_start", (_event, ctx) => {
		ctxRef = ctx;
		generation += 1;
		// Reset the per-turn counters, keeping the wake that caused this turn and a
		// release that arrived during it.
		facts = {
			...freshFacts(),
			...(facts.wake ? { wake: facts.wake } : {}),
			...(facts.released ? { released: true, ...(facts.releaseReason ? { releaseReason: facts.releaseReason } : {}) } : {}),
		};
		publish({ state: "working", source: "rule", reason: "the agent is running" });
	});

	pi.on("tool_call", () => {
		facts.toolCalls += 1;
	});

	pi.on("message_end", (event) => {
		const text = messageText(event.message);
		if (text) facts.lastText = text;
	});

	pi.on("ui_prompt_start", () => {
		generation += 1;
		facts.prompted = true;
		publish({ state: "needs_you", source: "signal", reason: "a prompt is open" });
	});

	pi.on("ui_prompt_end", () => {
		facts.prompted = false;
		publish({ state: "working", source: "signal", reason: "the prompt is answered" });
	});

	pi.events.on("pi-permissions:prompt", () => {
		generation += 1;
		facts.prompted = true;
		publish({ state: "needs_you", source: "signal", reason: "a permission prompt is open" });
	});

	pi.on("agent_settled", (event) => {
		facts.aborted = event.aborted;
		const turn = generation;
		const settling = facts;
		// Fire and forget: the model path must not delay settlement.
		void settle(turn, settling).catch(() => {
			// The same guard as the normal path: a failure of a turn that has been
			// replaced must not publish over the new turn or clear its facts.
			if (generation !== turn) return;
			publish({ state: "needs_you", source: "model", reason: "the attention check failed" }, {}, settling);
			facts = freshFacts();
		});
	});

	// ---------------------------------------------------------------------
	// /attention
	// ---------------------------------------------------------------------

	pi.registerCommand("attention", {
		description: "Show, toggle, or inspect the attention decisions",
		handler: async (args: string, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/);
			const tail = rest.join(" ").trim();

			if (!sub) {
				const lines = describeAttention(config());
				lines.push(
					`State: ${last ? `${last.state} — ${last.reason}` : "(nothing decided yet)"}`,
					`Log: ${logPath()}`,
				);
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			if (sub === "on" || sub === "off") {
				loaded.config.enabled = sub === "on";
				syncOwnership();
				ctx.ui.notify(`Attention ${sub}.`, "info");
				return;
			}
			if (sub === "reload") {
				reload();
				syncOwnership();
				ctx.ui.notify(
					`Reloaded attention settings${loaded.warnings.length ? ` with ${loaded.warnings.length} warning(s)` : ""}.`,
					loaded.warnings.length ? "warning" : "info",
				);
				return;
			}
			if (sub === "log") {
				const count = Number(tail);
				const records = readVerdicts(
					logPath(),
					Number.isFinite(count) && count > 0 ? count : undefined,
				);
				ctx.ui.notify(describeVerdicts(records).join("\n"), "info");
				return;
			}
			if (sub === "state") {
				ctx.ui.notify(
					last ? `${last.state} — ${last.reason} [${last.source}]` : "Nothing decided yet.",
					"info",
				);
				return;
			}
			ctx.ui.notify("Usage: /attention [on|off|reload|state|log [n]]", "warning");
		},
	});
}

export default function piAttention(pi: ExtensionAPI): void {
	createAttention(pi);
}
