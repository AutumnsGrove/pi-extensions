import { highlightCode, type ThemeBg, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * The small slice of pi's `Theme` the questionnaire uses. `Theme` itself
 * satisfies it, and tests can pass an identity stub without building one.
 */
export interface ThemeLike {
	fg(token: ThemeColor, text: string): string;
	bg(token: ThemeBg, text: string): string;
	bold(text: string): string;
}

export const COLUMN_GAP = 3;
export const MIN_OPTION_WIDTH = 28;
export const MIN_PREVIEW_WIDTH = 32;
export const PREVIEW_WIDTH_RATIO = 0.38;
export const MIN_PREVIEW_PANE_WIDTH = 30;
export const MAX_PREVIEW_PANE_WIDTH = 60;
export const MAX_PREVIEW_LINES = 24;

export interface ColumnLayout {
	/** True when options and preview sit next to each other. */
	sideBySide: boolean;
	optionWidth: number;
	previewWidth: number;
	gap: number;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

/**
 * Decide how wide the option and preview columns are for a given terminal
 * width. Falls back to stacked (full-width) when side by side would squeeze
 * either column below its minimum.
 */
export function chooseLayout(totalWidth: number, hasPreviewPane: boolean): ColumnLayout {
	const width = Math.max(1, Math.floor(totalWidth));
	if (!hasPreviewPane) {
		return { sideBySide: false, optionWidth: width, previewWidth: width, gap: 0 };
	}

	const previewWidth = clamp(
		Math.round(width * PREVIEW_WIDTH_RATIO),
		MIN_PREVIEW_PANE_WIDTH,
		MAX_PREVIEW_PANE_WIDTH
	);
	const optionWidth = width - previewWidth - COLUMN_GAP;
	if (optionWidth >= MIN_OPTION_WIDTH && previewWidth >= MIN_PREVIEW_WIDTH) {
		return { sideBySide: true, optionWidth, previewWidth, gap: COLUMN_GAP };
	}
	return { sideBySide: false, optionWidth: width, previewWidth: width, gap: 0 };
}

/** Pad (or leave alone) a line to an exact visible width. */
export function padRight(text: string, width: number): string {
	const visible = visibleWidth(text);
	return visible >= width ? text : text + " ".repeat(width - visible);
}

/**
 * Join a left and a right column line by line. Left lines are padded to
 * `leftWidth` so the right column stays aligned; missing rows become blanks.
 */
export function composeColumns(
	left: string[],
	right: string[],
	leftWidth: number,
	gap: number
): string[] {
	const rows = Math.max(left.length, right.length);
	const out: string[] = [];
	for (let i = 0; i < rows; i++) {
		const leftLine = padRight(left[i] ?? "", leftWidth);
		out.push(`${leftLine}${" ".repeat(gap)}${right[i] ?? ""}`);
	}
	return out;
}

function boxTop(width: number, label: string, theme: ThemeLike): string {
	const title = truncateToWidth(label.trim() || "preview", Math.max(1, width - 6));
	const titleWidth = visibleWidth(title);
	const styledTitle = theme.fg("muted", ` ${title} `);
	const fill = width - 2 - 2 - titleWidth - 1;
	if (fill < 1) {
		return theme.fg("borderMuted", `┌${"─".repeat(Math.max(0, width - 2))}┐`);
	}
	return `${theme.fg("borderMuted", "┌─")}${styledTitle}${theme.fg(
		"borderMuted",
		`${"─".repeat(fill)}┐`
	)}`;
}

function boxBottom(width: number, theme: ThemeLike): string {
	return theme.fg("borderMuted", `└${"─".repeat(Math.max(0, width - 2))}┘`);
}

function boxLine(content: string, width: number, theme: ThemeLike): string {
	const innerWidth = Math.max(1, width - 4);
	const fitted = padRight(truncateToWidth(content, innerWidth), innerWidth);
	return `${theme.fg("borderMuted", "│")} ${fitted} ${theme.fg("borderMuted", "│")}`;
}

/**
 * Render a bordered preview box of exactly `width` visible columns. `preview`
 * is shown verbatim unless `language` is given, in which case it is
 * syntax-highlighted. Long previews are clipped to {@link MAX_PREVIEW_LINES}.
 */
export function renderPreviewBox(
	preview: string | undefined,
	language: string | undefined,
	label: string,
	width: number,
	theme: ThemeLike
): string[] {
	const boxWidth = Math.max(8, Math.floor(width));
	const lines: string[] = [boxTop(boxWidth, label, theme)];

	let contentLines: string[];
	if (preview === undefined || preview.trim().length === 0) {
		contentLines = [theme.fg("dim", "(no preview)")];
	} else if (language && language.trim().length > 0) {
		contentLines = highlightCode(preview.replace(/\n+$/, ""), language.trim());
	} else {
		contentLines = preview.replace(/\n+$/, "").split("\n").map((line) => theme.fg("text", line));
	}

	const clipped = contentLines.slice(0, MAX_PREVIEW_LINES);
	for (const line of clipped) {
		lines.push(boxLine(line, boxWidth, theme));
	}
	if (contentLines.length > MAX_PREVIEW_LINES) {
		const hidden = contentLines.length - MAX_PREVIEW_LINES;
		lines.push(boxLine(theme.fg("dim", `… (${hidden} more lines)`), boxWidth, theme));
	}

	lines.push(boxBottom(boxWidth, theme));
	return lines;
}
