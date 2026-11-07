/**
 * Review context: what changed, in which repository, against which base.
 *
 * The runner asks for this once per review. With a pull-request number it uses
 * `gh` (metadata + the exact PR diff); without one it reviews the current
 * branch against its merge base, which is what `/pi-review run` does locally.
 *
 * Guidance files (`REVIEW.md`, `AGENTS.md`, `CLAUDE.md`) are read from the
 * **base commit**, never from the PR head. A pull request must not be able to
 * rewrite the rules it is reviewed against.
 */

import {
	type Exec,
	type RepoRef,
	resolveBaseRef,
	resolveHeadSha,
	resolveRepo,
	run,
} from "./detect.ts";
import { REVIEW_MARKER } from "./markers.ts";

export interface ReviewTarget {
	source: "pull-request" | "local";
	repo?: RepoRef;
	number?: number;
	title: string;
	body: string;
	author?: string;
	baseRef: string;
	baseSha?: string;
	headSha?: string;
	/** Full unified diff; the prompt caps how much of it the model sees. */
	diff: string;
	/** Non-fatal problems worth showing to the model and the operator. */
	notes: string[];
	/** When set, the diff only covers commits after this one (last review). */
	incrementalFrom?: string;
}

export interface GuidanceFile {
	/** Repository-relative path, e.g. `REVIEW.md`. */
	path: string;
	text: string;
	truncated: boolean;
}

export interface LoadTargetOptions {
	exec: Exec;
	cwd: string;
	env?: Record<string, string | undefined>;
	prNumber?: number;
	baseRef?: string;
	/** Per-command timeout. Defaults to 30s; diffs can be large. */
	timeoutMs?: number;
	/** Diff only since the last pi-review on this PR. Default true. */
	incremental?: boolean;
}

const MAX_GUIDANCE_CHARS = 32_000;
export const GUIDANCE_PATHS = ["REVIEW.md", ".github/REVIEW.md", "AGENTS.md", "CLAUDE.md"];

interface PullRequestView {
	number?: number;
	title?: string;
	body?: string;
	author?: { login?: string } | null;
	baseRefName?: string;
	baseRefOid?: string;
	headRefOid?: string;
}

async function ghPullRequestView(
	exec: Exec,
	cwd: string,
	number: number,
	timeout: number
): Promise<PullRequestView | undefined> {
	const fields = "number,title,body,author,baseRefName,baseRefOid,headRefOid";
	try {
		const result = await exec("gh", ["pr", "view", String(number), "--json", fields], { cwd, timeout });
		if ((result.code ?? 0) !== 0) return undefined;
		return JSON.parse(result.stdout) as PullRequestView;
	} catch {
		return undefined;
	}
}

async function gitDiff(exec: Exec, cwd: string, args: string[], timeout: number): Promise<string | undefined> {
	try {
		const result = await exec("git", ["diff", "--no-color", "--no-ext-diff", ...args], { cwd, timeout });
		if ((result.code ?? 0) !== 0) return undefined;
		return result.stdout;
	} catch {
		return undefined;
	}
}

interface PullReview {
	body?: unknown;
	commit_id?: unknown;
	submitted_at?: unknown;
}

/**
 * The commit of the most recent pi-review on this PR, if it is an ancestor of
 * `headSha`. A previous review from a force-pushed branch is ignored so the
 * follow-up falls back to a full diff.
 */
export async function findLastReviewedSha(
	exec: Exec,
	cwd: string,
	repo: RepoRef,
	number: number,
	headSha: string | undefined,
	timeoutMs = 30_000
): Promise<string | undefined> {
	if (!headSha) return undefined;
	let reviews: unknown;
	try {
		const result = await exec(
			"gh",
			["api", `repos/${repo.owner}/${repo.repo}/pulls/${number}/reviews?per_page=100`],
			{ cwd, timeout: timeoutMs }
		);
		if ((result.code ?? 0) !== 0) return undefined;
		reviews = JSON.parse(result.stdout);
	} catch {
		return undefined;
	}
	if (!Array.isArray(reviews)) return undefined;

	const ours = (reviews as PullReview[])
		.filter(
			(review) =>
				typeof review.body === "string" &&
				review.body.includes(REVIEW_MARKER) &&
				typeof review.commit_id === "string" &&
				review.commit_id.length > 0
		)
		.sort((a, b) => String(a.submitted_at ?? "").localeCompare(String(b.submitted_at ?? "")));
	const latest = ours.at(-1)?.commit_id;
	if (typeof latest !== "string" || latest === headSha) return undefined;

	const ancestor = await exec("git", ["merge-base", "--is-ancestor", latest, headSha], {
		cwd,
		timeout: timeoutMs,
	});
	return (ancestor.code ?? 1) === 0 ? latest : undefined;
}

/**
 * Load the pull request (or local branch) under review.
 *
 * Failures are collected in `notes` rather than thrown: a review of an
 * unknown diff is still worth posting as a summary comment, and the runner
 * reports the note in its output.
 */
export async function loadReviewTarget(options: LoadTargetOptions): Promise<ReviewTarget> {
	const { exec, cwd, timeoutMs = 30_000 } = options;
	const env = options.env ?? process.env;
	const notes: string[] = [];
	const repo = await resolveRepo(exec, cwd);
	if (!repo) notes.push("Could not detect a github.com `origin` remote.");

	const envNumber = Number(env.PR_NUMBER ?? env.PI_REVIEW_PR ?? "");
	const number =
		options.prNumber ?? (Number.isInteger(envNumber) && envNumber > 0 ? envNumber : undefined);

	if (number) {
		const view = await ghPullRequestView(exec, cwd, number, timeoutMs);
		if (view) {
			const baseRef = view.baseRefName ?? "main";
			let diff = "";
			try {
				const result = await exec("gh", ["pr", "diff", String(number)], { cwd, timeout: timeoutMs });
				if ((result.code ?? 0) === 0) diff = result.stdout;
			} catch {
				// Fall through to git below.
			}
			if (!diff.trim()) {
				notes.push("`gh pr diff` returned nothing; fell back to a local git diff.");
				if (view.baseRefOid) {
					diff =
						(await gitDiff(
							exec,
							cwd,
							[`${view.baseRefOid}...${view.headRefOid ?? "HEAD"}`],
							timeoutMs
						)) ?? "";
				} else {
					diff = (await gitDiff(exec, cwd, [`${baseRef}...HEAD`], timeoutMs)) ?? "";
				}
			}
			let incrementalFrom: string | undefined;
			if (repo && options.incremental !== false) {
				const previous = await findLastReviewedSha(
					exec,
					cwd,
					repo,
					view.number ?? number,
					view.headRefOid,
					timeoutMs
				);
				if (previous) {
					const incremental = await gitDiff(
						exec,
						cwd,
						[`${previous}...${view.headRefOid ?? "HEAD"}`],
						timeoutMs
					);
					if (incremental?.trim()) {
						diff = incremental;
						incrementalFrom = previous;
						notes.push(
							`Follow-up review: showing only the changes since the last review (${previous.slice(0, 12)}).`
						);
					}
				}
			}
			return {
				source: "pull-request",
				repo,
				number: view.number ?? number,
				title: view.title ?? `Pull request #${number}`,
				body: view.body ?? "",
				author: view.author?.login,
				baseRef,
				baseSha: view.baseRefOid,
				headSha: view.headRefOid,
				diff,
				notes,
				...(incrementalFrom ? { incrementalFrom } : {}),
			};
		}
		notes.push(
			`Could not read pull request #${number} with \`gh\` (missing CLI, auth, or network); reviewing the local checkout instead.`
		);
	}

	const baseRef = (await resolveBaseRef(exec, cwd, options.baseRef, env)) ?? "main";
	const mergeBase = await run(exec, "git", ["merge-base", baseRef, "HEAD"], { cwd, timeout: timeoutMs });
	const headSha = await resolveHeadSha(exec, cwd);
	const diff =
		(await gitDiff(exec, cwd, mergeBase ? [`${mergeBase}`] : [`${baseRef}...HEAD`], timeoutMs)) ?? "";
	if (!mergeBase) notes.push(`Could not find a merge base with \`${baseRef}\`.`);
	if (!diff.trim()) notes.push("The diff is empty; there may be nothing to review.");
	if (number) {
		// Posting still needs the PR number, but the local HEAD is not necessarily
		// the PR head (in CI it is the merge commit), so never send it as commit_id.
		notes.push("Posting will omit `commit_id` because the pull request head could not be read.");
	}

	const commitTitle = await run(exec, "git", ["log", "-1", "--pretty=%s"], { cwd });
	return {
		source: "local",
		repo,
		...(number ? { number } : {}),
		title: commitTitle ?? "Local changes",
		body: "",
		baseRef,
		baseSha: mergeBase,
		...(number ? {} : { headSha }),
		diff,
		notes,
	};
}

/** Read repository guidance from the base commit, capped per file. */
export async function loadGuidance(
	exec: Exec,
	cwd: string,
	baseSha: string | undefined,
	paths: string[] = GUIDANCE_PATHS
): Promise<GuidanceFile[]> {
	if (!baseSha) return [];
	const files: GuidanceFile[] = [];
	for (const path of paths) {
		try {
			const result = await exec("git", ["show", `${baseSha}:${path}`], { cwd, timeout: 15_000 });
			if ((result.code ?? 0) !== 0) continue;
			const text = result.stdout;
			if (!text.trim()) continue;
			const truncated = text.length > MAX_GUIDANCE_CHARS;
			files.push({
				path,
				text: truncated ? `${text.slice(0, MAX_GUIDANCE_CHARS)}\n\n[truncated]` : text,
				truncated,
			});
		} catch {
			// Missing file or a git error: no guidance from this path.
		}
	}
	return files;
}
