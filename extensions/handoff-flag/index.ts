/**
 * handoff-flag — show that a HANDOFF.md is waiting in the repository root.
 *
 * The handoff skill writes `HANDOFF.md`, leaves it untracked, and tells the next
 * reader to delete it. Sessions resume from it and then people forget it is
 * there, so this extension keeps one short line above the footer for as long as
 * the file exists and removes it the moment the file is gone:
 *
 *   ✓ HANDOFF.md · 3h
 *
 * Presence is the only thing it reports, and the age is the nudge that the
 * handoff may already be stale. It refreshes after tools run, at the end of a
 * turn, and after user `!` shell commands; a two-second poll covers the case
 * that matters most, where the file is written or deleted from another terminal
 * while pi sits idle. The poll is a single `stat` of one fixed path, and it only
 * repaints when the age bucket or the size actually changed.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { stat } from "node:fs/promises";
import {
	detectHandoff,
	formatHandoffDetails,
	formatNoHandoff,
	handoffKey,
	renderHandoff,
	type HandoffFile,
} from "./handoff.ts";

const WIDGET_KEY = "handoff-flag";
const COMMAND_NAME = "handoff";
/**
 * Presence is one `stat` of one path, so polling is cheaper than getting the
 * widget wrong: a handoff written or deleted in another terminal shows up (or
 * disappears) within a couple of seconds.
 */
const POLL_INTERVAL_MS = 2000;

export default function handoffFlag(pi: ExtensionAPI): void {
	let widgetCtx: ExtensionContext | undefined;
	let current: HandoffFile | null = null;
	/** What the widget is currently showing, so no-op polls skip the repaint. */
	let paintedKey: string | undefined;
	let enabled = true;
	let poller: ReturnType<typeof setInterval> | undefined;
	let inFlight = false;
	/** A refresh was requested while one was already running. */
	let pending = false;

	const paint = (): void => {
		const ctx = widgetCtx;
		if (!ctx || !ctx.hasUI || ctx.mode !== "tui") return;

		const key = !enabled ? "off" : current === null ? "absent" : handoffKey(current);
		if (key === paintedKey) return;
		paintedKey = key;

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
				render: (width: number) => [renderHandoff(snapshot, ctx.ui.theme ?? factoryTheme, width)],
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
			current = await detectHandoff(ctx.cwd, stat, Date.now());
		} catch {
			// Stat failures are already "absent"; never let one break the widget.
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

	const stopPolling = (): void => {
		if (poller) clearInterval(poller);
		poller = undefined;
	};

	const startPolling = (ctx: ExtensionContext): void => {
		if (poller || !ctx.hasUI || ctx.mode !== "tui") return;
		poller = setInterval(() => {
			if (!widgetCtx) return;
			void refresh(widgetCtx);
		}, POLL_INTERVAL_MS);
		// Never hold the process open on the poll alone.
		poller.unref?.();
	};

	pi.on("session_start", async (_event, ctx) => {
		// A resumed session is exactly when a leftover handoff matters, so start
		// from the file's real state rather than assuming anything.
		await refresh(ctx);
		startPolling(ctx);
	});
	pi.on("turn_end", (_event, ctx) => refresh(ctx));
	pi.on("tool_execution_end", (_event, ctx) => refresh(ctx));
	pi.on("user_bash", (_event, ctx) => refresh(ctx));

	pi.on("session_shutdown", (_event, ctx) => {
		stopPolling();
		if (ctx.hasUI && ctx.mode === "tui") {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		}
		widgetCtx = undefined;
		current = null;
		paintedKey = undefined;
	});

	pi.registerCommand(COMMAND_NAME, {
		description: "Report whether HANDOFF.md is present; on|off toggles the widget",
		handler: async (args, ctx: ExtensionCommandContext) => {
			const sub = args.trim().toLowerCase();
			if (sub === "on" || sub === "off") {
				enabled = sub === "on";
				paintedKey = undefined;
				await refresh(ctx);
				ctx.ui.notify(enabled ? "Handoff widget on" : "Handoff widget off", "info");
				return;
			}

			await refresh(ctx);
			ctx.ui.notify(
				current ? formatHandoffDetails(current) : formatNoHandoff(ctx.cwd),
				"info"
			);
		},
	});
}
