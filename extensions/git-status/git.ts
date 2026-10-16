/**
 * git-status — collect, parse, and render the git state shown by the widget.
 *
 * Everything here is pure so it can be unit tested without a repository. The
 * extension in `index.ts` supplies the runner that actually shells out to git.
 *
 * The line counts follow ccstatusline (the Claude Code status line this widget
 * mirrors): insertions/deletions sum the unstaged working tree
 * (`git diff --shortstat`) and the index (`git diff --cached --shortstat`).
 * Untracked files are not part of either diff, so when a counter is supplied
 * their lines are added as insertions — otherwise a brand-new file would
 * contribute nothing and the widget would under-report the work on disk.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

/** Result of a single git invocation. */
export interface GitResult {
	stdout: string;
	code: number;
}

/** Runs `git` with the given arguments from the session's cwd. */
export type GitRunner = (args: string[]) => Promise<GitResult>;

/** Per-bucket file counts derived from `git status --porcelain`. */
export interface GitFileCounts {
	staged: number;
	unstaged: number;
	untracked: number;
	conflicts: number;
}

/** A complete snapshot of the working tree's git state. */
export interface GitStatus {
	/** Branch name, a short sha when detached, or a placeholder before the first commit. */
	branch: string;
	/** True when HEAD points at a commit rather than a branch. */
	detached: boolean;
	/** Upstream ref (e.g. `origin/main`) when the branch tracks one. */
	upstream: string | undefined;
	/** Commits ahead of the upstream. */
	ahead: number;
	/** Commits behind the upstream. */
	behind: number;
	/** No staged, unstaged, untracked, or conflicted paths. */
	clean: boolean;
	/** Files staged and/or modified but not committed, each path counted once. */
	changedFiles: number;
	/** Per-bucket breakdown; buckets can overlap (a file may be staged and modified). */
	counts: GitFileCounts;
	/** Uncommitted insertions (staged + unstaged). */
	insertions: number;
	/** Uncommitted deletions (staged + unstaged). */
	deletions: number;
}

/** Status codes git uses for both staged (X) and unstaged (Y) columns. */
const CHANGE_CODES = new Set(["M", "A", "D", "R", "C", "T"]);
/** `git status` unmerged (conflict) codes. */
const CONFLICT_PATTERN = /^(DD|AU|UD|UA|DU|AA|UU)/;

/** Pull `N insertions(+), M deletions(-)` out of `git diff --shortstat`. */
export function parseShortstat(stat: string): { insertions: number; deletions: number } {
	const insertMatch = /(\d+)\s+insertions?/.exec(stat);
	const deleteMatch = /(\d+)\s+deletions?/.exec(stat);
	return {
		insertions: insertMatch ? Number(insertMatch[1]) : 0,
		deletions: deleteMatch ? Number(deleteMatch[1]) : 0,
	};
}

/** Branch/tracking half of `git status --porcelain --branch`. */
export interface ParsedBranch {
	branch: string;
	detached: boolean;
	upstream: string | undefined;
	ahead: number;
	behind: number;
}

/**
 * Parse the `## ...` header line of porcelain status. Handles a plain branch,
 * an upstream with ahead/behind, `[gone]` upstreams, a detached HEAD, and a
 * repository that has no commits yet.
 */
export function parseBranchHeader(header: string): ParsedBranch {
	if (header === "HEAD (no branch)" || header.startsWith("HEAD ")) {
		return { branch: "", detached: true, upstream: undefined, ahead: 0, behind: 0 };
	}
	if (header.startsWith("No commits yet on ")) {
		return {
			branch: header.slice("No commits yet on ".length),
			detached: false,
			upstream: undefined,
			ahead: 0,
			behind: 0,
		};
	}
	if (header.startsWith("Initial commit on ")) {
		return {
			branch: header.slice("Initial commit on ".length),
			detached: false,
			upstream: undefined,
			ahead: 0,
			behind: 0,
		};
	}

	let refs = header;
	let tracking = "";
	const bracket = header.indexOf(" [");
	if (bracket >= 0) {
		refs = header.slice(0, bracket);
		tracking = header.slice(bracket + 2).replace(/\]$/, "");
	}

	let branch = refs;
	let upstream: string | undefined;
	const dots = refs.indexOf("...");
	if (dots >= 0) {
		branch = refs.slice(0, dots);
		const rest = refs.slice(dots + 3).trim();
		upstream = rest.length > 0 ? rest : undefined;
	}

	let ahead = 0;
	let behind = 0;
	const aheadMatch = /ahead (\d+)/.exec(tracking);
	const behindMatch = /behind (\d+)/.exec(tracking);
	if (aheadMatch) ahead = Number(aheadMatch[1]);
	if (behindMatch) behind = Number(behindMatch[1]);

	return { branch, detached: false, upstream, ahead, behind };
}

/** Parsed file-status half of `git status --porcelain --branch`. */
export interface ParsedStatus extends ParsedBranch {
	counts: GitFileCounts;
	changedFiles: number;
	/** Root-relative paths of untracked files, one entry per file with `-uall`. */
	untrackedPaths: string[];
}

/**
 * Parse `git status --porcelain -z --branch` output. NUL-separated records make
 * paths with spaces and renames unambiguous: a rename emits the new path, then
 * the original path as its own field.
 */
export function parseStatus(stdout: string): ParsedStatus {
	const fields = stdout.split("\0");
	const counts: GitFileCounts = { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 };
	const untrackedPaths: string[] = [];
	let changedFiles = 0;

	const header = fields[0] ?? "";
	const parsedBranch = header.startsWith("## ")
		? parseBranchHeader(header.slice(3))
		: { branch: "", detached: false, upstream: undefined, ahead: 0, behind: 0 };

	for (let index = 1; index < fields.length; index += 1) {
		const entry = fields[index];
		if (entry === undefined || entry.length < 3) continue;
		const x = entry[0] ?? "";
		const y = entry[1] ?? "";

		changedFiles += 1;
		if (x === "?" && y === "?") {
			counts.untracked += 1;
			untrackedPaths.push(entry.slice(3));
		} else if (CONFLICT_PATTERN.test(entry)) {
			counts.conflicts += 1;
		} else {
			if (CHANGE_CODES.has(x)) counts.staged += 1;
			if (CHANGE_CODES.has(y)) counts.unstaged += 1;
		}

		// Rename/copy records append the source path as a separate field.
		if (x === "R" || x === "C" || y === "R" || y === "C") index += 1;
	}

	return { ...parsedBranch, counts, changedFiles, untrackedPaths };
}

/** Optional collaborators for {@link collectGitStatus}. */
export interface CollectGitStatusOptions {
	/**
	 * Count how many lines an untracked file would add to the repository. `root`
	 * is the absolute repository root and `path` is root-relative (git reports
	 * untracked paths relative to the root even when invoked from a subdirectory).
	 * Return null to skip a file, e.g. when it is binary or too large.
	 */
	countUntrackedLines?: (root: string, path: string) => Promise<number | null>;
}

/**
 * Gather the working tree's git state, or `null` when `cwd` is not inside a
 * repository. Runs three git commands in the common case: porcelain status
 * (branch, tracking, file counts) plus the two shortstat diffs, with extra
 * lookups for the short sha when HEAD is detached and the repository root when
 * untracked file lines are counted.
 */
export async function collectGitStatus(
	run: GitRunner,
	options: CollectGitStatusOptions = {}
): Promise<GitStatus | null> {
	const status = await run([
		"--no-optional-locks",
		"status",
		"--porcelain",
		"-z",
		"--branch",
		"-uall",
	]);
	if (status.code !== 0) return null;

	const parsed = parseStatus(status.stdout);

	let branch = parsed.branch;
	if (parsed.detached) {
		const sha = await run(["--no-optional-locks", "rev-parse", "--short", "HEAD"]);
		branch = sha.code === 0 && sha.stdout.trim().length > 0 ? sha.stdout.trim() : "no commits";
	}

	const [unstaged, staged] = await Promise.all([
		run(["--no-optional-locks", "diff", "--shortstat"]),
		run(["--no-optional-locks", "diff", "--cached", "--shortstat"]),
	]);
	const unstagedLines = parseShortstat(unstaged.stdout);
	const stagedLines = parseShortstat(staged.stdout);

	// Untracked files never show up in either diff, so add their line counts
	// explicitly. Binary and oversized files are skipped by the counter.
	let untrackedInsertions = 0;
	if (parsed.untrackedPaths.length > 0 && options.countUntrackedLines) {
		const rootResult = await run(["--no-optional-locks", "rev-parse", "--show-toplevel"]);
		if (rootResult.code === 0 && rootResult.stdout.trim().length > 0) {
			const root = rootResult.stdout.trim();
			const counter = options.countUntrackedLines;
			// Read one at a time: a large untracked tree would otherwise open a
			// file descriptor per path at once.
			for (const path of parsed.untrackedPaths) {
				try {
					const count = await counter(root, path);
					if (typeof count === "number") untrackedInsertions += count;
				} catch {
					// Skip files we cannot read.
				}
			}
		}
	}

	return {
		branch,
		detached: parsed.detached,
		upstream: parsed.upstream,
		ahead: parsed.ahead,
		behind: parsed.behind,
		clean: parsed.changedFiles === 0,
		changedFiles: parsed.changedFiles,
		counts: parsed.counts,
		insertions: unstagedLines.insertions + stagedLines.insertions + untrackedInsertions,
		deletions: unstagedLines.deletions + stagedLines.deletions,
	};
}

/**
 * Render the widget line: branch, changed-file count, uncommitted line churn,
 * and ahead/behind when the branch tracks an upstream. A clean tree shows only
 * the branch (and any drift); the absence of changes is signal enough.
 *
 *   ⎇ feature/x · 3 modified · +42 −8 · ↑1 ↓2
 *   ⎇ main · ↑1 ↓2
 *   ⎇ main
 */
export function renderGitStatus(status: GitStatus, theme: Theme, width: number): string {
	const segments: string[] = [];
	const ref = status.detached ? `(${status.branch})` : status.branch;
	segments.push(theme.fg("accent", `⎇ ${ref}`));

	if (!status.clean) {
		segments.push(theme.fg("muted", `${status.changedFiles} modified`));
		const added = theme.fg("toolDiffAdded", `+${status.insertions}`);
		const removed = theme.fg("toolDiffRemoved", `−${status.deletions}`);
		segments.push(`${added} ${removed}`);
	}

	const tracking: string[] = [];
	if (status.ahead > 0) tracking.push(`↑${status.ahead}`);
	if (status.behind > 0) tracking.push(`↓${status.behind}`);
	if (tracking.length > 0) segments.push(theme.fg("muted", tracking.join(" ")));

	const separator = theme.fg("dim", " · ");
	return truncateToWidth(segments.join(separator), width, theme.fg("dim", "…"));
}

/** Multi-line detail shown by `/git-status`. */
export function formatGitDetails(status: GitStatus): string {
	const lines: string[] = [];
	lines.push(`Branch: ${status.branch}${status.detached ? " (detached HEAD)" : ""}`);
	if (status.upstream) {
		const drift =
			status.ahead > 0 || status.behind > 0
				? ` (${status.ahead} ahead, ${status.behind} behind)`
				: "";
		lines.push(`Upstream: ${status.upstream}${drift}`);
	}
	if (!status.clean) {
		const { staged, unstaged, untracked, conflicts } = status.counts;
		const buckets = [
			`${staged} staged`,
			`${unstaged} modified`,
			`${untracked} untracked`,
		];
		if (conflicts > 0) buckets.push(`${conflicts} conflicted`);
		lines.push(`Changed files: ${status.changedFiles} (${buckets.join(", ")})`);
		lines.push(`Lines: +${status.insertions} −${status.deletions}`);
	}
	return lines.join("\n");
}
