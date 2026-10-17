/**
 * Pure helpers for the `cooking` extension: turn an agent state and a tick into
 * the leading glyph of the terminal title.
 *
 * The title pi sets is `π - <session> - <cwd>`. Rather than prefixing a spinner
 * (which would read `⠹ π - …`), this extension animates the app glyph slot
 * itself: `π` morphs through pi-ish math symbols while working, settles to a
 * distinct mark while pi waits on you, and returns to `π` when idle.
 *
 * Kept free of pi imports so it can be unit-tested directly.
 */

/**
 * Prefix pi puts on its own window/tab title (`APP_TITLE` in pi's config).
 * Pi falls back to a configured name on custom builds; the default is `π`.
 */
export const DEFAULT_APP_TITLE = "π";

/**
 * Working frames: the leading `π` morphs through math symbols. Chosen to read
 * as "computing" and to avoid the asterisk/braille family Claude Code uses.
 * `π` is intentionally absent so an active run never looks idle.
 */
export const WORKING_FRAMES = ["∏", "∑", "√", "∞", "∂", "∫", "≈"] as const;

/** Shown while pi waits on a generic dialog or approval. */
export const WAITING_GLYPH = "◌";

/** Shown while the `pi-q-n-a` tool is asking the user a question. */
export const ASKING_GLYPH = "⁇";

export type CookingState = "idle" | "working" | "waiting" | "asking";

/** Positive modulo so a wrapped negative tick still lands in range. */
const wrap = (value: number, length: number): number =>
	((value % length) + length) % length;

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
 * The glyph for the title's app slot at a given tick, or `undefined` when idle
 * so the caller can fall back to pi's own app title.
 */
export function glyphFor(
	state: CookingState,
	tick: number
): string | undefined {
	switch (state) {
		case "working":
			return WORKING_FRAMES[wrap(tick, WORKING_FRAMES.length)];
		case "waiting":
			return WAITING_GLYPH;
		case "asking":
			return ASKING_GLYPH;
		default:
			return undefined;
	}
}

/**
 * The full terminal title: the animated glyph in pi's app-title slot, then the
 * session descriptor. Idle renders exactly `π - <session> - <cwd>`.
 */
export function cookingTitle(
	appTitle: string,
	descriptor: string,
	state: CookingState,
	tick: number
): string {
	return `${glyphFor(state, tick) ?? appTitle} - ${descriptor}`;
}
