/**
 * The writes. Two calls, in one order, and nothing else touches GitHub.
 *
 * Labels first, then the comment. If the run is cancelled between them the
 * `applied` marker in the comment is stale, which is recoverable: the marker only
 * supplies attribution, and every removal is intersected with the labels the
 * issue actually carries. The other order would leave a marker claiming labels
 * the issue does not have.
 *
 * Adding and removing go out as a single `gh issue edit`, so the issue is never
 * left half-changed.
 */

import type { Exec } from "./github.ts";

export interface ApplyOptions {
	cwd: string;
	timeoutMs?: number;
}

export interface Change {
	add: string[];
	remove: string[];
}

export interface Applied {
	added: string[];
	removed: string[];
}

/** One call, both directions. No call when there is nothing to change. */
export async function applyLabels(
	exec: Exec,
	issueNumber: number,
	repo: { owner: string; repo: string },
	change: Change,
	options: ApplyOptions
): Promise<Applied> {
	const add = [...new Set(change.add)].filter(Boolean);
	const remove = [...new Set(change.remove)].filter((name) => !add.includes(name));
	if (add.length === 0 && remove.length === 0) return { added: [], removed: [] };

	const args = ["issue", "edit", String(issueNumber), "--repo", `${repo.owner}/${repo.repo}`];
	if (add.length > 0) args.push("--add-label", add.join(","));
	if (remove.length > 0) args.push("--remove-label", remove.join(","));

	const result = await exec("gh", args, { cwd: options.cwd, timeoutMs: options.timeoutMs ?? 60_000 });
	if (result.code !== 0) {
		throw new Error(
			`gh issue edit failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim() || "no output"}`
		);
	}
	return { added: add, removed: remove };
}

/** `owner/repo` for the checkout, through gh rather than parsing a remote. */
export async function resolveRepo(
	exec: Exec,
	cwd: string
): Promise<{ owner: string; repo: string } | undefined> {
	const result = await exec("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], {
		cwd,
		timeoutMs: 20_000,
	});
	if (result.code !== 0) return undefined;
	const [owner, repo] = result.stdout.trim().split("/");
	return owner && repo ? { owner, repo } : undefined;
}
