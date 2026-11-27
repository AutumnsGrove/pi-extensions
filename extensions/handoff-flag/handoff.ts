/**
 * handoff-flag — decide whether a HANDOFF.md is sitting in the repository root,
 * and render one short line about it.
 *
 * The handoff skill writes `HANDOFF.md` at the repository root, leaves it
 * untracked, and tells the next reader to delete it. That is easy to forget, so
 * this module answers only one question — is the file there right now — and the
 * widget in `index.ts` shows the answer. Everything here is pure so it can be
 * unit tested without a filesystem.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { join } from "node:path";

/** The filename the handoff skill writes, at the repository root. */
export const HANDOFF_FILENAME = "HANDOFF.md";

/** Just enough of `fs.Stats` to decide presence and how stale it is. */
export interface FileStatLike {
	mtimeMs: number;
	size: number;
	isFile(): boolean;
}

/** The handoff file as it exists on disk. */
export interface HandoffFile {
	/** Absolute path, for the command's detailed output. */
	path: string;
	/** Milliseconds since the file was last written. */
	ageMs: number;
	sizeBytes: number;
}

/**
 * Look for the handoff file. Any stat failure — missing file, permissions, a
 * name that is now a directory — reads as "no handoff", because the widget's
 * only job is to be right about presence and silent about everything else.
 */
export async function detectHandoff(
	root: string,
	statFile: (path: string) => Promise<FileStatLike>,
	now: number
): Promise<HandoffFile | null> {
	const path = join(root, HANDOFF_FILENAME);
	try {
		const info = await statFile(path);
		if (!info.isFile()) return null;
		return {
			path,
			ageMs: Math.max(0, now - info.mtimeMs),
			sizeBytes: info.size,
		};
	} catch {
		return null;
	}
}

/**
 * Compact age, because the widget is one line and the number only has to be
 * good enough to say "this is from today" or "this has been here for days".
 *
 *   <1m   40s   3h   2d
 */
export function formatAge(ageMs: number): string {
	if (ageMs < 60_000) return "<1m";
	const minutes = Math.floor(ageMs / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

/**
 * The widget line: a green tick, the filename, and how long it has been there.
 *
 *   ✓ HANDOFF.md · 3h
 *
 * The tick is the whole point — it is the "there is a handoff waiting" cue — so
 * nothing else competes with it for the eye.
 */
export function renderHandoff(handoff: HandoffFile, theme: Theme, width: number): string {
	const line = [
		theme.fg("success", "✓"),
		theme.fg("dim", " "),
		theme.fg("muted", HANDOFF_FILENAME),
		theme.fg("dim", " · "),
		theme.fg("dim", formatAge(handoff.ageMs)),
	].join("");
	return truncateToWidth(line, width, theme.fg("dim", "…"));
}

/** Human-readable size for the command's detailed output. */
function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Multi-line detail shown by `/handoff` when the file is present. */
export function formatHandoffDetails(handoff: HandoffFile): string {
	return [
		`${HANDOFF_FILENAME} — written ${formatAge(handoff.ageMs)} ago, ${formatSize(handoff.sizeBytes)}.`,
		handoff.path,
		"Untracked on purpose: delete it once it has been read (rm HANDOFF.md).",
	].join("\n");
}

/** Detail shown by `/handoff` when the file is absent. */
export function formatNoHandoff(root: string): string {
	return `No ${HANDOFF_FILENAME} in ${root}.`;
}

/**
 * Identity of what the widget is currently showing. The poll compares this
 * against the last paint so a two-second tick does not re-register and repaint
 * the widget when nothing changed — but the minute/hour bucket rolling over
 * does, which keeps the age honest while pi sits idle.
 */
export function handoffKey(handoff: HandoffFile | null): string {
	return handoff === null ? "absent" : `${formatAge(handoff.ageMs)}|${handoff.sizeBytes}`;
}
