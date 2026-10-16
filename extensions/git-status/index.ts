/**
 * git-status — a live git status widget for pi.
 *
 * Renders one line just above the footer (below the editor), separate from the
 * extension status line that the provider and search extensions already fill:
 *
 *   ⎇ feature/x · 3 modified · +42 −8 · ↑1 ↓2
 *   ⎇ main
 *
 * It reads the same information as ccstatusline's Claude Code widgets — branch,
 * clean/dirty, files changed, and uncommitted insertions/deletions — and adds
 * the changed-file count and ahead/behind drift. State is refreshed after tools
 * run, at the end of a turn, and after user `!` shell commands, with a short
 * debounce so a burst of edits collapses into one git run.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import {
	collectGitStatus,
	formatGitDetails,
	renderGitStatus,
	type GitStatus,
} from "./git.ts";

const WIDGET_KEY = "git-status";
const COMMAND_NAME = "git-status";
/** Collapse bursts of tool/edit events into a single git run. */
const REFRESH_DEBOUNCE_MS = 250;
/** Cap a stalled git invocation so it cannot hold the widget hostage. */
const GIT_TIMEOUT_MS = 5000;
/** Never read an untracked file larger than this just to count its lines. */
const MAX_UNTRACKED_FILE_BYTES = 1024 * 1024;

/**
 * Count the lines an untracked file would add when committed. Returns null for
 * anything we should not read: directories, symlinked escapes, binary files
 * (a NUL byte), or files above {@link MAX_UNTRACKED_FILE_BYTES}.
 */
async function countUntrackedLines(root: string, path: string): Promise<number | null> {
	try {
		const full = join(root, path);
		// Untracked paths come from git, but never read outside the repository.
		const rel = relative(root, full);
		if (rel.startsWith("..") || isAbsolute(rel)) return null;

		const info = await stat(full);
		if (!info.isFile() || info.size > MAX_UNTRACKED_FILE_BYTES) return null;

		const buffer = await readFile(full);
		if (buffer.length === 0) return 0;
		if (buffer.includes(0)) return null;

		let lines = 0;
		for (let index = 0; index < buffer.length; index += 1) {
			if (buffer[index] === 0x0a) lines += 1;
		}
		// A file without a trailing newline still has a final line.
		if (buffer[buffer.length - 1] !== 0x0a) lines += 1;
		return lines;
	} catch {
		return null;
	}
}

export default function gitStatus(pi: ExtensionAPI): void {
	let widgetCtx: ExtensionContext | undefined;
	let current: GitStatus | null = null;
	let enabled = true;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let inFlight = false;
	/** A refresh was requested while one was already running. */
	let pending = false;

	const paint = (): void => {
		const ctx = widgetCtx;
		if (!ctx || !ctx.hasUI || ctx.mode !== "tui") return;

		if (!enabled || current === null) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}

		const snapshot = current;
		// Re-register on every change: pi disposes the old component and repaints.
		// The factory reads the live theme at render time so theme switches recolor.
		ctx.ui.setWidget(
			WIDGET_KEY,
			(_tui, factoryTheme) => ({
				render: (width: number) => [
					renderGitStatus(snapshot, ctx.ui.theme ?? factoryTheme, width),
				],
				invalidate: () => {},
			}),
			{ placement: "belowEditor" }
		);
	};

	const refresh = async (ctx: ExtensionContext): Promise<void> => {
		widgetCtx = ctx;
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		if (inFlight) {
			pending = true;
			return;
		}
		inFlight = true;
		try {
			current = await collectGitStatus(
				(args) => pi.exec("git", args, { cwd: ctx.cwd, timeout: GIT_TIMEOUT_MS }),
				{ countUntrackedLines }
			);
		} catch {
			// A missing git binary or a killed process is not a repository.
			current = null;
		} finally {
			inFlight = false;
		}
		paint();
		if (pending) {
			pending = false;
			await refresh(ctx);
		}
	};

	/** Debounced refresh for events that can fire in bursts. */
	const schedule = (ctx: ExtensionContext): void => {
		widgetCtx = ctx;
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = undefined;
			void refresh(ctx);
		}, REFRESH_DEBOUNCE_MS);
	};

	pi.on("session_start", (_event, ctx) => refresh(ctx));
	pi.on("session_tree", (_event, ctx) => schedule(ctx));
	pi.on("turn_end", (_event, ctx) => schedule(ctx));
	pi.on("tool_execution_end", (_event, ctx) => schedule(ctx));
	pi.on("user_bash", (_event, ctx) => schedule(ctx));

	pi.on("session_shutdown", (_event, ctx) => {
		if (timer) clearTimeout(timer);
		timer = undefined;
		if (ctx.hasUI && ctx.mode === "tui") {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		}
		widgetCtx = undefined;
		current = null;
	});

	pi.registerCommand(COMMAND_NAME, {
		description: "Show git status details; on|off toggles the widget",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const sub = args.trim().toLowerCase();
			if (sub === "on" || sub === "off") {
				enabled = sub === "on";
				if (enabled) {
					await refresh(ctx);
				} else {
					paint();
				}
				ctx.ui.notify(
					enabled ? "Git status widget on" : "Git status widget off",
					"info"
				);
				return;
			}

			await refresh(ctx);
			ctx.ui.notify(
				current ? formatGitDetails(current) : "Not inside a git repository.",
				"info"
			);
		},
	});
}
