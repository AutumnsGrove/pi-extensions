/**
 * thinking-box — collapsible, timed thinking traces for pi.
 *
 * Thinking streams into a short bordered box showing how long the model has
 * been thinking and how many reasoning tokens it has spent. Ctrl+O (pi's
 * "expand tool output" action) expands every box to the full trace; a second
 * press collapses it again. Stats are remembered for the session and
 * re-rendered correctly after scrolling or reloading.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	clearThinkingStats,
	getThinkingBoxState,
	installThinkingBox,
	seedThinkingStats,
	setThinkingBoxExpanded,
	setThinkingBoxPreviewLines,
	setThinkingBoxTheme,
	toggleThinkingBoxExpanded,
} from "./patch.ts";
import {
	collectStatsRecords,
	extractThinkingRuns,
	messageKey,
	STATS_ENTRY_TYPE,
} from "./stats.ts";

const STATUS_KEY = "thinking-box";

export default function thinkingBox(pi: ExtensionAPI): void {
	// Patch immediately so the first assistant message is already boxed.
	installThinkingBox();

	pi.on("session_start", (_event, ctx) => {
		const state = getThinkingBoxState();
		state.enabled = ctx.mode === "tui" && state.userEnabled;
		state.live.clear();
		setThinkingBoxTheme(ctx.ui.theme);
		clearThinkingStats();

		try {
			seedThinkingStats(
				collectStatsRecords(ctx.sessionManager.getBranch())
			);
		} catch {
			// Stats are a nicety; a session without them still renders.
		}
	});

	pi.on("message_end", (event, _ctx) => {
		if (event.message.role !== "assistant") return;
		const state = getThinkingBoxState();
		if (!state.enabled) return;

		const runs = extractThinkingRuns(event.message.content);
		if (runs.length === 0) return;

		const stats = state.tracker.observe(
			event.message,
			false,
			runs.join("\n\n"),
			event.message.usage?.reasoning ?? 0
		);

		try {
			pi.appendEntry(STATS_ENTRY_TYPE, {
				key: messageKey(event.message),
				...stats,
			});
		} catch {
			// Non-fatal: the in-memory stats still drive this session.
		}
	});

	pi.registerCommand("thinking-box", {
		description:
			"Control thinking boxes: no args toggles; on/off, lines <n>, expand, collapse",
		handler: async (args, ctx) => {
			const state = getThinkingBoxState();
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = (parts[0] ?? "").toLowerCase();

			const flash = (): void => {
				ctx.ui.setStatus(
					STATUS_KEY,
					state.expanded ? "thinking: expanded" : "thinking: collapsed"
				);
				setTimeout(() => ctx.ui.setStatus(STATUS_KEY, undefined), 1500);
			};

			if (sub === "on" || sub === "off") {
				state.userEnabled = sub === "on";
				state.enabled = state.userEnabled && ctx.mode === "tui";
				ctx.ui.notify(
					`Thinking boxes ${state.enabled ? "on" : "off"}`,
					"info"
				);
				return;
			}

			if (sub === "lines") {
				const value = Number(parts[1]);
				if (!Number.isFinite(value) || value < 1) {
					ctx.ui.notify("Usage: /thinking-box lines <n>", "warning");
					return;
				}
				setThinkingBoxPreviewLines(value);
				ctx.ui.notify(
					`Thinking preview lines: ${state.previewLines}`,
					"info"
				);
				return;
			}

			if (sub === "expand" || sub === "collapse") {
				setThinkingBoxExpanded(sub === "expand");
				flash();
				ctx.ui.notify(
					sub === "expand"
						? "Thinking boxes expanded"
						: "Thinking boxes collapsed",
					"info"
				);
				return;
			}

			if (sub && sub !== "toggle") {
				ctx.ui.notify(
					"Usage: /thinking-box [on|off|lines <n>|expand|collapse]",
					"warning"
				);
				return;
			}

			const expanded = toggleThinkingBoxExpanded();
			flash();
			ctx.ui.notify(
				expanded ? "Thinking boxes expanded" : "Thinking boxes collapsed",
				"info"
			);
		},
	});
}
