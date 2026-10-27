/**
 * transcript-window — keep pi's rendered transcript bounded.
 *
 * The problem: pi's chat container renders every message and tool result since
 * the session began, and the main-screen TUI diffs every rendered line on each
 * frame. Hundreds of tool calls therefore make typing and streaming slower and
 * slower. This extension replaces the chat container's `render` with a window
 * that draws only the most recent components, plus a one-line marker. Older
 * content disappears from the terminal (and its scrollback) but stays in the
 * session file and in model context.
 *
 * The live TUI is captured the same way pi-scroll-lock does it: a temporary
 * widget factory receives the real TUI object. From there we walk the component
 * tree to the document container and its chat child. Both steps are defensive;
 * if pi's internal shape changes, the extension simply does nothing.
 *
 * `/window`          toggle the window
 * `/window on|off`   enable or disable it
 * `/window 100`      keep the last 100 chat components
 * `/window status`   show the current setting
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
	DEFAULT_MAX_ITEMS,
	MIN_MAX_ITEMS,
	clampMaxItems,
	readConfig,
	writeConfig,
	type TranscriptWindowConfig,
} from "./config.ts";
import { createMarkerPlaceholder, renderWindow } from "./window.ts";

const COMMAND_NAME = "window";
const STATE_KEY = "__pi_transcript_window_state__";

interface MouseLayout {
	width: number;
	children: { component: Component; height: number }[];
}

/**
 * The subset of pi's internal `Container` we touch. The fields are runtime
 * properties of the chat container, not public API.
 */
interface ChatContainer extends Component {
	children: Component[];
	addChild(component: Component): void;
	mouseLayout?: MouseLayout;
}

interface TranscriptWindowState {
	config: TranscriptWindowConfig;
	ctx?: ExtensionContext;
	tui?: TUI;
	chat?: ChatContainer;
	originalRender?: (width: number) => string[];
	marker: Component;
}

/**
 * State lives on `globalThis` because `/reload` re-evaluates this module while
 * the patched render closure survives.
 */
function getState(): TranscriptWindowState {
	const holder = globalThis as Record<string, unknown>;
	const existing = holder[STATE_KEY] as TranscriptWindowState | undefined;
	if (existing) return existing;
	const created: TranscriptWindowState = {
		config: readConfig(),
		marker: createMarkerPlaceholder(),
	};
	holder[STATE_KEY] = created;
	return created;
}

/**
 * Capture the live TUI through a temporary widget factory. Widget factories are
 * called synchronously with the real TUI instance, and removing the widget
 * leaves no visible trace.
 */
function captureTui(ctx: ExtensionContext, state: TranscriptWindowState): TUI | undefined {
	if (state.tui) return state.tui;
	try {
		const key = `${STATE_KEY}.capture`;
		ctx.ui.setWidget(key, (tui) => {
			state.tui = tui;
			return createMarkerPlaceholder();
		});
		ctx.ui.setWidget(key, undefined);
	} catch {
		// A future pi may not expose the TUI this way. The extension stays inert.
	}
	return state.tui;
}

/**
 * The document container is the first child of the TUI root and holds
 * `[header, loaded-resources, chat]` in both regular and fullscreen modes.
 */
function findChatContainer(tui: TUI): ChatContainer | undefined {
	const document = tui.children[0] as { children?: unknown } | undefined;
	const children = document?.children;
	if (!Array.isArray(children)) return undefined;
	// Current shape is `[header, loaded-resources, chat]`; fall back to the last
	// child so an extra container inserted before chat does not break us.
	const candidates = [children[2], children[children.length - 1]];
	for (const child of candidates) {
		const candidate = child as Partial<ChatContainer> | undefined;
		if (
			candidate &&
			Array.isArray(candidate.children) &&
			typeof candidate.render === "function" &&
			typeof candidate.addChild === "function"
		) {
			return candidate as ChatContainer;
		}
	}
	return undefined;
}

function markerText(hidden: number, maxItems: number): string {
	const items = hidden === 1 ? "item" : "items";
	const limit = maxItems > 0 ? ` · /${COMMAND_NAME} ${maxItems}` : "";
	return `⋯ ${hidden} earlier ${items} hidden${limit} · /session for the full log`;
}

function installWindow(state: TranscriptWindowState, chat: ChatContainer): void {
	// Always rebuild the patch so `/reload` picks up edits to this module. The
	// original is captured once per container and never wrapped twice.
	if (state.chat !== chat) {
		state.chat = chat;
		state.originalRender = chat.render.bind(chat);
	}
	const original = state.originalRender ?? chat.render.bind(chat);

	const patched = (width: number): string[] => {
		const config = state.config;
		if (!config.enabled) {
			return original(width);
		}

		const result = renderWindow(chat.children, width, {
			maxItems: config.maxItems,
			marker: (hidden) => markerText(hidden, config.maxItems),
			styleMarker: (text) => {
				const theme = state.ctx?.ui.theme;
				return theme ? theme.fg("muted", text) : text;
			},
		});

		// Keep click/hover offsets aligned with what we actually rendered.
		// The marker contributes one row when older items are hidden.
		chat.mouseLayout = {
			width,
			children: [
				...(result.hidden > 0
					? [{ component: state.marker, height: 1 }]
					: []),
				...result.visible.map(({ component, lines }) => ({
					component,
					height: lines.length,
				})),
			],
		};

		return result.lines;
	};

	chat.render = patched;
}

function forceRender(state: TranscriptWindowState): void {
	try {
		state.tui?.requestRender(true);
	} catch {
		// Rendering is best-effort from a command handler.
	}
}

function statusText(state: TranscriptWindowState): string {
	const { enabled, maxItems } = state.config;
	if (!enabled) return "transcript window: off";
	if (maxItems <= 0) return "transcript window: on (unlimited)";
	return `transcript window: on · last ${maxItems} items`;
}

function usage(): string {
	return [
		"Usage: /window [on|off|status|<items>]",
		"",
		"  /window          Toggle the transcript window",
		"  /window on       Show only recent chat items",
		"  /window off      Render the whole transcript again",
		`  /window ${DEFAULT_MAX_ITEMS}        Keep the last ${DEFAULT_MAX_ITEMS} chat items (min ${MIN_MAX_ITEMS})`,
		"  /window status   Show the current setting",
	].join("\n");
}

export default function transcriptWindow(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const state = getState();
		state.ctx = ctx;
		state.config = readConfig();
		const tui = captureTui(ctx, state);
		if (!tui) return;
		const chat = findChatContainer(tui);
		if (!chat) return;
		installWindow(state, chat);
	});

	pi.on("session_shutdown", () => {
		const state = getState();
		state.ctx = undefined;
	});

	pi.registerCommand(COMMAND_NAME, {
		description:
			"Limit how much of the transcript pi renders (keeps recent items only)",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify(
					"/window only applies to the interactive terminal UI",
					"warning"
				);
				return;
			}

			const state = getState();
			state.ctx = ctx;
			const tui = captureTui(ctx, state);
			const chat = tui ? findChatContainer(tui) : undefined;
			if (tui && chat) installWindow(state, chat);

			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = (parts[0] ?? "").toLowerCase();

			const saveAndRender = (): void => {
				writeConfig(state.config);
				forceRender(state);
			};

			if (!sub) {
				state.config = {
					...state.config,
					enabled: !state.config.enabled,
				};
				saveAndRender();
				ctx.ui.notify(statusText(state), "info");
				return;
			}

			if (sub === "on" || sub === "off") {
				state.config = { ...state.config, enabled: sub === "on" };
				saveAndRender();
				ctx.ui.notify(statusText(state), "info");
				return;
			}

			if (sub === "status") {
				ctx.ui.notify(statusText(state), "info");
				return;
			}

			// Accept both `/window 100` and `/window items 100`.
			const rawValue = sub === "items" ? parts[1] : sub;
			if (rawValue && /^\d+$/.test(rawValue)) {
				const value = Number(rawValue);
				if (!Number.isFinite(value) || value < MIN_MAX_ITEMS) {
					ctx.ui.notify(
						`Keep at least ${MIN_MAX_ITEMS} items, or use /window off`,
						"warning"
					);
					return;
				}
				state.config = {
					...state.config,
					enabled: true,
					maxItems: clampMaxItems(value),
				};
				saveAndRender();
				ctx.ui.notify(statusText(state), "info");
				return;
			}

			ctx.ui.notify(usage(), "warning");
		},
	});
}
