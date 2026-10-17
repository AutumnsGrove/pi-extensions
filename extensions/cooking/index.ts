/**
 * cooking — put a steady activity glyph in pi's tab title while it works.
 *
 * Claude Code shows a spinner in its tab title while it thinks, which makes a
 * background session readable at a glance. Pi does not: it sets a static title
 * once, and its OSC 9;4 progress indicator is ignored by terminals that do not
 * implement that protocol (notably macOS Terminal.app).
 *
 * This extension swaps the app glyph slot of `ctx.ui.setTitle()` — a title
 * glyph works in every terminal that shows a title, Terminal.app included:
 *
 *   ∞ - auth-refactor - pi-extensions     the agent is working
 *   ◌ - auth-refactor - pi-extensions     waiting on a dialog or approval
 *   ⁇ - auth-refactor - pi-extensions     the pi-q-n-a tool is asking you
 *   π - auth-refactor - pi-extensions     idle (pi's own title)
 *
 * The marks are static rather than animated: with several pi sessions open a
 * rotating title is visual noise, and one steady glyph per state is enough to
 * tell active work, a blocked prompt, and a questionnaire apart at a glance.
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
			? cookingTitle(DEFAULT_APP_TITLE, descriptor, state)
			: `${DEFAULT_APP_TITLE} - ${descriptor}`;
	};

	const paint = (): void => {
		const ctx = ctxRef;
		// setTitle is a no-op in print/JSON modes; skip the work entirely.
		if (!ctx || !ctx.hasUI) return;
		ctx.ui.setTitle(titleFor(ctx));
	};

	const apply = (ctx: ExtensionContext): void => {
		ctxRef = ctx;
		state = deriveState();
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
			"Show a tab-title activity glyph while pi works; on|off toggles",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const head = args.trim().toLowerCase().split(/\s+/).filter(Boolean)[0];

			if (head === "on" || head === "off") {
				enabled = head === "on";
			} else {
				enabled = !enabled;
			}

			ctxRef = ctx;
			state = deriveState();
			paint();
			ctx.ui.notify(
				enabled ? "Cooking tab glyph on" : "Cooking tab glyph off",
				"info"
			);
		},
	});
}
