/**
 * Fixed-width bar rendering for the `/context` panel.
 *
 * Notifications are plain text, so bars use block glyphs. They are deliberately
 * simple and testable: a fraction in, a string of exactly `width` cells out.
 */

export const BAR_FILLED = "█";
export const BAR_EMPTY = "░";

/** Clamp a possibly-invalid fraction into 0..1. */
function clampFraction(fraction: number): number {
	if (!Number.isFinite(fraction)) {
		return 0;
	}
	return Math.min(1, Math.max(0, fraction));
}

/**
 * Render a horizontal bar of exactly `width` cells. `fraction` is clamped to
 * 0..1; a positive-but-tiny value still rounds to the nearest cell, so a busy
 * category can show as empty at small widths.
 */
export function renderBar(fraction: number, width = 18, filled = BAR_FILLED, empty = BAR_EMPTY): string {
	if (width <= 0) {
		return "";
	}
	const cells = Math.round(clampFraction(fraction) * width);
	return filled.repeat(cells) + empty.repeat(width - cells);
}

/** Percentage string with a fixed number of decimals: 0.469 -> "46.9%". Not clamped. */
export function formatPercent(fraction: number, digits = 1): string {
	if (!Number.isFinite(fraction)) {
		return "?";
	}
	return `${(fraction * 100).toFixed(digits)}%`;
}
