/**
 * Pure transcript-window rendering.
 *
 * Pi's chat container renders every message and tool result that has ever been
 * added to it. The main-screen TUI then diffs every rendered line against the
 * previous frame, so a long session makes each keystroke and every streaming
 * token do work proportional to the whole transcript. This helper renders only
 * the trailing components and replaces the rest with a one-line marker.
 *
 * It is deliberately component-based rather than line-based: appending to a
 * component keeps the prefix stable, so the TUI can still do an incremental
 * update. A line-based window would shift every line whenever one new line
 * arrived and force a full scrollback redraw on every frame.
 */

import { truncateToWidth, type Component } from "@earendil-works/pi-tui";

export interface WindowRenderOptions {
	/** Number of trailing components to render. 0 or less means no limit. */
	maxItems: number;
	/** Build the marker shown when older components are hidden. */
	marker: (hidden: number, total: number) => string;
	/** Style the marker with the active theme. */
	styleMarker: (text: string) => string;
}

export interface VisibleComponent {
	component: Component;
	lines: string[];
}

export interface WindowRenderResult {
	lines: string[];
	/** Number of leading components that were not rendered. */
	hidden: number;
	/** Components that were rendered, in transcript order. */
	visible: VisibleComponent[];
}

/** Normalize a user-supplied item limit. Non-finite values disable the cap. */
export function normalizeMaxItems(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.floor(value));
}

/**
 * Render the last `maxItems` components, prepending a marker when anything was
 * hidden. Children are only rendered when they are part of the visible tail, so
 * the work no longer scales with the total transcript length.
 */
export function renderWindow(
	children: readonly Component[],
	width: number,
	options: WindowRenderOptions
): WindowRenderResult {
	const total = children.length;
	const limit = normalizeMaxItems(options.maxItems);
	const hidden = limit > 0 ? Math.max(0, total - limit) : 0;
	const lines: string[] = [];
	const visible: VisibleComponent[] = [];

	if (hidden > 0) {
		const marker = options.marker(hidden, total);
		lines.push(truncateToWidth(options.styleMarker(marker), width));
	}

	for (let index = hidden; index < total; index += 1) {
		const component = children[index];
		if (!component) continue;
		const childLines = component.render(width);
		visible.push({ component, lines: childLines });
		for (const line of childLines) {
			lines.push(line);
		}
	}

	return { lines, hidden, visible };
}

/** A zero-height component used to keep mouse offsets aligned with the marker row. */
export function createMarkerPlaceholder(): Component {
	return {
		render: () => [],
		invalidate: () => {},
	};
}
