/**
 * `submit_review`: the one tool a pi-review agent finishes with.
 *
 * Validation lives in `review.ts`; this module is the side effects — writing
 * the dry-run artifact, posting one review through `gh api`, and refusing a
 * second submission in the same run. Posting goes through `gh` (already a
 * prerequisite of the installer) so there is no token handling here: the
 * workflow supplies `GH_TOKEN`.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { stringEnum } from "../_shared/schema.ts";
import type { Exec, RepoRef } from "./detect.ts";
import type { ParsedDiff } from "./diff.ts";
import { REVIEW_MARKER, STICKY_MARKER } from "./markers.ts";
import {
	type ReviewMeta,
	type ValidatedReview,
	renderReviewMarkdown,
	validateReview,
} from "./review.ts";

export const SUBMIT_REVIEW_TOOL = "submit_review";

export interface PostTarget {
	repo: RepoRef;
	number: number;
	commitId?: string;
}

export interface PostResult {
	url?: string;
}

/** POST one review. Throws with gh's message when GitHub rejects it. */
export async function postReview(
	exec: Exec,
	target: PostTarget,
	review: ValidatedReview,
	options: { cwd: string; timeout?: number } = { cwd: process.cwd() }
): Promise<PostResult> {
	const payload = {
		...(target.commitId ? { commit_id: target.commitId } : {}),
		event: review.event,
		// Invisible marker: lets a later run find the last reviewed commit.
		body: `${review.summary}\n\n${REVIEW_MARKER}`,
		comments: review.comments.map((comment) => ({
			path: comment.path,
			line: comment.line,
			side: comment.side ?? "RIGHT",
			...(comment.start_line === undefined ? {} : { start_line: comment.start_line }),
			body: comment.body,
		})),
	};

	const dir = await mkdtemp(join(tmpdir(), "pi-review-"));
	const file = join(dir, "review.json");
	try {
		await writeFile(file, JSON.stringify(payload), "utf8");
		const result = await exec(
			"gh",
			[
				"api",
				"--method",
				"POST",
				`repos/${target.repo.owner}/${target.repo.repo}/pulls/${target.number}/reviews`,
				"--input",
				file,
			],
			{ cwd: options.cwd, timeout: options.timeout ?? 60_000 }
		);
		if ((result.code ?? 0) !== 0) {
			const detail = (result.stderr || result.stdout).trim();
			throw new Error(`gh api failed (exit ${result.code ?? "?"}): ${detail || "no output"}`);
		}
		let url: string | undefined;
		try {
			const parsed = JSON.parse(result.stdout) as { html_url?: string };
			url = parsed.html_url;
		} catch {
			// gh output is not guaranteed JSON; the review still posted.
		}
		return { url };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

export interface StickyCommentOptions {
	cwd: string;
	timeout?: number;
}

/**
 * Update the one sticky summary comment on the PR (or create it). The comment
 * is a stable status line; the review itself carries the findings, so this is
 * updated in place on every push instead of piling up comments.
 */
export async function upsertStickyComment(
	exec: Exec,
	target: PostTarget,
	review: ValidatedReview,
	reviewUrl: string | undefined,
	options: StickyCommentOptions
): Promise<{ url?: string }> {
	const base = `repos/${target.repo.owner}/${target.repo.repo}/issues/${target.number}/comments`;
	const body = renderStickySummary(review, target, reviewUrl);
	const timeout = options.timeout ?? 60_000;

	let existingId: number | undefined;
	// `sort`/`direction` are not supported on the per-issue endpoint, so read
	// every page with `--slurp` (an array of pages) and take the newest marker.
	const collect = (entries: { id?: unknown; body?: unknown }[]): void => {
		for (const entry of entries) {
			if (typeof entry?.body === "string" && entry.body.includes(STICKY_MARKER)) {
				if (typeof entry.id === "number") existingId = entry.id;
			}
		}
	};

	const list = await exec("gh", ["api", "--paginate", "--slurp", `${base}?per_page=100`], {
		cwd: options.cwd,
		timeout,
	});
	if ((list.code ?? 0) === 0) {
		try {
			const parsed = JSON.parse(list.stdout) as unknown;
			if (Array.isArray(parsed)) {
				for (const page of parsed) {
					if (Array.isArray(page)) collect(page as { id?: unknown; body?: unknown }[]);
					else if (page && typeof page === "object") collect([page as { id?: unknown; body?: unknown }]);
				}
			}
		} catch (error) {
			console.error(
				`pi-review: could not parse the comment list (${error instanceof Error ? error.message : String(error)}); a new sticky comment may be created.`
			);
		}
	} else {
		// `--slurp` needs gh >= 2.47. Page explicitly so a long PR still finds
		// its marker instead of creating a duplicate.
		console.error(
			`pi-review: could not list comments with --slurp (${(list.stderr || "").trim() || "unknown error"}); paging without it.`
		);
		for (let page = 1; page <= 50; page += 1) {
			const result = await exec("gh", ["api", `${base}?per_page=100&page=${page}`], {
				cwd: options.cwd,
				timeout,
			});
			if ((result.code ?? 0) !== 0) break;
			let parsed: unknown;
			try {
				parsed = JSON.parse(result.stdout);
			} catch {
				break;
			}
			if (!Array.isArray(parsed)) break;
			collect(parsed as { id?: unknown; body?: unknown }[]);
			if (parsed.length < 100) break;
		}
	}

	const args = existingId
		? ["api", "--method", "PATCH", `repos/${target.repo.owner}/${target.repo.repo}/issues/comments/${existingId}`, "-f", `body=${body}`]
		: ["api", "--method", "POST", base, "-f", `body=${body}`];
	const result = await exec("gh", args, { cwd: options.cwd, timeout });
	if ((result.code ?? 0) !== 0) {
		throw new Error(
			`gh api could not write the sticky summary (exit ${result.code ?? "?"}): ${(result.stderr || result.stdout).trim() || "no output"}`
		);
	}
	let url: string | undefined;
	try {
		const parsed = JSON.parse(result.stdout) as { html_url?: string };
		url = parsed.html_url;
	} catch {
		// The comment still posted; the URL is only for the summary.
	}
	return { url };
}

/** One line, plus the marker. Kept short so it reads as a status line. */
export function renderStickySummary(
	review: ValidatedReview,
	target: PostTarget,
	reviewUrl: string | undefined
): string {
	const sha = target.commitId ? `\`${target.commitId.slice(0, 12)}\`` : "the latest commit";
	const count = review.comments.length;
	const inline = `${count} inline comment${count === 1 ? "" : "s"}`;
	const link = reviewUrl ? ` · [details](${reviewUrl})` : "";
	const verdict = review.event === "REQUEST_CHANGES" ? "requested changes" : "commented";
	return `${STICKY_MARKER}\n**pi-review** reviewed ${sha} — ${verdict} · ${inline}${link}`;
}

export interface SubmitReviewDeps {
	/** Parse the diff once and reuse it for every validation. */
	getDiff: () => Promise<ParsedDiff>;
	/** Where to post; omitted for a dry run. */
	post?: (review: ValidatedReview) => Promise<PostResult>;
	dryRun: boolean;
	/** JSON artifact written on submission (dry run and CI step summary). */
	outputPath?: string;
	/** Allows REQUEST_CHANGES submissions. */
	requestChanges?: boolean;
	/** Inline comments kept separate; the rest fold into the summary. */
	maxComments?: number;
	/** Extra context for the rendered markdown, resolved lazily. */
	renderMeta?: () => ReviewMeta | undefined | Promise<ReviewMeta | undefined>;
}

export interface SubmitReviewDetails {
	dryRun: boolean;
	review?: ValidatedReview;
	url?: string;
	error?: string;
}

async function writeArtifact(
	path: string | undefined,
	details: SubmitReviewDetails & { markdown?: string; incomplete?: boolean }
): Promise<void> {
	if (!path) return;
	await writeFile(path, JSON.stringify(details, null, 2), "utf8");
}

/**
 * Build the tool. `defaultActive` is left on: the runner passes
 * `--tools read,grep,find,ls,submit_review`, and a stray registration outside
 * runner mode is harmless because the command is explicit about mode.
 */
export function createSubmitReviewTool(deps: SubmitReviewDeps) {
	let submitted: ValidatedReview | undefined;

	return defineTool({
		name: SUBMIT_REVIEW_TOOL,
		label: "Submit review",
		description:
			"Post the finished pull-request review: a Markdown summary plus inline comments anchored to lines in the diff. Call this once, as your final action.",
		promptSnippet: "Submit the finished PR review (summary + inline comments)",
		promptGuidelines: [
			"Finish a pi-review run by calling submit_review exactly once. It is the only way a review reaches GitHub; a plain text answer is not posted.",
			"Inline comments must name a file in the diff and a line that appears in it: added or context lines on side RIGHT, removed or context lines on side LEFT. Comments that miss are moved into the summary instead of posted.",
			"Keep inline comments few and specific, most important first. A short summary with no inline comments is a valid review when there is nothing worth flagging.",
		],
		parameters: Type.Object({
			summary: Type.String({
				description:
					"Markdown review body: what the change does, the important findings, and anything you could not verify. Required, even when inline comments are also given.",
			}),
			event: Type.Optional(
				stringEnum(["COMMENT", "REQUEST_CHANGES"] as const, {
					description:
						"COMMENT posts a normal review. REQUEST_CHANGES blocks the PR and is only honored when the reviewer was configured to allow it.",
				})
			),
			comments: Type.Optional(
				Type.Array(
					Type.Object({
						path: Type.String({ description: "Repository-relative path, as shown in the diff" }),
						line: Type.Integer({ minimum: 1, description: "Line number in the file on the chosen side" }),
						side: Type.Optional(
							stringEnum(["RIGHT", "LEFT"] as const, {
								description: "RIGHT for the new file (default), LEFT for the base file",
							})
						),
						start_line: Type.Optional(
							Type.Integer({ minimum: 1, description: "First line of a multi-line comment" })
						),
						body: Type.String({ description: "Markdown comment body" }),
					}),
					{ maxItems: 50, description: "Inline comments anchored to the diff, most important first" }
				)
			),
		}),

		async execute(_toolCallId, params) {
			if (submitted) {
				const details: SubmitReviewDetails = { dryRun: deps.dryRun, review: submitted };
				return {
					content: [
						{
							type: "text" as const,
							text: "A review has already been submitted in this run. Do not submit another one.",
						},
					],
					details,
					isError: true,
				};
			}

			const diff = await deps.getDiff();
			const review = validateReview(params, diff, {
				requestChanges: deps.requestChanges,
				...(deps.maxComments === undefined ? {} : { maxComments: deps.maxComments }),
			});
			const markdown = renderReviewMarkdown(review, (await deps.renderMeta?.()) ?? {});

			if (deps.dryRun) {
				submitted = review;
				const details: SubmitReviewDetails = { dryRun: true, review };
				await writeArtifact(deps.outputPath, { ...details, markdown });
				return {
					content: [{ type: "text" as const, text: markdown }],
					details,
					terminate: true,
				};
			}

			if (!deps.post) {
				return {
					content: [
						{
							type: "text" as const,
							text: "No GitHub target was configured for this run, so the review could not be posted. Report this instead of retrying.",
						},
					],
					details: { dryRun: false } satisfies SubmitReviewDetails,
					isError: true,
				};
			}

			try {
				const result = await deps.post(review);
				submitted = review;
				const details: SubmitReviewDetails = { dryRun: false, review, url: result.url };
				await writeArtifact(deps.outputPath, { ...details, markdown });
				return {
					content: [
						{
							type: "text" as const,
							text: result.url ? `Review posted: ${result.url}` : "Review posted.",
						},
					],
					details,
					terminate: true,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				// Keep the validated review: a failed post is exactly when the
				// findings are most useful to the step summary.
				const details: SubmitReviewDetails = { dryRun: false, review, error: message };
				// `incomplete` makes the workflow fail (and say so on the PR) when the
				// agent gives up after a rejected post, instead of a green run with no
				// review. A later successful submission overwrites this artifact.
				await writeArtifact(deps.outputPath, { ...details, incomplete: true, markdown });
				return {
					content: [
						{
							type: "text" as const,
							text: `Posting the review failed: ${message}. Fix the cause and call submit_review again, or report the failure.`,
						},
					],
					details,
					isError: true,
				};
			}
		},
	});
}
