/**
 * cooking — animate pi's tab-title glyph while it is working.
 *
 * Claude Code shows a spinner in its tab title while it thinks, which makes a
 * background session readable at a glance. Pi does not: it sets a static title
 * once, and its OSC 9;4 progress indicator is ignored by terminals that do not
 * implement that protocol (notably macOS Terminal.app).
 *
 * This extension animates the app glyph slot of `ctx.ui.setTitle()` — a title
 * glyph works in every terminal that shows a title, Terminal.app included:
 *
 *   ∑ - auth-refactor - pi-extensions     agent is working (π morphs)
 *   ◌ - auth-refactor - pi-extensions     waiting on a dialog or approval
 *   ⁇ - auth-refactor - pi-extensions     the pi-q-n-a tool is asking you
 *   π - auth-refactor - pi-extensions     idle (pi's own title)
 *
 * The three non-idle states use different marks so active work, a blocked
 * prompt, and a questionnaire are told apart at a glance. On settle the title
 * returns to pi's own format.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import {
	DEFAULT_APP_TITLE,
	cookingTitle,
	sessionDescriptor,
	type CookingState,
} from "./spinner.ts";

const COMMAND_NAME = "cooking";
/** The tool that renders pi's multiple-choice form. */
const ASK_TOOL_NAME = "pi-q-n-a";
/** Default ms per working frame: slow enough to read a glyph before it changes. */
const DEFAULT_FRAME_MS = 400;
/** Clamp for `/cooking speed`, so the title cannot strobe or crawl. */
const MIN_FRAME_MS = 40;
const MAX_FRAME_MS = 2000;

export default function cooking(pi: ExtensionAPI): void {
	let enabled = true;
	/** Agent loop is running (including retries and queued continuations). */
	let runActive = false;
	/** Context compaction is running, with or without an agent run. */
	let compacting = false;
	/** A blocking extension dialog is waiting for the user. */
	let promptActive = false;
	/** In-flight `pi-q-n-a` calls, keyed by tool call id. */
	const askCalls = new Set<string>();
	let state: CookingState = "idle";
	let tick = 0;
	let frameMs = DEFAULT_FRAME_MS;
	let timer: ReturnType<typeof setInterval> | undefined;
	let ctxRef: ExtensionContext | undefined;

	const deriveState = (): CookingState => {
		// A pi-q-n-a form also raises ui_prompt_start, so it must win over waiting.
		if (askCalls.size > 0) return "asking";
		if (promptActive) return "waiting";
		if (runActive || compacting) return "working";
		return "idle";
	};

	/** The full title for the current state, reading the live session name. */
	const titleFor = (ctx: ExtensionContext): string => {
		const descriptor = sessionDescriptor(
			ctx.sessionManager.getSessionName(),
			basename(ctx.cwd)
		);
		return enabled
			? cookingTitle(DEFAULT_APP_TITLE, descriptor, state, tick)
			: `${DEFAULT_APP_TITLE} - ${descriptor}`;
	};

	const paint = (): void => {
		const ctx = ctxRef;
		// setTitle is a no-op in print/JSON modes; skip the work entirely.
		if (!ctx || !ctx.hasUI) return;
		ctx.ui.setTitle(titleFor(ctx));
	};

	const stopTimer = (): void => {
		if (timer) clearInterval(timer);
		timer = undefined;
	};

	const ensureTimer = (): void => {
		const ctx = ctxRef;
		if (!ctx?.hasUI || !enabled || state !== "working" || timer) return;
		// Waiting and asking are static marks; only working animates.
		timer = setInterval(() => {
			tick += 1;
			paint();
		}, frameMs);
	};

	/** Re-arm the animation after a live speed change. */
	const restartTimer = (): void => {
		stopTimer();
		ensureTimer();
	};

	const apply = (ctx: ExtensionContext): void => {
		ctxRef = ctx;
		state = deriveState();
		if (state === "idle") {
			stopTimer();
			// Leave zero as the first frame so a new run starts consistently.
			tick = 0;
		} else if (state !== "working") {
			stopTimer();
		} else {
			ensureTimer();
		}
		paint();
	};

	pi.on("session_start", (_event, ctx) => apply(ctx));
	pi.on("session_info_changed", (_event, ctx) => {
		ctxRef = ctx;
		paint();
	});

	pi.on("agent_start", (_event, ctx) => {
		runActive = true;
		apply(ctx);
	});
	pi.on("agent_settled", (_event, ctx) => {
		runActive = false;
		// Safety net: a compaction cancelled before its failed event landed.
		compacting = false;
		apply(ctx);
	});

	pi.on("session_before_compact", (_event, ctx) => {
		compacting = true;
		apply(ctx);
	});
	pi.on("session_compact", (_event, ctx) => {
		compacting = false;
		apply(ctx);
	});
	pi.on("session_compact_failed", (_event, ctx) => {
		compacting = false;
		apply(ctx);
	});

	pi.on("ui_prompt_start", (_event, ctx) => {
		promptActive = true;
		apply(ctx);
	});
	pi.on("ui_prompt_end", (_event, ctx) => {
		promptActive = false;
		apply(ctx);
	});

	pi.on("tool_execution_start", (event, ctx) => {
		if (event.toolName !== ASK_TOOL_NAME) return;
		askCalls.add(event.toolCallId);
		apply(ctx);
	});
	pi.on("tool_execution_end", (event, ctx) => {
		if (event.toolName !== ASK_TOOL_NAME) return;
		askCalls.delete(event.toolCallId);
		apply(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stopTimer();
		runActive = false;
		compacting = false;
		promptActive = false;
		askCalls.clear();
		ctxRef = ctx;
		state = "idle";
		paint();
	});

	pi.registerCommand(COMMAND_NAME, {
		description:
			"Animate the tab-title glyph while pi works; on|off toggles, speed <ms> sets the frame time",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			const head = parts[0];

			if (head === "speed") {
				const ms = Number(parts[1]);
				if (!Number.isFinite(ms)) {
					ctx.ui.notify(
						`Cooking speed is ${frameMs}ms per frame; use /cooking speed <ms>`,
						"warning"
					);
					return;
				}
				frameMs = Math.min(
					MAX_FRAME_MS,
					Math.max(MIN_FRAME_MS, Math.round(ms))
				);
				ctxRef = ctx;
				state = deriveState();
				restartTimer();
				paint();
				ctx.ui.notify(`Cooking speed ${frameMs}ms per frame`, "info");
				return;
			}

			if (head === "on" || head === "off") {
				enabled = head === "on";
			} else {
				enabled = !enabled;
			}

			ctxRef = ctx;
			state = deriveState();
			if (enabled && state === "working") {
				ensureTimer();
			} else {
				stopTimer();
			}
			paint();
			ctx.ui.notify(
				enabled ? "Cooking tab spinner on" : "Cooking tab spinner off",
				"info"
			);
		},
	});
}
