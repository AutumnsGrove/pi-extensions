/**
 * notify — native desktop notifications when a run finishes, errors, or pi is
 * blocked waiting on you.
 *
 * Claude Code taps you on the shoulder when a task is done or a permission
 * prompt needs an answer. This extension does the same for pi, and adds the
 * session name, the run duration, and a one-line summary of the answer.
 *
 * Fires on:
 *   - `agent_settled` — finished / stopped / errored (success needs >= 3s)
 *   - `ui_prompt_start` — a blocking dialog, approval, or `pi-q-n-a` form
 *
 * Delivery prefers the terminal's own notification protocol (OSC 9 for
 * Ghostty, iTerm2 and WezTerm — the sequence Claude Code uses; OSC 777 for
 * rxvt; OSC 99 for kitty), which macOS routes to Notification Center with the
 * terminal's icon and click-to-focus. Unknown terminals fall back to
 * `terminal-notifier` when installed, else `osascript` on macOS. `/notify`
 * toggles it, `/notify test [seconds]` previews.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	AgentActivityOutcome,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import {
	buildAborted,
	buildAttention,
	buildError,
	buildFinished,
	buildQuestion,
	buildTest,
	planDelivery,
	shouldNotify,
	sessionLabel,
	terminalBundleId,
	type DeliveryPlan,
	type Notification,
} from "./notify.ts";

/** The questionnaire tool from this package; its prompt gets its own wording. */
const ASK_TOOL = "pi-q-n-a";

/** The last assistant message in the session, used for the summary line. */
function lastAssistant(ctx: ExtensionContext): AssistantMessage | undefined {
	const entries = ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (entry?.type === "message" && entry.message.role === "assistant") {
			return entry.message;
		}
	}
	return undefined;
}

/** Join the text parts of an assistant message, ignoring thinking and calls. */
function assistantText(message: AssistantMessage): string {
	const parts: string[] = [];
	for (const part of message.content) {
		if (part.type === "text") parts.push(part.text);
	}
	return parts.join("\n");
}

/** The first question of a `pi-q-n-a` tool call, if any. */
function firstQuestion(args: unknown): string | undefined {
	const questions = (args as { questions?: unknown } | null)?.questions;
	if (!Array.isArray(questions)) return undefined;
	const first: unknown = questions[0];
	if (typeof first !== "object" || first === null) return undefined;
	const prompt = (first as { prompt?: unknown }).prompt;
	return typeof prompt === "string" ? prompt : undefined;
}

export default function notify(pi: ExtensionAPI): void {
	let enabled = true;
	/** Start of the current run; unset between runs. */
	let runStartedAt: number | undefined;
	/** Latest outcome reported by `agent_before_settle`. */
	let outcome: AgentActivityOutcome = "completed";
	/** In-flight `pi-q-n-a` calls, keyed by tool call id. */
	const askCalls = new Map<string, string | undefined>();
	/** Ask calls already announced, so one form never notifies twice. */
	const announcedAsks = new Set<string>();
	/** Whether `terminal-notifier` is on PATH, for the nicer macOS fallback. */
	let hasTerminalNotifier = false;
	/** Pending `/notify test <seconds>` timer, cleared on shutdown. */
	let testTimer: NodeJS.Timeout | undefined;

	const session = (ctx: ExtensionContext): string =>
		sessionLabel(ctx.sessionManager.getSessionName(), ctx.cwd);

	const elapsed = (): number =>
		runStartedAt === undefined ? 0 : Date.now() - runStartedAt;

	/** Hand a notification to the OS. Returns the plan used, or undefined. */
	const deliver = (
		notification: Notification,
		ctx: ExtensionContext
	): DeliveryPlan | undefined => {
		// OSC writes and OS banners are pointless outside the interactive TUI,
		// and in RPC/JSON mode a raw stdout write would corrupt the stream.
		if (ctx.mode !== "tui") return undefined;
		const plan = planDelivery(notification, {
			env: process.env,
			platform: process.platform,
			isTTY: process.stdout.isTTY === true,
			macNotifier: hasTerminalNotifier ? "terminal-notifier" : "osascript",
			sender: terminalBundleId(process.env),
		});
		if (!plan) return undefined;
		if (plan.kind === "stdout") {
			try {
				process.stdout.write(plan.data ?? "");
			} catch {
				// A closed stdout must not take the session down.
			}
			return plan;
		}
		if (!plan.command) return undefined;
		execFile(plan.command, plan.args ?? [], { timeout: 5_000 }, () => {
			// A missing osascript/notify-send or a denied notification is fine.
		});
		return plan;
	};

	/** Deliver unless the user turned notifications off. */
	const notify = (notification: Notification, ctx: ExtensionContext): void => {
		if (enabled) deliver(notification, ctx);
	};

	pi.on("session_start", () => {
		execFile("which", ["terminal-notifier"], (error) => {
			hasTerminalNotifier = !error;
		});
	});

	pi.on("agent_start", () => {
		runStartedAt ??= Date.now();
		outcome = "completed";
	});

	pi.on("agent_before_settle", (event) => {
		outcome = event.outcome;
	});

	pi.on("agent_settled", (event, ctx) => {
		const started = runStartedAt;
		const durationMs = elapsed();
		const finalOutcome = outcome;
		runStartedAt = undefined;
		outcome = "completed";
		if (started === undefined) return;

		const last = lastAssistant(ctx);
		const stop = last?.stopReason;
		const isError = finalOutcome === "error" || stop === "error";
		// `aborted` is on newer pi releases; the settle outcome is the portable source.
		const settledAborted = (event as { aborted?: boolean }).aborted === true;
		const isAborted =
			!isError &&
			(settledAborted || finalOutcome === "aborted" || stop === "aborted");
		const label = session(ctx);

		const notification = isError
			? buildError({
					session: label,
					durationMs,
					errorMessage: last?.errorMessage,
					text: last ? assistantText(last) : "",
				})
			: isAborted
				? buildAborted({ session: label, durationMs })
				: buildFinished({
						session: label,
						durationMs,
						text: last ? assistantText(last) : "",
					});

		if (shouldNotify(notification.kind, durationMs)) {
			notify(notification, ctx);
		}
	});

	pi.on("ui_prompt_start", (event, ctx) => {
		const pendingAsk = [...askCalls.keys()].find(
			(id) => !announcedAsks.has(id)
		);
		if (pendingAsk) {
			announcedAsks.add(pendingAsk);
			notify(
				buildQuestion({
					session: session(ctx),
					question: askCalls.get(pendingAsk),
					durationMs: elapsed(),
				}),
				ctx
			);
			return;
		}
		// The form is already announced; a nested prompt must not double-notify.
		if (askCalls.size > 0) return;
		// Only a dialog raised while the agent runs is something you were
		// probably waiting on. Menus you opened yourself stay silent.
		if (runStartedAt === undefined) return;
		notify(
			buildAttention({
				session: session(ctx),
				promptKind: event.kind,
				detail: event.title,
				durationMs: elapsed(),
			}),
			ctx
		);
	});

	pi.on("tool_execution_start", (event) => {
		if (event.toolName !== ASK_TOOL) return;
		askCalls.set(event.toolCallId, firstQuestion(event.args));
	});

	pi.on("tool_execution_end", (event) => {
		if (event.toolName !== ASK_TOOL) return;
		askCalls.delete(event.toolCallId);
		announcedAsks.delete(event.toolCallId);
	});

	pi.on("session_shutdown", () => {
		runStartedAt = undefined;
		outcome = "completed";
		askCalls.clear();
		announcedAsks.clear();
		if (testTimer) {
			clearTimeout(testTimer);
			testTimer = undefined;
		}
	});

	pi.registerCommand("notify", {
		description:
			"Desktop notifications on finish or when pi needs you; on|off|test",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			const head = parts[0];

			if (head === "test") {
				const seconds = Number(parts[1]);
				const delayMs =
					Number.isFinite(seconds) && seconds > 0
						? Math.min(seconds, 600) * 1000
						: 0;
				const announce = () => {
					const plan = deliver(buildTest(session(ctx)), ctx);
					const transport = !plan
						? undefined
						: plan.kind === "stdout"
							? "the terminal (OSC)"
							: plan.command;
					ctx.ui.notify(
						plan
							? `Sent via ${transport} — Ghostty hides banners while this tab is focused`
							: "No notification transport available here",
						plan ? "info" : "warning"
					);
				};
				if (delayMs === 0) {
					announce();
					return;
				}
				if (testTimer) clearTimeout(testTimer);
				testTimer = setTimeout(() => {
					testTimer = undefined;
					announce();
				}, delayMs);
				ctx.ui.notify(
					`Sending a test notification in ${Math.round(
						delayMs / 1000
					)}s — switch away to see the banner`,
					"info"
				);
				return;
			}

			if (head === "on" || head === "off") {
				enabled = head === "on";
			} else {
				enabled = !enabled;
			}
			ctx.ui.notify(
				enabled ? "Desktop notifications on" : "Desktop notifications off",
				"info"
			);
		},
	});
}
