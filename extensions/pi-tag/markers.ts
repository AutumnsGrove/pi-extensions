/**
 * Hidden markers pi-tag writes into its comment.
 *
 * They are HTML comments, invisible in the rendered UI, and they mean a later
 * run needs no database to know what happened before:
 *
 *   summary — finds the one comment that gets edited in place
 *   applied — the labels pi-tag currently owns on this issue
 *
 * The `applied` array is the only machine-read text from a previous run. The
 * prose above it is never parsed, so a model that writes something odd into the
 * comment cannot feed it back to itself.
 */

export const SUMMARY_MARKER = "<!-- pi-tag:summary -->";

const APPLIED_PATTERN = /<!--\s*pi-tag:applied\s+(\[.*?\])\s*-->/s;

export function appliedMarker(names: string[]): string {
	return `<!-- pi-tag:applied ${JSON.stringify([...names].sort())} -->`;
}

/**
 * The labels a previous run owned. `undefined` when the comment has no marker at
 * all, so the caller can tell "nothing recorded" from "nothing owned" and fail
 * closed on the former.
 */
export function parseApplied(body: string): string[] | undefined {
	const match = APPLIED_PATTERN.exec(body);
	if (!match?.[1]) return undefined;
	try {
		const parsed: unknown = JSON.parse(match[1]);
		if (!Array.isArray(parsed)) return undefined;
		return parsed.filter((name): name is string => typeof name === "string");
	} catch {
		return undefined;
	}
}

/**
 * Strip our own markers out of text that came from the model. Otherwise an issue
 * that quotes the comment becomes a second sticky, or forges an `applied` list —
 * and that list is what decides what may be removed.
 */
export function sanitize(text: string): string {
	return text.replace(/<!--\s*\/?\s*pi-tag:[^>]*-->/gi, "");
}

/** Whether a body is one of ours, at all. */
export function hasSummary(body: string): boolean {
	return body.includes(SUMMARY_MARKER);
}
