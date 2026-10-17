/**
 * Pure helpers for the `cooking` extension: turn an agent state into the
 * leading glyph of the terminal title.
 *
 * The title pi sets is `π - <session> - <cwd>`. Rather than prefixing a spinner
 * (which would read `⠹ π - …`), this extension swaps the app glyph slot itself:
 * `∞` while pi is working, a distinct mark while pi waits on you, and `π` when
 * idle. The marks are static, so several pi windows do not strobe at once.
 *
 * Kept free of pi imports so it can be unit-tested directly.
 */

/**
 * Prefix pi puts on its own window/tab title (`APP_TITLE` in pi's config).
 * Pi falls back to a configured name on custom builds; the default is `π`.
 */
export const DEFAULT_APP_TITLE = "π";

/**
 * Shown while a run or compaction is in progress. A single steady mark reads
 * as "still cooking" without animating — a title full of rotating glyphs is
 * noisy when several sessions are active at once.
 */
export const WORKING_GLYPH = "∞";

/** Shown while pi waits on a generic dialog or approval. */
export const WAITING_GLYPH = "◌";

/** Shown while the `pi-q-n-a` tool is asking the user a question. */
export const ASKING_GLYPH = "⁇";

export type CookingState = "idle" | "working" | "waiting" | "asking";

/**
 * The session/cwd part of pi's title, without the leading app glyph:
 * `<session> - <cwd>`, or just `<cwd>` when the session has no name.
 */
export function sessionDescriptor(
	sessionName: string | undefined,
	cwdBasename: string
): string {
	const name = sessionName?.trim();
	return name ? `${name} - ${cwdBasename}` : cwdBasename;
}

/**
 * The glyph for the title's app slot in a given state, or `undefined` when
 * idle so the caller can fall back to pi's own app title.
 */
export function glyphFor(state: CookingState): string | undefined {
	switch (state) {
		case "working":
			return WORKING_GLYPH;
		case "waiting":
			return WAITING_GLYPH;
		case "asking":
			return ASKING_GLYPH;
		default:
			return undefined;
	}
}

/**
 * The full terminal title: the state glyph in pi's app-title slot, then the
 * session descriptor. Idle renders exactly `π - <session> - <cwd>`.
 */
export function cookingTitle(
	appTitle: string,
	descriptor: string,
	state: CookingState
): string {
	return `${glyphFor(state) ?? appTitle} - ${descriptor}`;
}
