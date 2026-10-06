/**
 * Parsing and formatting helpers for token counts and context-window sizes.
 *
 * Sizes are accepted in the shapes a user would naturally type: a bare integer
 * (`400000`), a thousands suffix (`400k`), or a millions suffix (`1m`, `1.5m`).
 * Formatting renders a compact, fixed-ish label for the status line and the
 * `/context` panel (`400k`, `1M`, `187.4k`).
 */

const SIZE_PATTERN = /^(\d+(?:\.\d+)?)\s*([km])?$/i;

/** Parse a user-supplied token count. Returns undefined for anything invalid. */
export function parseTokenCount(input: string): number | undefined {
	const normalized = input.trim().replace(/[_,]/g, "");
	if (!normalized) {
		return undefined;
	}
	const match = SIZE_PATTERN.exec(normalized);
	if (!match) {
		return undefined;
	}
	const value = Number(match[1]);
	if (!Number.isFinite(value) || value <= 0) {
		return undefined;
	}
	const unit = match[2]?.toLowerCase();
	const multiplier = unit === "k" ? 1_000 : unit === "m" ? 1_000_000 : 1;
	const tokens = Math.round(value * multiplier);
	return tokens > 0 ? tokens : undefined;
}

/** Trim a fractional label to at most one decimal, dropping a trailing `.0`. */
function trimDecimal(value: number): string {
	return value.toFixed(1).replace(/\.0$/, "");
}

/** Format a token count for display: 400000 -> "400k", 187400 -> "187.4k", 1000000 -> "1M". */
export function formatTokenCount(tokens: number): string {
	if (!Number.isFinite(tokens)) {
		return "?";
	}
	const rounded = Math.max(0, Math.round(tokens));
	if (rounded >= 1_000_000) {
		return `${trimDecimal(rounded / 1_000_000)}M`;
	}
	if (rounded >= 1_000) {
		return `${trimDecimal(rounded / 1_000)}k`;
	}
	return String(rounded);
}

/**
 * A filesystem/id-safe slug for a size: 400000 -> "400k", 1500000 -> "1.5m".
 * Lowercase units keep derived model ids tidy (`deepseek-v4.1-flash-400k`).
 */
export function sizeSlug(tokens: number): string {
	return formatTokenCount(tokens).toLowerCase();
}

/** Human label for a derived model name: 400000 -> "400k window". */
export function sizeLabel(tokens: number): string {
	return `${formatTokenCount(tokens)} window`;
}
