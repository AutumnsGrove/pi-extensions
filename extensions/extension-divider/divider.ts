/**
 * Status-line formatting for the extension-divider extension.
 *
 * Kept free of pi imports so the joining rules are unit-testable without a
 * terminal.
 */

/** Default separator inserted between adjacent status items. */
export const DEFAULT_DIVIDER = "///";

/**
 * Collapse control characters so a status cannot break the single footer line.
 * Mirrors pi's own footer sanitisation, so a single item is unchanged.
 */
export const sanitizeStatusText = (text: string): string =>
	text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();

/**
 * Join extension statuses the way pi's footer orders them (key ascending),
 * placing `divider` between adjacent visible items.
 *
 * `divider` may contain ANSI styling; it is joined verbatim. Empty statuses are
 * dropped so they cannot leave a dangling or doubled separator.
 */
export const joinStatuses = (
	statuses: ReadonlyMap<string, string>,
	divider: string
): string =>
	Array.from(statuses.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => sanitizeStatusText(text))
		.filter((text) => text.length > 0)
		.join(divider);
