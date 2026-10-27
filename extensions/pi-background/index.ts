/**
 * pi-background — long shell commands that keep running after the tool call
 * returns.
 *
 * Claude Code's background-command flow, reduced to pi's primitives:
 *
 *   bash({ command: "pnpm build" })                 auto-backgrounds at the deadline
 *   bash({ command: "pnpm dev", run_in_background: true })
 *   jobs({ action: "list" | "output" | "attach" | "kill" | "search" | "clear" })
 *
 *   Ctrl+Shift+B                                     move foreground work to the background
 *   /bg                                              list, inspect, or stop jobs
 *
 * A foreground command runs normally and streams output. If it is still
 * running when the deadline passes, the process is left alone: the tool call
 * returns its ID and partial output, and a `<task-notification>` arrives when
 * it exits. `sleep` is deliberately killed instead of backgrounded.
 *
 * Jobs are detached child processes with stdout/stderr wired to a file at
 * `<tmp>/pi-bg/<id>.log`. The registry is in memory (on `globalThis`, so a
 * `/reload` does not orphan it); quitting, switching, or resuming a session
 * stops the jobs owned by that session. Logs stay on disk for the OS to clean.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	createBashToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { isBlocked, onBlockersChange } from "../_shared/blockers.ts";
import {
	DEFAULT_AUTO_BACKGROUND_SECONDS,
	clearFinishedJobs,
	detachAllForeground,
	enforceLogLimits,
	getJob,
	isSleepCommand,
	killAllJobs,
	killJob,
	lastLine,
	listJobs,
	markRead,
	onJobEvent,
	pruneFinishedJobs,
	readTail,
	resolveRetentionMs,
	runningJobs,
	startJob,
	summarize,
	waitForJob,
	runForeground,
	type Job,
	type JobSummary,
} from "./jobs.ts";
import {
	elapsedLabel,
	formatBackgroundNotice,
	formatJobDetails,
	formatJobsList,
	formatNotification,
	formatRunningReminder,
	formatWidgetLine,
	isRecentlyFinished,
	previewCommand,
	resolveWidgetTtlMs,
	statusGlyph,
	statusLabel,
	stripAnsi,
} from "./format.ts";

const BASH_TOOL = "bash";
const JOBS_TOOL = "jobs";
const COMMAND = "bg";
const WIDGET_KEY = "pi-background";
const CUSTOM_TYPE = "pi-background";
const FLAG_TIMEOUT = "bg-timeout";
const MAX_SEARCH_BYTES = 4 * 1024 * 1024;
const MAX_SEARCH_MATCHES = 50;
/** How often the widget refreshes while jobs run. */
const UI_TICK_MS = 1000;

const BashParams = Type.Object({
	command: Type.String({ description: "Shell command to execute" }),
	timeout: Type.Optional(
		Type.Number({
			description:
				"Seconds before the command is moved to the background. Sleep commands are killed instead. Defaults to the extension's auto-background timeout.",
		})
	),
	run_in_background: Type.Optional(
		Type.Boolean({
			description: "Start the command in the background immediately and return its job id.",
		})
	),
});
type BashArgs = Static<typeof BashParams>;

const JobsParams = Type.Object({
	action: StringEnum(["list", "output", "attach", "kill", "search", "clear"] as const, {
		description: "list jobs, read output, wait for one, kill one, search logs, or clear finished jobs",
	}),
	id: Type.Optional(Type.String({ description: "Job id (required for output, attach, and kill)" })),
	pattern: Type.Optional(Type.String({ description: "Regular expression to search in job logs (required for search)" })),
	lines: Type.Optional(Type.Number({ description: "Number of output lines to return (default 60, max 500)" })),
	timeout: Type.Optional(
		Type.Number({ description: "Seconds to wait for attach (default 120, max 600)" })
	),
});
type JobsArgs = Static<typeof JobsParams>;

interface JobsDetails {
	action: string;
	jobs?: JobSummary[];
	job?: JobSummary;
	output?: string;
	logPath?: string;
	message?: string;
}

const PROMPT_GUIDELINES = [
	"Use `bash` with `run_in_background: true` for dev servers, watchers, and long builds instead of blocking the turn.",
	"When a bash result says a command is running in the background, keep its job id and check on it instead of re-running the command.",
];

const JOBS_GUIDELINES = [
	"Use `jobs({ action: \"attach\", id })` to wait for a background job instead of sleeping or re-running the command.",
	"Use `jobs({ action: \"output\", id })` to peek at a running job and `jobs({ action: \"kill\", id })` for work you no longer need.",
	"A `<task-notification>` means a background job finished; read its output before deciding the next step.",
];

function resolveAutoBackgroundSeconds(pi: ExtensionAPI): number {
	const flag = pi.getFlag(FLAG_TIMEOUT);
	const raw = (typeof flag === "string" && flag.trim()) || process.env.PI_BG_TIMEOUT || "";
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : DEFAULT_AUTO_BACKGROUND_SECONDS;
}

function resolveDeadlineMs(pi: ExtensionAPI, timeout: number | undefined): number {
	if (timeout === undefined) return resolveAutoBackgroundSeconds(pi) * 1000;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}
	return timeout * 1000;
}

/** Recreate the PI_* environment pi's own bash tool exposes. */
function sessionEnv(ctx: ExtensionContext): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.PI_SESSION_ID;
	delete env.PI_SESSION_FILE;
	delete env.PI_PROVIDER;
	delete env.PI_MODEL;
	delete env.PI_REASONING_LEVEL;
	const sessionId = ctx.sessionManager.getSessionId();
	if (sessionId) env.PI_SESSION_ID = sessionId;
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (sessionFile) env.PI_SESSION_FILE = sessionFile;
	if (ctx.model) {
		env.PI_PROVIDER = ctx.model.provider;
		env.PI_MODEL = ctx.model.id;
	}
	if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
	return env;
}

function requireJob(id: string | undefined): Job {
	if (!id) throw new Error("A job id is required for this action.");
	const job = getJob(id);
	if (!job) {
		const running = runningJobs();
		const hint =
			running.length > 0
				? ` Running jobs: ${running.map((entry) => entry.id).join(", ")}.`
				: "";
		throw new Error(`No background job with id "${id}".${hint}`);
	}
	return job;
}

function tailText(job: Job, lines: number, maxBytes = 64 * 1024): string {
	const tail = readTail(job, Math.min(500, Math.max(1, Math.floor(lines))), maxBytes);
	if (!tail.text) return "(no output yet)";
	return tail.truncated ? `${tail.text}\n\n[showing the end of ${job.logPath}]` : tail.text;
}

function searchLogs(pattern: string, sessionId: string): { matches: string[]; scanned: number } {
	let regex: RegExp;
	try {
		regex = new RegExp(pattern, "i");
	} catch (error) {
		throw new Error(`Invalid search pattern: ${error instanceof Error ? error.message : String(error)}`);
	}

	const matches: string[] = [];
	let scanned = 0;
	for (const summary of listJobs()) {
		if (sessionId && summary.ownerSessionId && summary.ownerSessionId !== sessionId) continue;
		const job = getJob(summary.id);
		if (!job) continue;
		scanned += 1;
		const text = stripAnsi(readTail(job, 0, MAX_SEARCH_BYTES).text);
		for (const line of text.split("\n")) {
			if (!regex.test(line)) continue;
			matches.push(`${job.id}: ${line.trim().slice(0, 300)}`);
			if (matches.length >= MAX_SEARCH_MATCHES) break;
		}
		if (matches.length >= MAX_SEARCH_MATCHES) break;
	}
	return { matches, scanned };
}

export default function piBackground(pi: ExtensionAPI): void {
	pi.registerFlag(FLAG_TIMEOUT, {
		description: `Seconds a foreground command may run before pi-background detaches it (default ${DEFAULT_AUTO_BACKGROUND_SECONDS})`,
		type: "string",
	});

	// Renderers are borrowed from pi's native bash definition so an override
	// keeps the familiar shell framing and live timing.
	const nativeBash = createBashToolDefinition(process.cwd());
	const widgetTtlMs = resolveWidgetTtlMs();

	let uiCtx: ExtensionContext | undefined;
	let currentSessionId = "";
	let primarySessionId = "";
	let shutdown = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	let widgetVisible = false;

	const notify = (ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "info"): void => {
		if (ctx.hasUI) ctx.ui.notify(text, level);
	};

	/** Jobs the active session owns; unowned jobs stay visible everywhere. */
	const visibleJobs = (sessionId: string): JobSummary[] => {
		const jobs = listJobs();
		if (!sessionId) return jobs;
		return jobs.filter((job) => !job.ownerSessionId || job.ownerSessionId === sessionId);
	};

	// ---------------------------------------------------------------------
	// Widget
	// ---------------------------------------------------------------------

	const hasWidgetContent = (): boolean =>
		visibleJobs(primarySessionId).some(
			(job) => job.status === "running" || isRecentlyFinished(job, Date.now(), widgetTtlMs)
		);

	const renderWidget = (theme: ExtensionContext["ui"]["theme"], width: number): string[] => {
		const jobs = visibleJobs(primarySessionId);
		const running = jobs.filter((job) => job.status === "running");
		const unread = jobs.filter((job) => isRecentlyFinished(job, Date.now(), widgetTtlMs)).slice(0, 2);
		if (running.length === 0 && unread.length === 0) return [];

		const lines = [
			truncateToWidth(
				`${theme.fg("accent", "●")} ${theme.fg("accent", `Background (${running.length} running)`)}`,
				width,
				"…"
			),
		];
		const visible = running.slice(0, 3);
		for (let index = 0; index < visible.length; index += 1) {
			const job = visible[index];
			if (!job) continue;
			lines.push(truncateToWidth(`${theme.fg("dim", "├─")} ${formatWidgetLine(job)}`, width, "…"));
			// One live detail line is enough; more turns the widget into a log.
			const detail = index === 0 ? getJob(job.id) : undefined;
			const last = detail ? lastLine(detail) : undefined;
			if (last) lines.push(truncateToWidth(`${theme.fg("dim", "│  └─")} ${theme.fg("dim", last)}`, width, "…"));
		}
		const hidden = running.length - visible.length;
		if (hidden > 0) {
			lines.push(truncateToWidth(`${theme.fg("dim", `└─ +${hidden} more · /${COMMAND}`)}`, width, "…"));
		}
		for (const job of unread) {
			const color = job.status === "failed" ? "error" : "success";
			lines.push(
				truncateToWidth(
					`${theme.fg(color, statusGlyph(job.status))} ${theme.fg("dim", job.id)} ${theme.fg("muted", previewCommand(job.command, 46))} ${theme.fg("dim", `· ${statusLabel(job)}`)}`,
					width,
					"…"
				)
			);
		}
		lines.push("");
		return lines;
	};

	const paint = (): void => {
		const ctx = uiCtx;
		if (!ctx || !ctx.hasUI || ctx.mode !== "tui") return;
		const sessionId = ctx.sessionManager.getSessionId();
		if (primarySessionId && sessionId !== primarySessionId) return;

		if (!hasWidgetContent()) {
			if (widgetVisible) {
				ctx.ui.setWidget(WIDGET_KEY, undefined);
				widgetVisible = false;
			}
			return;
		}

		ctx.ui.setWidget(
			WIDGET_KEY,
			(_tui, factoryTheme) => ({
				render: (width: number) => renderWidget(ctx.ui.theme ?? factoryTheme, width),
				invalidate: () => {},
			}),
			{ placement: "aboveEditor" }
		);
		widgetVisible = true;
	};

	// ---------------------------------------------------------------------
	// Completion notifications
	// ---------------------------------------------------------------------

	// Notifications that arrived while an interactive blocker (pi-q-n-a) owned
	// the session. They are delivered only after the form closes: waking the
	// agent behind a question made it keep working while the user was thinking.
	let deferredNotifications: Job[] = [];

	const notifyCompletion = (job: Job): void => {
		if (shutdown || !job.notifyOnExit || job.notified) return;
		if (job.spawnError) return;
		// An `attach` call is already blocked on this job and will return its
		// output; waking the agent again would just duplicate the result.
		if (job.waiters > 0) return;
		const owner = primarySessionId || currentSessionId;
		if (job.ownerSessionId && owner && job.ownerSessionId !== owner) return;
		// The user asked for this kill; the agent already knows.
		if (job.status === "killed" && (job.reason ?? "killed") === "killed") return;

		// A question is open. Queue the completion instead of triggering a turn —
		// a question is a hard blocker and nothing may run until it is answered.
		if (isBlocked()) {
			if (!deferredNotifications.includes(job)) deferredNotifications.push(job);
			return;
		}

		const tail = readTail(job, 40, 32 * 1024).text;
		const text = formatNotification(summarize(job), tail);
		job.notified = true;
		pi.sendMessage(
			{ customType: CUSTOM_TYPE, content: text, display: true, details: { jobId: job.id } },
			{ triggerTurn: true, deliverAs: "steer" }
		);
	};

	const flushDeferredNotifications = (): void => {
		if (shutdown || isBlocked() || deferredNotifications.length === 0) return;
		const queued = deferredNotifications;
		deferredNotifications = [];
		for (const job of queued) notifyCompletion(job);
	};

	const unsubscribeBlockers = onBlockersChange(flushDeferredNotifications);

	const unsubscribe = onJobEvent((event) => {
		if (event.type === "exit") notifyCompletion(event.job);
		paint();
	});

	// ---------------------------------------------------------------------
	// Session lifecycle
	// ---------------------------------------------------------------------

	pi.on("session_start", (event, ctx) => {
		shutdown = false;
		currentSessionId = ctx.sessionManager.getSessionId();
		if (!primarySessionId && ctx.hasUI && ctx.mode === "tui") primarySessionId = currentSessionId;
		if (primarySessionId === currentSessionId && ctx.hasUI && ctx.mode === "tui") uiCtx = ctx;

		if (event.reason !== "reload") {
			// Jobs from an earlier session in this process must not keep running
			// invisibly. A `/reload`, by contrast, deliberately keeps them alive.
			for (const job of runningJobs()) {
				if (job.ownerSessionId && job.ownerSessionId !== currentSessionId) killJob(job.id);
			}
			if (event.reason === "startup") clearFinishedJobs();
		}

		if (!timer) {
			timer = setInterval(() => {
				enforceLogLimits();
				pruneFinishedJobs(resolveRetentionMs());
				paint();
			}, UI_TICK_MS);
			timer.unref?.();
		}
		paint();
	});

	pi.on("session_shutdown", (event) => {
		shutdown = true;
		if (event.reason === "reload" || event.reason === "quit") unsubscribeBlockers();
		// Deferred completions belong to the session that queued them. A reload
		// keeps the registry but re-evaluates this module, so drop the queue.
		deferredNotifications = [];
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		// Session replacement keeps the same runtime, so keep listening for
		// job events across the switch. A reload destroys the runtime and a
		// quit ends the process; neither needs the listener afterwards.
		if (event.reason === "reload" || event.reason === "quit") unsubscribe();
		if (event.reason !== "reload") {
			killAllJobs(currentSessionId);
			// Finished jobs are cheap to keep, but a fresh session should not
			// inherit the old session's history.
			if (event.reason !== "quit") clearFinishedJobs(currentSessionId);
		}
		if (event.reason !== "reload") {
			uiCtx = undefined;
			widgetVisible = false;
			primarySessionId = "";
		}
	});

	// A compacted transcript loses the tool results that carried job ids.
	// Re-inject a hidden reminder so the plan survives the boundary.
	pi.on("session_compact", (_event, ctx) => {
		const reminder = formatRunningReminder(visibleJobs(ctx.sessionManager.getSessionId()));
		if (reminder) {
			pi.sendMessage({ customType: CUSTOM_TYPE, content: reminder, display: false });
		}
	});

	// ---------------------------------------------------------------------
	// bash override
	// ---------------------------------------------------------------------

	pi.registerTool<typeof BashParams, unknown>({
		name: BASH_TOOL,
		label: "bash",
		description: [
			"Execute a bash command in the current working directory. Returns stdout and stderr.",
			`Output is truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first); if truncated, the full output is saved to a temp file.`,
			"Long commands are moved to the background instead of being killed when the timeout passes:",
			"the result then contains a job id that can be checked with the `jobs` tool.",
			"Use run_in_background to start detached immediately.",
		].join(" "),
		promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: BashParams,
		renderCall: nativeBash.renderCall as ToolDefinition<typeof BashParams, unknown>["renderCall"],
		renderResult: nativeBash.renderResult as ToolDefinition<typeof BashParams, unknown>["renderResult"],

		async execute(_toolCallId, params: BashArgs, signal, onUpdate, ctx) {
			const env = sessionEnv(ctx);
			const shellPath = pi.getSettings().shellPath;
			const deadlineMs = resolveDeadlineMs(pi, params.timeout);

			if (params.run_in_background) {
				const job = startJob({
					command: params.command,
					cwd: ctx.cwd,
					env,
					shellPath,
					notifyOnExit: true,
					ownerSessionId: currentSessionId || undefined,
				});
				if (job.spawnError) {
					throw new Error(`Failed to start background job: ${job.spawnError}`);
				}
				return {
					content: [{ type: "text", text: formatBackgroundNotice(summarize(job)) }],
					details: undefined,
				};
			}

			let detachedJob: Job | undefined;
			const definition = createBashToolDefinition(ctx.cwd, {
				shellPath,
				operations: {
					exec: (command, cwd, execOptions) =>
						runForeground({
							command,
							cwd,
							env: execOptions.env ?? env,
							shellPath,
							signal: execOptions.signal,
							onData: execOptions.onData,
							deadlineMs,
							allowDetach: !isSleepCommand(command),
							ownerSessionId: currentSessionId || undefined,
							onDetach: (job) => {
								detachedJob = job;
							},
						}),
				},
			});

			const result = await definition.execute(
				_toolCallId,
				{ command: params.command },
				signal,
				onUpdate,
				ctx
			);

			if (!detachedJob) return result;

			const job = detachedJob;
			const notice = formatBackgroundNotice(summarize(job));
			const content = [...result.content];
			const last = content[content.length - 1];
			if (last?.type === "text") {
				content[content.length - 1] = { type: "text", text: `${last.text}\n\n${notice}` };
			} else {
				content.push({ type: "text", text: notice });
			}
			return { ...result, content };
		},
	});

	// ---------------------------------------------------------------------
	// jobs tool
	// ---------------------------------------------------------------------

	pi.registerTool<typeof JobsParams, JobsDetails>({
		name: JOBS_TOOL,
		label: "Jobs",
		description: [
			"Inspect and control background shell jobs.",
			"Actions: list (this session's jobs), output (read the log tail), attach (wait for completion, default 120s), kill, search (regex across logs), clear (drop finished jobs).",
			"Job ids look like b7f3k9a2x1 and are returned by bash when a command is backgrounded.",
		].join(" "),
		promptSnippet: "Inspect or stop background shell jobs",
		promptGuidelines: JOBS_GUIDELINES,
		parameters: JobsParams,

		async execute(_toolCallId, params: JobsArgs, signal, onUpdate, ctx) {
			const action = params.action;
			const sessionId = ctx.sessionManager.getSessionId();

			if (action === "list") {
				const jobs = visibleJobs(sessionId);
				return {
					content: [{ type: "text", text: formatJobsList(jobs) }],
					details: { action, jobs },
				};
			}

			if (action === "output") {
				const job = requireJob(params.id);
				const text = tailText(job, params.lines ?? 60);
				if (job.status !== "running") markRead(job.id);
				const summary = summarize(job);
				return {
					content: [{ type: "text", text: formatJobDetails(summary, text) }],
					details: { action, job: summary, output: text, logPath: job.logPath },
				};
			}

			if (action === "attach") {
				const job = requireJob(params.id);
				const timeoutSeconds = Math.min(600, Math.max(1, params.timeout ?? 120));
				const started = Date.now();
				// While we are blocked here, a completion notification would only
				// duplicate the result this call is about to return.
				job.waiters += 1;
				let outcome: Awaited<ReturnType<typeof waitForJob>>;
				try {
					outcome = await waitForJob(
						job,
						timeoutSeconds * 1000,
						(current) => {
							if (!onUpdate) return;
							const tail = readTail(current, 15, 16 * 1024).text;
							onUpdate({
								content: [
									{
										type: "text",
										text: `Waiting for ${current.id} (${elapsedLabel(summarize(current))})…\n\n${tail || "(no output yet)"}`,
									},
								],
								details: {
									action,
									job: summarize(current),
									output: tail,
									logPath: current.logPath,
								},
							});
						},
						signal
					);
				} finally {
					job.waiters -= 1;
				}

				const summary = summarize(job);
				if (summary.status !== "running") markRead(job.id);
				const tail = tailText(job, params.lines ?? 60);
				const header =
					outcome === "timeout"
						? `${job.id} is still running after ${Math.round((Date.now() - started) / 1000)}s.`
						: outcome === "aborted"
							? `Stopped waiting for ${job.id}; it is still running.`
							: `${job.id} ${statusLabel(summary)}.`;
				return {
					content: [{ type: "text", text: `${header}\n\n${tail}` }],
					details: { action, job: summary, output: tail, logPath: job.logPath },
				};
			}

			if (action === "kill") {
				const job = requireJob(params.id);
				const killed = killJob(job.id);
				const summary = summarize(job);
				return {
					content: [
						{
							type: "text",
							text: killed
								? `Killed background job ${job.id} (${previewCommand(job.command)}).`
								: `Job ${job.id} is not running (${statusLabel(summary)}).`,
						},
					],
					details: { action, job: summary },
				};
			}

			if (action === "search") {
				if (!params.pattern) throw new Error("A pattern is required for search.");
				const { matches, scanned } = searchLogs(params.pattern, sessionId);
				const text =
					matches.length === 0
						? `No matches for /${params.pattern}/i in ${scanned} job log${scanned === 1 ? "" : "s"} (last ${MAX_SEARCH_BYTES / 1024 / 1024}MB each).`
						: `${matches.length}${matches.length >= MAX_SEARCH_MATCHES ? "+" : ""} match${matches.length === 1 ? "" : "es"} in ${scanned} job log${scanned === 1 ? "" : "s"}:\n${matches.join("\n")}`;
				return {
					content: [{ type: "text", text }],
					details: { action, output: text },
				};
			}

			// clear
			const removed = clearFinishedJobs(sessionId);
			return {
				content: [
					{
						type: "text",
						text: removed === 0 ? "No finished jobs to clear." : `Cleared ${removed} finished job${removed === 1 ? "" : "s"}.`,
					},
				],
				details: { action, jobs: listJobs() },
			};
		},

		renderCall(args, theme) {
			const target = args.id
				? ` ${theme.fg("accent", args.id)}`
				: args.pattern
					? ` ${theme.fg("dim", args.pattern)}`
					: "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("jobs "))}${theme.fg("muted", args.action)}${target}`,
				0,
				0
			);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details;
			if (expanded && details?.output) {
				return new Text(theme.fg("dim", details.output), 0, 0);
			}
			const first = result.content[0];
			const text = first?.type === "text" ? first.text : "";
			const firstLine = text.split("\n")[0] ?? "";
			return new Text(theme.fg("muted", firstLine), 0, 0);
		},
	});

	// ---------------------------------------------------------------------
	// /bg and Ctrl+Shift+B
	// ---------------------------------------------------------------------

	/** Shared by Ctrl+Shift+B and `/bg detach`. */
	const detachForeground = (ctx: ExtensionContext): void => {
		// The user is answering a question. Detaching work would only queue a
		// completion notification behind the form, so refuse it outright.
		if (isBlocked()) {
			notify(ctx, "A question is waiting for an answer; nothing can be backgrounded.", "warning");
			return;
		}
		const detached = detachAllForeground(ctx.sessionManager.getSessionId());
		notify(
			ctx,
			detached > 0
				? `Backgrounding ${detached} command${detached === 1 ? "" : "s"}…`
				: "No foreground command to background.",
			"info"
		);
	};

	pi.registerShortcut("ctrl+shift+b", {
		description: "Move the running foreground command to the background",
		handler: detachForeground,
	});

	pi.registerCommand(COMMAND, {
		description: "List, inspect, or stop background jobs",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const first = parts[0];

			if (!first || first === "list") {
				notify(ctx, formatJobsList(visibleJobs(ctx.sessionManager.getSessionId())));
				return;
			}

			if (first === "kill") {
				const job = parts[1] ? getJob(parts[1]) : undefined;
				if (!job) {
					notify(ctx, "Usage: /bg kill <id>", "warning");
					return;
				}
				const killed = killJob(job.id);
				notify(ctx, killed ? `Killed ${job.id}.` : `${job.id} is not running.`, killed ? "info" : "warning");
				return;
			}

			if (first === "clear") {
				const removed = clearFinishedJobs(ctx.sessionManager.getSessionId());
				notify(ctx, removed === 0 ? "No finished jobs to clear." : `Cleared ${removed} finished job${removed === 1 ? "" : "s"}.`);
				return;
			}

			if (first === "help") {
				notify(
					ctx,
					[
						"/bg              list background jobs",
						"/bg <id>         show a job's recent output",
						"/bg detach       move the running foreground command to the background",
						"/bg kill <id>    stop a job",
						"/bg clear        drop finished jobs",
						"Ctrl+Shift+B     same as /bg detach (tmux may need /bg detach)",
					].join("\n")
				);
				return;
			}

			if (first === "detach") {
				detachForeground(ctx);
				return;
			}

			const job = getJob(first);
			if (!job) {
				notify(ctx, `No background job with id "${first}".`, "warning");
				return;
			}
			const summary = summarize(job);
			notify(ctx, formatJobDetails(summary, tailText(job, 40)));
		},
	});
}
