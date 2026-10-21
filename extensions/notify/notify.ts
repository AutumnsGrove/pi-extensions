/**
 * Pure helpers for the `notify` extension.
 *
 * Everything here is free of pi imports so the text formatting and the
 * terminal-protocol decisions can be unit-tested directly. `index.ts` owns the
 * event wiring and the process spawning.
 */

/**
 * A successful run shorter than this is not worth a banner. Errors, blocked
 * prompts, and questions bypass the threshold because they need attention.
 */
export const MIN_COMPLETION_MS = 3_000;

export const MAX_TITLE = 80;
export const MAX_BODY = 220;

export type NotificationKind =
	| "finished"
	| "error"
	| "aborted"
	| "attention"
	| "question";

export interface Notification {
	kind: NotificationKind;
	title: string;
	body: string;
}

export interface CompletionInput {
	session: string;
	/** Time from the first `agent_start` of the run to settlement. */
	durationMs?: number;
	/** The final assistant text, used for a one-line summary. */
	text?: string;
}

/** Strip control characters and collapse whitespace. */
export function sanitize(text: string): string {
	return text
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Hard-truncate at a word boundary, appending an ellipsis when clipped. */
export function truncate(text: string, max: number): string {
	if (max <= 0) return "";
	if (text.length <= max) return text;
	const clipped = text.slice(0, max - 1);
	const boundary = clipped.lastIndexOf(" ");
	const stem = boundary > max * 0.5 ? clipped.slice(0, boundary) : clipped;
	return `${stem.trimEnd()}…`;
}

/** `1m 24s`, `12s`, `2h 3m` — enough detail to be useful, not noisy. */
export function formatDuration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
	return `${seconds}s`;
}

/**
 * Turn assistant Markdown into one plain line: drop fenced code, images and
 * link targets, strip emphasis and heading/bullet markers, and keep the rest
 * (underscores in identifiers included).
 */
export function plainText(markdown: string): string {
	return markdown
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/~~~[\s\S]*?~~~/g, " ")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/^\s{0,3}#{1,6}\s+/gm, "")
		.replace(/^\s{0,3}>\s?/gm, "")
		.replace(/^\s*[-*+]\s+/gm, "")
		.replace(/\*\*(.+?)\*\*/g, "$1")
		.replace(/(^|\s)\*(\S.*?)\*(?=\s|$)/g, "$1$2")
		.replace(/~~(.+?)~~/g, "$1")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}

/** Plain, truncated one-line summary of an assistant message. */
export function snippet(text: string, max = 160): string {
	return truncate(plainText(text), max);
}

/** Session name when set, otherwise the project folder. */
export function sessionLabel(name: string | undefined, cwd: string): string {
	const trimmed = name?.trim();
	if (trimmed) return trimmed;
	const parts = cwd.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] ?? "pi";
}

const KIND_PREFIX: Record<NotificationKind, string> = {
	finished: "Pi",
	error: "Pi hit an error",
	aborted: "Pi stopped",
	attention: "Pi needs you",
	question: "Pi has a question",
};

export function notificationTitle(
	kind: NotificationKind,
	session: string
): string {
	const label = sanitize(session) || "pi";
	return truncate(`${KIND_PREFIX[kind]} · ${label}`, MAX_TITLE);
}

function make(
	kind: NotificationKind,
	session: string,
	body: string
): Notification {
	return {
		kind,
		title: notificationTitle(kind, session),
		body: truncate(sanitize(body), MAX_BODY),
	};
}

function durationText(durationMs: number | undefined): string | undefined {
	if (!durationMs || durationMs <= 0) return undefined;
	return formatDuration(durationMs);
}

/** A settled run that completed normally. */
export function buildFinished(input: CompletionInput): Notification {
	const duration = durationText(input.durationMs);
	const summary = snippet(input.text ?? "");
	const lead = duration ? `Finished in ${duration}` : "Finished";
	return make("finished", input.session, summary ? `${lead} — ${summary}` : lead);
}

/** A run that ended with a provider or tool error. */
export function buildError(
	input: CompletionInput & { errorMessage?: string }
): Notification {
	const duration = durationText(input.durationMs);
	const detail = snippet(input.errorMessage?.trim() || input.text || "");
	const lead = duration ? `Error after ${duration}` : "Error";
	return make(
		"error",
		input.session,
		detail ? `${lead} — ${detail}` : `${lead} — the run failed.`
	);
}

/** A run the user stopped (Escape). */
export function buildAborted(input: CompletionInput): Notification {
	const duration = durationText(input.durationMs);
	return make(
		"aborted",
		input.session,
		duration ? `Stopped after ${duration}` : "Stopped"
	);
}

/** A blocking extension dialog (confirm, select, editor, …). */
export function buildAttention(input: {
	session: string;
	promptKind: string;
	detail?: string;
	durationMs?: number;
}): Notification {
	const detail = sanitize(input.detail ?? "") || promptLabel(input.promptKind);
	const duration = durationText(input.durationMs);
	return make(
		"attention",
		input.session,
		duration ? `${detail} · after ${duration}` : detail
	);
}

/** The `pi-q-n-a` questionnaire, which deserves its own wording. */
export function buildQuestion(input: {
	session: string;
	question?: string;
	durationMs?: number;
}): Notification {
	const question = snippet(input.question ?? "", MAX_BODY - 40);
	const duration = durationText(input.durationMs);
	const base = question || "Waiting for your answer.";
	return make(
		"question",
		input.session,
		duration ? `${base} · after ${duration}` : base
	);
}

/** A preview sent by `/notify test`. */
export function buildTest(session: string): Notification {
	return make("finished", session, "Desktop notifications are working.");
}

export function promptLabel(kind: string): string {
	switch (kind) {
		case "confirm":
			return "A confirmation is waiting for you.";
		case "select":
			return "A choice is waiting for you.";
		case "input":
			return "An input prompt is waiting for you.";
		case "editor":
			return "An editor is waiting for you.";
		case "custom":
			return "A dialog is waiting for you.";
		default:
			return "Waiting for your input.";
	}
}

/** Whether a notification of this kind clears the minimum-duration bar. */
export function shouldNotify(
	kind: NotificationKind,
	durationMs: number | undefined
): boolean {
	switch (kind) {
		case "error":
		case "attention":
		case "question":
			return true;
		case "aborted":
		case "finished":
			return (durationMs ?? 0) >= MIN_COMPLETION_MS;
	}
}

export type TerminalProtocol = "osc9" | "osc777" | "osc99" | "none";

/**
 * Pick the terminal notification protocol.
 *
 * Ghostty, iTerm2 and WezTerm get OSC 9 — the iTerm2 sequence Claude Code uses
 * and the one proven to reach Ghostty's Notification Center. rxvt-unicode keeps
 * its native OSC 777 (`notify;title;body`), and kitty gets OSC 99. Anything
 * else falls back to an OS command. A pipe disables the OSC path entirely.
 */
export function terminalProtocol(
	env: Record<string, string | undefined>,
	isTTY = true
): TerminalProtocol {
	if (!isTTY) return "none";
	if (
		env.KITTY_WINDOW_ID ||
		/kitty/i.test(env.TERM ?? "") ||
		/kitty/i.test(env.TERM_PROGRAM ?? "")
	) {
		return "osc99";
	}
	if (/^rxvt/i.test(env.TERM ?? "")) return "osc777";
	if (/^(ghostty|iterm\.app|wezterm)$/i.test(env.TERM_PROGRAM ?? "")) {
		return "osc9";
	}
	return "none";
}

/** Bundle id for click-to-focus, keyed off the terminal program. */
export function terminalBundleId(
	env: Record<string, string | undefined>
): string | undefined {
	switch ((env.TERM_PROGRAM ?? "").toLowerCase()) {
		case "ghostty":
			return "com.mitchellh.ghostty";
		case "iterm.app":
			return "com.googlecode.iterm2";
		case "wezterm":
			return "com.github.wez.wezterm";
		default:
			return undefined;
	}
}

/**
 * Encode a notification as a terminal escape sequence. Values are sanitized
 * again here: the body can contain model output, which must never be able to
 * inject control bytes into the terminal stream.
 */
export function encodeTerminal(
	notification: Notification,
	protocol: Exclude<TerminalProtocol, "none">
): string {
	const title = sanitize(notification.title);
	const body = sanitize(notification.body);
	if (protocol === "osc99") {
		return `\x1b]99;i=pi:d=0;${title}\x1b\\\x1b]99;i=pi:p=body;${body}\x1b\\`;
	}
	if (protocol === "osc9") {
		// OSC 9 carries a single text field; keep the session and the message.
		return `\x1b]9;${title} — ${body}\x07`;
	}
	// OSC 777 is `notify;title;body`; a semicolon in the title would split early.
	return `\x1b]777;notify;${title.replace(/;/g, ",")};${body}\x07`;
}

/** Escape a value for an AppleScript double-quoted string literal. */
export function appleScriptString(value: string): string {
	return sanitize(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** The `osascript -e` program for a macOS Notification Center banner. */
export function appleScript(notification: Notification): string {
	return `display notification "${appleScriptString(
		notification.body
	)}" with title "${appleScriptString(notification.title)}"`;
}

export interface DeliveryPlan {
	kind: "stdout" | "exec";
	data?: string;
	command?: string;
	args?: string[];
}

/** Arguments for `terminal-notifier`, the nicer macOS fallback when installed. */
export function terminalNotifierArgs(
	notification: Notification,
	sender: string | undefined
): string[] {
	const args = [
		"-title",
		sanitize(notification.title),
		"-message",
		sanitize(notification.body),
		"-group",
		"pi-notify",
	];
	if (sender) args.push("-sender", sender, "-activate", sender);
	return args;
}

/**
 * Decide how to deliver a notification: an OSC write to stdout when the
 * terminal is recognized, otherwise a macOS notifier (`terminal-notifier` when
 * installed, else `osascript`), `notify-send` on Linux, and nothing elsewhere.
 */
export function planDelivery(
	notification: Notification,
	options: {
		env: Record<string, string | undefined>;
		platform?: NodeJS.Platform;
		isTTY?: boolean;
		macNotifier?: "terminal-notifier" | "osascript";
		sender?: string;
	}
): DeliveryPlan | undefined {
	const protocol = terminalProtocol(options.env, options.isTTY ?? true);
	if (protocol !== "none") {
		return { kind: "stdout", data: encodeTerminal(notification, protocol) };
	}
	const platform = options.platform ?? "darwin";
	if (platform === "darwin") {
		if (options.macNotifier === "terminal-notifier") {
			return {
				kind: "exec",
				command: "terminal-notifier",
				args: terminalNotifierArgs(
					notification,
					options.sender ?? terminalBundleId(options.env)
				),
			};
		}
		return { kind: "exec", command: "osascript", args: ["-e", appleScript(notification)] };
	}
	if (platform === "linux") {
		return {
			kind: "exec",
			command: "notify-send",
			args: [sanitize(notification.title), sanitize(notification.body)],
		};
	}
	return undefined;
}
