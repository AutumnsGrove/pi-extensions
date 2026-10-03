/**
 * The part of thinking-box that touches pi's internals.
 *
 * Pi has no public renderer hook for assistant thinking blocks, so this
 * extension patches the exported `AssistantMessageComponent` prototype. That
 * class is shared with the running app because extensions resolve
 * `@earendil-works/pi-coding-agent` through pi's virtual modules (see PLAN.md).
 *
 * Everything here is defensive: if the shape of the component changes, the
 * patch falls back to pi's original behaviour instead of crashing a turn.
 */

import {
	AssistantMessageComponent,
	truncateToVisualLines,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	MouseRegion,
	truncateToWidth,
	visibleWidth,
	type Component,
} from "@earendil-works/pi-tui";
import {
	DEFAULT_PREVIEW_LINES,
	EXPAND_HINT,
	ThinkingStatsTracker,
	extractThinkingRuns,
	formatHeader,
	type KeyedMessage,
	type ThinkingStatsRecord,
} from "./stats.ts";

/**
 * Mutating state is kept on `globalThis` because `/reload` re-evaluates the
 * extension module while the prototype patch (and its closure) survives.
 */
/**
 * Bump when a built-in default changes so `/reload` picks it up. Stored state
 * survives reloads (the prototype patch does), so this is the migration hook.
 */
const DEFAULTS_VERSION = 2;

interface ThinkingBoxState {
	patched: boolean;
	/** Master switch: on for interactive terminal sessions. */
	enabled: boolean;
	/** User preference, preserved across sessions. */
	userEnabled: boolean;
	/** Whether boxes are currently expanded to the full trace. */
	expanded: boolean;
	previewLines: number;
	/** True once the user sets preview lines, so defaults never clobber it. */
	previewLinesOverridden: boolean;
	defaultsVersion: number;
	theme: Theme | undefined;
	tracker: ThinkingStatsTracker;
	/** Live AssistantMessageComponent instances, for command-driven re-renders. */
	live: Set<unknown>;
}

const STATE_KEY = "__pi_thinking_box_state__";

function createState(): ThinkingBoxState {
	return {
		patched: false,
		enabled: false,
		userEnabled: true,
		expanded: false,
		previewLines: DEFAULT_PREVIEW_LINES,
		previewLinesOverridden: false,
		defaultsVersion: DEFAULTS_VERSION,
		theme: undefined,
		tracker: new ThinkingStatsTracker(),
		live: new Set(),
	};
}

export function getThinkingBoxState(): ThinkingBoxState {
	const holder = globalThis as Record<string, unknown>;
	const existing = holder[STATE_KEY] as ThinkingBoxState | undefined;
	if (existing) return existing;
	const created = createState();
	holder[STATE_KEY] = created;
	return created;
}

export function setThinkingBoxTheme(theme: Theme | undefined): void {
	getThinkingBoxState().theme = theme;
}

export function setThinkingBoxPreviewLines(lines: number): void {
	const state = getThinkingBoxState();
	state.previewLines = Math.min(50, Math.max(1, Math.floor(lines)));
	state.previewLinesOverridden = true;
}

export function seedThinkingStats(records: readonly ThinkingStatsRecord[]): void {
	getThinkingBoxState().tracker.seed(records);
}

export function clearThinkingStats(): void {
	getThinkingBoxState().tracker.clear();
}

/** Set the global expanded state and refresh every live thinking box. */
export function setThinkingBoxExpanded(expanded: boolean): void {
	const state = getThinkingBoxState();
	state.expanded = expanded;
	for (const component of state.live) {
		const patched = component as { setExpanded?: (value: boolean) => void };
		patched.setExpanded?.(expanded);
	}
}

export function toggleThinkingBoxExpanded(): boolean {
	const next = !getThinkingBoxState().expanded;
	setThinkingBoxExpanded(next);
	return next;
}

/**
 * Renders the tail of a thinking run, clipped to a fixed number of visual
 * lines for the terminal width. Lines are re-styled each render so theme
 * changes are picked up.
 */
class ThinkingPreview implements Component {
	constructor(
		private readonly text: string,
		private readonly lines: number,
		private readonly getTheme: () => Theme | undefined,
		private readonly outputPad: number
	) {}

	invalidate(): void {
		// Stateless: render() recomputes from text + width.
	}

	render(width: number): string[] {
		if (width <= 0) return [];

		const theme = this.getTheme();

		// Only the tail is shown, so there is no need to lay out the whole
		// trace on every streaming token. Keep a generous slice that is always
		// enough to fill the preview plus a couple of wrapped lines.
		const budget = Math.max(2_000, this.lines * 400);
		const source =
			this.text.length > budget ? this.text.slice(-budget) : this.text;

		const { visualLines, skippedCount } = truncateToVisualLines(
			source,
			this.lines,
			width,
			this.outputPad
		);

		const styled = visualLines.map((line) => {
			const trimmed = line.replace(/\s+$/, "");
			return theme ? theme.italic(theme.fg("thinkingText", trimmed)) : trimmed;
		});

		// Mark hidden earlier lines without adding a line: prefix the first
		// visible line with an ellipsis, shortening it so it still fits.
		if (skippedCount > 0 && styled.length > 0 && width > 2) {
			const marker = theme ? theme.fg("muted", "… ") : "… ";
			const first = truncateToWidth(styled[0] ?? "", Math.max(0, width - 2));
			styled[0] = marker + first;
		}

		// Guarantee the preview never exceeds the column budget, even where the
		// underlying Text padding misbehaves at tiny widths.
		return styled.map((line) => truncateToWidth(line, width));
	}
}

/**
 * Top rule for a thinking box: a small left rule, the header label, a filler
 * rule, and an optional right-aligned keybinding hint.
 *
 *   ── ▸ Thinking for 12s, ~3.4k tokens ────────────── ctrl+o to expand
 */
function headerRule(
	header: string,
	hint: string | undefined,
	width: number,
	theme: Theme | undefined
): string {
	const rule = (count: number): string => {
		const line = "─".repeat(Math.max(0, count));
		return theme ? theme.fg("borderMuted", line) : line;
	};

	const available = Math.max(0, width);
	const hintText = hint ? ` ${hint}` : "";
	// Keep the hint from ever exceeding the line, then give the label the rest.
	const hintBudget = Math.max(0, available - 2);
	const styledHint = hintText
		? truncateToWidth(
				theme ? theme.fg("muted", hintText) : hintText,
				hintBudget
			)
		: "";
	const hintWidth = visibleWidth(styledHint);
	const spacer = hintWidth > 0 ? 1 : 0;
	const maxLabelWidth = Math.max(0, available - hintWidth - spacer);
	const label = truncateToWidth(` ${header} `, maxLabelWidth);
	const labelWidth = visibleWidth(label);

	const remaining = Math.max(0, available - labelWidth - hintWidth);
	const left = Math.min(3, remaining);
	const middle = remaining - left;

	return rule(left) + label + rule(middle) + styledHint;
}

/**
 * The collapsible thinking box. Reuses pi's own rendered Markdown component
 * for the expanded body, so expanding looks exactly like the built-in trace
 * (plus the header line).
 */
class ThinkingBox implements Component {
	private readonly preview: ThinkingPreview;

	constructor(
		private readonly options: {
			header: string;
			fullText: string;
			expanded: boolean;
			markdown: Component | undefined;
			previewLines: number;
			outputPad: number;
			getTheme: () => Theme | undefined;
		}
	) {
		this.preview = new ThinkingPreview(
			options.fullText,
			options.previewLines,
			options.getTheme,
			options.outputPad
		);
	}

	invalidate(): void {
		this.options.markdown?.invalidate();
		this.preview.invalidate();
	}

	render(width: number): string[] {
		if (width <= 0) return [];

		const theme = this.options.getTheme();
		const header = theme
			? theme.bold(theme.fg("accent", this.options.header))
			: this.options.header;
		const hint = this.options.expanded ? undefined : EXPAND_HINT;
		const top = headerRule(header, hint, width, theme);

		if (this.options.expanded) {
			const body = this.options.markdown
				? this.options.markdown.render(width)
				: this.preview.render(width);
			return [top, ...body];
		}

		const bottom = theme ? theme.fg("borderMuted", "─".repeat(width)) : "─".repeat(width);
		return [top, ...this.preview.render(width), bottom];
	}
}

type AssistantComponentLike = {
	contentContainer?: { children?: unknown[]; invalidate?: () => void };
	hideThinkingBlock?: boolean;
	thinkingVisibilityOverrides?: { clear?: () => void };
	lastMessage?: unknown;
	isStreaming?: boolean;
	outputPad?: number;
	__tb_expanded?: boolean;
	updateContent?: (message: unknown, isStreaming?: boolean) => void;
	setExpanded?: (expanded: boolean) => void;
};

/** Read N from a message's usage without assuming the provider reports it. */
function reasoningTokensOf(message: unknown): number {
	const usage = (message as { usage?: { reasoning?: number } } | undefined)?.usage;
	const reasoning = usage?.reasoning;
	return typeof reasoning === "number" && reasoning > 0 ? reasoning : 0;
}

function replaceThinking(
	component: AssistantComponentLike,
	message: unknown,
	isStreaming: boolean
): void {
	const content = (message as { content?: readonly { type: string; thinking?: string }[] })
		?.content;
	const runs = extractThinkingRuns(content);
	if (runs.length === 0) return;

	const state = getThinkingBoxState();
	const tracker = state.tracker;
	const fullText = runs.join("\n\n");
	const stats = tracker.observe(
		message as KeyedMessage,
		isStreaming,
		fullText,
		reasoningTokensOf(message)
	);
	const header = formatHeader({
		streaming: isStreaming,
		expanded: Boolean(component.__tb_expanded ?? state.expanded),
		stats,
	});
	const expanded = Boolean(component.__tb_expanded ?? state.expanded);
	const getTheme = () => getThinkingBoxState().theme;

	const container = component.contentContainer;
	const children = container?.children;
	if (!Array.isArray(children)) return;

	let runIndex = 0;
	for (let i = 0; i < children.length; i++) {
		const child = children[i];
		if (!(child instanceof MouseRegion)) continue;

		const markdown = (child as unknown as { child?: Component }).child;
		const runText = runs[runIndex] ?? "";
		children[i] = new ThinkingBox({
			header,
			fullText: runText,
			expanded,
			markdown,
			previewLines: state.previewLines,
			outputPad: component.outputPad ?? 1,
			getTheme,
		});
		runIndex++;
	}

	container?.invalidate?.();
}

/**
 * Install the patch once. Safe to call on every extension load/reload.
 */
export function installThinkingBox(): void {
	const state = getThinkingBoxState();

	// Apply a changed built-in default on reload, unless the user set their
	// own value with `/thinking-box lines`. The old patch closure shares this
	// state but never runs this migration, so it cannot fight the new default.
	if (state.defaultsVersion !== DEFAULTS_VERSION) {
		if (!state.previewLinesOverridden) {
			state.previewLines = DEFAULT_PREVIEW_LINES;
		}
		state.defaultsVersion = DEFAULTS_VERSION;
	}

	const proto = AssistantMessageComponent.prototype as unknown as AssistantComponentLike & {
		__tb_installed?: boolean;
		__tb_originalUpdateContent?: (
			message: unknown,
			isStreaming?: boolean
		) => void;
	};

	if (proto.__tb_installed && state.patched) return;

	proto.__tb_installed = true;
	state.patched = true;

	if (typeof proto.__tb_originalUpdateContent !== "function") {
		proto.__tb_originalUpdateContent = proto.updateContent;
	}
	const original = proto.__tb_originalUpdateContent;

	proto.updateContent = function patchedUpdateContent(
		this: AssistantComponentLike,
		message: unknown,
		isStreaming = Boolean(this.isStreaming)
	): void {
		const current = getThinkingBoxState();
		if (!current.enabled || !original) {
			original?.call(this, message, isStreaming);
			return;
		}

		current.live.add(this);

		// Force the built-in to produce a thinking component we can replace.
		const previousHide = this.hideThinkingBlock;
		this.hideThinkingBlock = false;
		this.thinkingVisibilityOverrides?.clear?.();
		try {
			original.call(this, message, isStreaming);
		} finally {
			this.hideThinkingBlock = previousHide;
		}

		try {
			replaceThinking(this, message, isStreaming);
		} catch {
			// A future pi layout change must never break a turn; fall back to
			// whatever the original component already rendered.
		}
	};

	if (typeof proto.setExpanded !== "function") {
		proto.setExpanded = function patchedSetExpanded(
			this: AssistantComponentLike,
			expanded: boolean
		): void {
			const current = getThinkingBoxState();
			this.__tb_expanded = expanded;
			current.expanded = expanded;
			if (!current.enabled) return;
			const live = this as unknown as {
				lastMessage?: unknown;
				isStreaming?: boolean;
				updateContent?: (message: unknown, isStreaming?: boolean) => void;
			};
			if (live.lastMessage !== undefined) {
				live.updateContent?.(live.lastMessage, Boolean(live.isStreaming));
			}
		};
	}
}
