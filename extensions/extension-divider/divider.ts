/**
 * Status-line formatting for the extension-divider extension.
 *
 * Kept free of runtime pi imports so the joining rules are unit-testable
 * without a terminal; the only import is a type, which is erased.
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";

/** Default separator inserted between adjacent status items. */
export const DEFAULT_DIVIDER = "///";

/**
 * Theme roles whose colors spell out the active flag, in spectrum order. The
 * pride theme pack sets these to its stripes, so sampling them recolours the
 * separator without hard-coding any hex here.
 */
export const PRIDE_DIVIDER_ROLES: readonly ThemeColor[] = [
	"syntaxKeyword",
	"syntaxFunction",
	"syntaxVariable",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
];

/** Whether a theme belongs to the pride pack (`pride`, `pride-trans`, ...). */
export const isPrideTheme = (name: string | undefined): boolean =>
	name?.startsWith("pride") ?? false;

/**
 * Indices into `values` that spread `count` samples across the ramp.
 *
 * Duplicate values are collapsed first, so a two-stripe flag alternates its two
 * colors instead of repeating one of them, while a six-stripe rainbow is
 * sampled evenly across its full length.
 */
export function sampleIndices(
	values: readonly string[],
	count: number
): number[] {
	if (count <= 0) {
		return [];
	}
	const seen = new Set<string>();
	const distinct: number[] = [];
	values.forEach((value, index) => {
		if (!seen.has(value)) {
			seen.add(value);
			distinct.push(index);
		}
	});
	if (distinct.length === 0) {
		return [];
	}
	if (count === 1) {
		return [distinct[0] as number];
	}
	if (distinct.length >= count) {
		return Array.from(
			{ length: count },
			(_, index) =>
				distinct[
					Math.round((index * (distinct.length - 1)) / (count - 1))
				] as number
		);
	}
	return Array.from(
		{ length: count },
		(_, index) => distinct[index % distinct.length] as number
	);
}

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
