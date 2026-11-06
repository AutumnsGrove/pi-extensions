/**
 * Review validation: turn whatever the model asked to submit into a payload
 * GitHub will accept.
 *
 * The rule that matters is inline anchoring. GitHub rejects a whole review when
 * one comment points at a line outside the diff, so each comment is checked
 * against the parsed diff first. Anything that cannot be anchored is moved into
 * the summary (never silently dropped), which keeps a long review useful even
 * when the model guessed a line number.
 */

import { type DiffSide, type ParsedDiff, isValidPosition } from "./diff.ts";

export type ReviewEvent = "COMMENT" | "REQUEST_CHANGES";

export interface InlineCommentInput {
	path: string;
	line: number;
	side?: DiffSide;
	start_line?: number;
	body: string;
}

export interface ReviewInput {
	summary?: string;
	event?: string;
	comments?: InlineCommentInput[];
}

export interface DroppedComment {
	path: string;
	line: number;
	side: DiffSide;
	body: string;
	reason: string;
}

export interface ValidatedReview {
	event: ReviewEvent;
	summary: string;
	comments: InlineCommentInput[];
	dropped: DroppedComment[];
}

export interface ValidateOptions {
	/** Allow REQUEST_CHANGES; anything else is posted as COMMENT. */
	requestChanges?: boolean;
	/** Inline comments kept as comments; the rest fold into the summary. */
	maxComments?: number;
}

export const DEFAULT_MAX_INLINE_COMMENTS = 25;

function normalizePath(path: string): string {
	return path.trim().replace(/^\.\//, "").replace(/^\/+/, "");
}

function normalizeSide(side: unknown): DiffSide {
	return typeof side === "string" && side.toUpperCase() === "LEFT" ? "LEFT" : "RIGHT";
}

function blockquote(text: string): string {
	return text
		.trim()
		.split("\n")
		.map((line) => (line.length > 0 ? `> ${line}` : ">"))
		.join("\n");
}

/** Append unattachable comments to the summary so nothing is lost. */
function foldDropped(summary: string, dropped: DroppedComment[]): string {
	if (dropped.length === 0) return summary.trim();
	const lines = [
		summary.trim(),
		"",
		`<details><summary>${dropped.length} comment${dropped.length === 1 ? "" : "s"} that could not be attached to the diff</summary>`,
		"",
	];
	for (const comment of dropped) {
		lines.push(
			`**\`${comment.path}:${comment.line}\`** (${comment.side}) — ${comment.reason}`,
			"",
			blockquote(comment.body),
			""
		);
	}
	lines.push("</details>");
	return lines.join("\n").trim();
}

/**
 * Validate a submission against the diff. Never throws: unusable inline
 * comments become part of the summary with the reason stated.
 */
export function validateReview(
	input: ReviewInput,
	diff: ParsedDiff,
	options: ValidateOptions = {}
): ValidatedReview {
	const maxComments = options.maxComments ?? DEFAULT_MAX_INLINE_COMMENTS;
	const requested = Array.isArray(input.comments) ? input.comments : [];
	const comments: InlineCommentInput[] = [];
	const dropped: DroppedComment[] = [];

	for (const raw of requested) {
		const path = normalizePath(String(raw?.path ?? ""));
		const side = normalizeSide(raw?.side);
		const line = Math.trunc(Number(raw?.line));
		const body = String(raw?.body ?? "").trim();

		const drop = (reason: string): void => {
			dropped.push({ path: path || "(missing path)", line: Number.isFinite(line) ? line : 0, side, body, reason });
		};

		if (!body) {
			drop("the comment body was empty");
			continue;
		}
		if (!path) {
			drop("no file path was given");
			continue;
		}
		if (!Number.isFinite(line) || line < 1) {
			drop("the line was not a positive number");
			continue;
		}
		if (!isValidPosition(diff, path, side, line)) {
			drop(`line ${line} is not a changed or context line on the ${side} side of the diff`);
			continue;
		}
		if (comments.length >= maxComments) {
			drop(`only the first ${maxComments} inline comments are posted separately`);
			continue;
		}

		let startLine: number | undefined;
		const requestedStart = Number(raw?.start_line);
		if (Number.isInteger(requestedStart) && requestedStart > 0 && requestedStart < line) {
			if (isValidPosition(diff, path, side, requestedStart)) startLine = requestedStart;
		}

		comments.push({
			path,
			line,
			side,
			body,
			...(startLine === undefined ? {} : { start_line: startLine }),
		});
	}

	const event: ReviewEvent =
		options.requestChanges && String(input.event ?? "").toUpperCase() === "REQUEST_CHANGES"
			? "REQUEST_CHANGES"
			: "COMMENT";

	let summary = String(input.summary ?? "").trim();
	if (!summary && comments.length > 0) {
		summary = `Pi reviewed this pull request and left ${comments.length} inline comment${comments.length === 1 ? "" : "s"}.`;
	}
	summary = foldDropped(summary, dropped);

	return { event, summary, comments, dropped };
}

export interface ReviewMeta {
	repo?: { owner: string; repo: string };
	number?: number;
	model?: string;
	baseRef?: string;
	headSha?: string;
}

/** Markdown view of a review, used for dry runs, logs, and step summaries. */
export function renderReviewMarkdown(review: ValidatedReview, meta: ReviewMeta = {}): string {
	const lines: string[] = [];
	const where = meta.repo ? `${meta.repo.owner}/${meta.repo.repo}` : "this repository";
	const subject = meta.number ? `${where}#${meta.number}` : where;
	lines.push(`## Pi review — ${subject}`, "");
	const facts: string[] = [`event \`${review.event}\``];
	if (meta.baseRef) facts.push(`base \`${meta.baseRef}\``);
	if (meta.headSha) facts.push(`head \`${meta.headSha.slice(0, 12)}\``);
	if (meta.model) facts.push(`model \`${meta.model}\``);
	lines.push(facts.join(" · "), "");

	if (review.summary) lines.push(review.summary, "");

	if (review.comments.length > 0) {
		lines.push(`### Inline comments (${review.comments.length})`);
		for (const comment of review.comments) {
			const range =
				comment.start_line === undefined
					? `\`${comment.path}:${comment.line}\``
					: `\`${comment.path}:${comment.start_line}-${comment.line}\``;
			lines.push(`${range} (${comment.side ?? "RIGHT"})`, "", blockquote(comment.body), "");
		}
	}

	if (review.comments.length === 0 && review.dropped.length === 0) {
		lines.push("_No inline comments._", "");
	}

	return lines.join("\n").trim();
}
