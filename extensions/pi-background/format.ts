/**
 * Pure formatting helpers for pi-background. Keeping them separate from the
 * registry makes the text the model sees easy to test and tune.
 */

import type { JobSummary } from "./jobs.ts";

const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_SINGLE = /\x1b[@-_]/g;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** Remove terminal escapes and control bytes from captured output. */
export function stripAnsi(text: string): string {
	return text
		.replace(ANSI_OSC, "")
		.replace(ANSI_CSI, "")
		.replace(ANSI_SINGLE, "")
		.replace(CONTROL, "");
}

export function formatDuration(ms: number): string {
	const safe = Math.max(0, ms);
	if (safe < 1000) return `${safe}ms`;
	const seconds = safe / 1000;
	if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = Math.floor(seconds % 60);
	if (minutes < 60) return rest === 0 ? `${minutes}m` : `${minutes}m${String(rest).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	const mins = minutes % 60;
	return `${hours}h${String(mins).padStart(2, "0")}m`;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** Collapse a command to one readable line. */
export function previewCommand(command: string, maxLength = 80): string {
	const single = command.replace(/\s+/g, " ").trim();
	return single.length > maxLength ? `${single.slice(0, maxLength - 1)}…` : single;
}

export function statusGlyph(status: JobSummary["status"]): string {
	switch (status) {
		case "completed":
			return "✓";
		case "failed":
			return "✗";
		case "killed":
			return "■";
		default:
			return "●";
	}
}

export function statusLabel(job: JobSummary): string {
	if (job.status === "running") return "running";
	if (job.status === "killed") {
		return job.reason && job.reason !== "killed" ? `killed (${job.reason})` : "killed";
	}
	if (job.status === "failed") {
		if (job.signal) return `failed (${job.signal})`;
		return job.exitCode === undefined ? "failed" : `failed (exit ${job.exitCode})`;
	}
	return "completed";
}

/** How long a finished job stays in the live widget before it fades out. */
export const FINISHED_WIDGET_TTL_MS = 30_000;

/** Widget TTL override in seconds, or the default. */
export function resolveWidgetTtlMs(): number {
	const value = Number(process.env.PI_BG_WIDGET_TTL);
	return Number.isFinite(value) && value > 0 ? value * 1000 : FINISHED_WIDGET_TTL_MS;
}

/**
 * True for a finished, unread job that should still be shown in the widget.
 * Completed work fades after `ttl`; it stays in `jobs list` for the longer
 * registry retention, exactly like pi-tasks keeps completed tasks out of the
 * panel but available in `/todos`.
 */
export function isRecentlyFinished(
	job: JobSummary,
	now = Date.now(),
	ttl = FINISHED_WIDGET_TTL_MS
): boolean {
	if (job.status === "running" || job.status === "killed" || job.read) return false;
	return job.endedAt !== undefined && now - job.endedAt < ttl;
}

export function elapsedLabel(job: JobSummary, now = Date.now()): string {
	return formatDuration((job.endedAt ?? now) - job.startedAt);
}

export interface JobLineOptions {
	/** Include the status glyph. */
	glyph?: boolean;
	/** Include the unread marker. */
	unread?: boolean;
	now?: number;
}

export function formatJobLine(job: JobSummary, options: JobLineOptions = {}): string {
	const now = options.now ?? Date.now();
	const glyph = options.glyph === false ? "" : `${statusGlyph(job.status)} `;
	const command = previewCommand(job.command);
	const line = `${glyph}${job.id}  ${statusLabel(job).padEnd(18)} ${elapsedLabel(job, now).padStart(8)}  ${command}`;
	return options.unread && job.status !== "running" && !job.read ? `${line}  (unread)` : line;
}

export function formatJobsList(jobs: JobSummary[], now = Date.now()): string {
	if (jobs.length === 0) return "No background jobs.";
	const running = jobs.filter((job) => job.status === "running").length;
	const finished = jobs.length - running;
	const header = [
		running > 0 ? `${running} running` : undefined,
		finished > 0 ? `${finished} finished` : undefined,
	]
		.filter(Boolean)
		.join(", ");
	const lines = jobs.map((job) => formatJobLine(job, { unread: true, now }));
	return `${header}\n${lines.join("\n")}`;
}

/** One line for the human-facing status widget. */
export function formatWidgetLine(job: JobSummary, now = Date.now()): string {
	const command = previewCommand(job.command, 60);
	return `${statusGlyph(job.status)} ${job.id}  ${elapsedLabel(job, now)}  ${command}`;
}

/** Text appended to a bash tool result when a command was moved to the background. */
export function formatBackgroundNotice(job: JobSummary): string {
	const heading =
		job.status === "running"
			? `Command running in the background with ID: ${job.id}`
			: `Command finished in the background with ID: ${job.id}`;
	const how =
		job.status === "running"
			? `Use jobs({ action: "output", id: "${job.id}" }) to peek, "attach" to wait, or "kill" to stop it.`
			: statusLabel(job);
	return [heading, `Output: ${job.logPath}`, how].join("\n");
}

/** Notification delivered when a background job finishes. */
export function formatNotification(
	job: JobSummary,
	outputTail: string,
	options: { maxOutputLines?: number } = {}
): string {
	const maxOutputLines = options.maxOutputLines ?? 40;
	const lines = stripAnsi(outputTail).split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const tail = lines.slice(-maxOutputLines).join("\n");
	const exit = job.exitCode === undefined || job.exitCode === null ? "unknown" : String(job.exitCode);
	const parts = [
		"<task-notification>",
		`<task-id>${job.id}</task-id>`,
		`<status>${job.status}</status>`,
		`<exit-code>${exit}</exit-code>`,
		`<command>${previewCommand(job.command, 200)}</command>`,
		`<output-file>${job.logPath}</output-file>`,
	];
	if (job.reason) parts.push(`<reason>${job.reason}</reason>`);
	if (job.signal) parts.push(`<signal>${job.signal}</signal>`);
	if (tail) {
		parts.push("<output>", tail, "</output>");
	}
	if (job.status === "failed") {
		parts.push(
			`The command failed. Use jobs({ action: "output", id: "${job.id}" }) to read more of the log.`
		);
	}
	parts.push("</task-notification>");
	return parts.join("\n");
}

/** Compact hidden reminder used after compaction. */
export function formatRunningReminder(jobs: JobSummary[], now = Date.now()): string | undefined {
	const running = jobs.filter((job) => job.status === "running");
	if (running.length === 0) return undefined;
	const lines = running.map((job) => `- ${formatJobLine(job, { now })}`);
	return [
		`${running.length} background job${running.length === 1 ? " is" : "s are"} still running:`,
		...lines,
		'Use jobs({ action: "list" }) to check on them.',
	].join("\n");
}

/** Interactive `/bg` output for one job. */
export function formatJobDetails(job: JobSummary, tail: string): string {
	const header = [
		`${statusGlyph(job.status)} ${job.id} — ${statusLabel(job)}`,
		`Command: ${previewCommand(job.command, 200)}`,
		`Started: ${new Date(job.startedAt).toLocaleTimeString()} · ${elapsedLabel(job)}`,
		`Output: ${job.logPath}`,
	].join("\n");
	return tail ? `${header}\n\n${tail}` : header;
}
