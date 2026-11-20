/**
 * Small value helpers for naming a pull request.
 *
 * A subscription is addressed by `owner/repo#number`. Keeping the parse and the
 * formatting here means the tool, the command, the lock file, and the widget all
 * agree on what a PR is called.
 */

export interface PrRef {
	owner: string;
	repo: string;
	number: number;
}

export const prKey = (ref: PrRef): string => `${ref.owner}/${ref.repo}#${ref.number}`;

export const prLabel = (ref: PrRef): string => `#${ref.number}`;

/** `owner/repo#32`, `#32`, or `32` (the latter two need a repo from context). */
export function parsePrSpec(
	spec: string
): { owner?: string; repo?: string; number: number } | undefined {
	const value = spec.trim();
	const qualified = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/.exec(value);
	if (qualified?.[1] && qualified[2] && qualified[3]) {
		return { owner: qualified[1], repo: qualified[2], number: Number(qualified[3]) };
	}
	const bare = /^#?(\d+)$/.exec(value);
	if (bare?.[1]) return { number: Number(bare[1]) };
	return undefined;
}

/** `2m`, `1h05m`, `3d` — short enough for a widget line. */
export function relativeTime(from: number, now = Date.now()): string {
	const ms = Math.max(0, now - from);
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
	const days = Math.floor(hours / 24);
	return `${days}d`;
}
