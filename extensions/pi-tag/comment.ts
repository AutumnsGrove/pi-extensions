/**
 * The one comment per issue, and how it gets there.
 *
 * It is edited in place, found by marker, and never duplicated. Two things make
 * that safe:
 *
 *  - the lookup only accepts a comment authored by this bot, so a stranger who
 *    copies the markers into their own comment is ignored;
 *  - the `applied` marker records the labels pi-tag owns *now*, not just the ones
 *    this run added, so a label it applied three runs ago is still attributable
 *    and can still be corrected later.
 *
 * Model prose is quoted, never parsed, and every model-provided string is
 * sanitised of the markers before it goes in.
 */

import type { Exec } from "./github.ts";
import { appliedMarker, parseApplied, sanitize, SUMMARY_MARKER } from "./markers.ts";
import type { Applied, Proposal, Removed } from "./proposal.ts";

export interface CommentInput {
	proposal: Proposal;
	/** Labels the previous run owned, from its marker. */
	previous: string[];
	runUrl?: string;
	model: string;
	now?: Date;
	/** `comment.always`: false posts only when something changed. */
	always?: boolean;
	/** `comment.considered`: false drops the collapsed reasoning block. */
	considered?: boolean;
}

/** What pi-tag owns after this run: what it had, minus what it took off, plus what it added. */
export function ownedAfter(previous: string[], proposal: Proposal): string[] {
	const removed = new Set(proposal.removed.map((entry) => entry.name));
	const owned = new Set(previous.filter((name) => !removed.has(name)));
	for (const entry of proposal.applied) owned.add(entry.name);
	return [...owned].sort();
}

/** Whether this run changed anything a reader would want to see. */
export function worthPosting(proposal: Proposal): boolean {
	return proposal.applied.length > 0 || proposal.removed.length > 0;
}

export function renderComment(input: CommentInput): string {
	const { proposal } = input;
	const added = proposal.applied.map((entry) => `\`${entry.name}\``);
	const removed = proposal.removed.map((entry) => `\`${entry.name}\``);

	const headline =
		added.length > 0 && removed.length > 0
			? `applied ${added.join(" · ")} and removed ${removed.join(" · ")}`
			: added.length > 0
				? `applied ${added.join(" · ")}`
				: removed.length > 0
					? `removed ${removed.join(" · ")}`
					: "found nothing to change";

	const lines: string[] = [SUMMARY_MARKER, appliedMarker(ownedAfter(input.previous, proposal))];
	lines.push(`**pi-tag** ${headline}${input.runUrl ? ` — [run](${input.runUrl})` : ""}`);

	if (proposal.applied.length > 0) {
		lines.push("", "| label | why |", "| --- | --- |");
		for (const entry of proposal.applied) {
			lines.push(`| \`${entry.name}\` | ${oneLine(sanitize(entry.why))} |`);
		}
	}

	if (proposal.removed.length > 0) {
		lines.push("", "**Removed**", "");
		for (const entry of proposal.removed) {
			lines.push(`- \`${entry.name}\` — ${oneLine(sanitize(entry.why))}`);
		}
	}

	const details = input.considered === false ? [] : detailLines(proposal);
	if (details.length > 0) {
		lines.push("", `<details><summary>Considered, not applied (${details.length})</summary>`, "");
		lines.push(...details);
		lines.push("", "</details>");
	}

	lines.push(
		"",
		`Re-tag: comment \`@pi\`. To let it correct a label it got wrong: \`@pi fix <what you know that it didn't>.\``,
		`· ${input.model} · ${(input.now ?? new Date()).toISOString().slice(0, 10)}`
	);

	return lines.join("\n");
}

/**
 * A run that failed says so in the same comment, and keeps the `applied` marker
 * it found: a failure is not a reason to forget which labels pi-tag owns.
 */
export function renderFailure(reason: string, previous: string[], runUrl?: string): string {
	const lines = [
		SUMMARY_MARKER,
		appliedMarker(previous),
		`**pi-tag** could not tag this issue${runUrl ? ` — [run](${runUrl})` : ""}`,
		"",
		`> ${oneLine(sanitize(reason)) || "the run failed"}`,
		"",
		"The labels were not changed. Re-run the workflow, or comment `@pi` to try again.",
	];
	return lines.join("\n");
}

/** One line, so a model that writes a paragraph cannot break the table. */
function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function detailLines(proposal: Proposal): string[] {
	const lines: string[] = [];
	for (const entry of proposal.rejected) {
		lines.push(`- \`${entry.name}\` — ${oneLine(sanitize(entry.reason))}`);
	}
	for (const entry of proposal.leftInPlace) {
		lines.push(`- \`${entry.name}\` — left in place: ${oneLine(sanitize(entry.reason))}`);
	}
	for (const entry of proposal.considered) {
		if (!entry.whyNot) continue;
		lines.push(`- \`${entry.name}\` — ${oneLine(sanitize(entry.whyNot))}`);
	}
	return lines;
}

export interface UpsertOptions {
	cwd: string;
	/** The bot's login, `pi-tag-<owner>[bot]`. Only its comments are ours. */
	author: string;
	timeoutMs?: number;
	/** Skip the lookup when the caller already found it. */
	existingId?: number;
}

export interface FoundComment {
	id?: number;
	/** The labels the previous run owned, or undefined when there is no marker. */
	previous?: string[];
}

export interface UpsertResult {
	url?: string;
	created: boolean;
	/** Set when the comment was written but the marker could not be read. */
	previous?: string[];
}

interface IssueComment {
	id?: unknown;
	body?: unknown;
	user?: { login?: unknown };
}

/**
 * The bot's own summary comment on this issue, newest first.
 *
 * `--paginate --slurp` needs gh >= 2.47, and asking for every page is the point:
 * a long thread must still find its own marker rather than creating a duplicate.
 */
export async function findSummary(
	exec: Exec,
	repo: { owner: string; repo: string },
	issueNumber: number,
	options: UpsertOptions
): Promise<FoundComment> {
	const base = `repos/${repo.owner}/${repo.repo}/issues/${issueNumber}/comments`;
	const found: FoundComment = {};

	const list = await exec("gh", ["api", "--paginate", "--slurp", `${base}?per_page=100`], {
		cwd: options.cwd,
		timeoutMs: options.timeoutMs ?? 60_000,
	});
	if (list.code !== 0) return found;

	try {
		const parsed: unknown = JSON.parse(list.stdout);
		if (!Array.isArray(parsed)) return found;
		for (const page of parsed) {
			if (!Array.isArray(page)) continue;
			for (const entry of page as IssueComment[]) {
				if (typeof entry?.body !== "string") continue;
				// Attribution is what makes a removal safe, so only this bot's own
				// comment counts. A stranger cannot forge an `applied` list.
				if (entry.user?.login !== options.author) continue;
				if (!entry.body.includes(SUMMARY_MARKER)) continue;
				if (typeof entry.id !== "number") continue;
				found.id = entry.id;
				found.previous = parseApplied(entry.body);
			}
		}
	} catch {
		// A list we cannot read is not a reason to fail the run: the labels are
		// already correct, and a duplicate comment costs one comment, once.
	}
	return found;
}

/**
 * Edit the bot's summary comment in place, or create it when there is none.
 */
export async function upsertComment(
	exec: Exec,
	repo: { owner: string; repo: string },
	issueNumber: number,
	body: string,
	options: UpsertOptions
): Promise<UpsertResult> {
	const timeout = options.timeoutMs ?? 60_000;
	const base = `repos/${repo.owner}/${repo.repo}/issues/${issueNumber}/comments`;
	const found = options.existingId === undefined ? await findSummary(exec, repo, issueNumber, options) : { id: options.existingId };

	if (found.id !== undefined) {
		const patched = await exec(
			"gh",
			["api", "--method", "PATCH", `repos/${repo.owner}/${repo.repo}/issues/comments/${found.id}`, "-f", `body=${body}`],
			{ cwd: options.cwd, timeoutMs: timeout }
		);
		if (patched.code !== 0) {
			throw new Error(
				`could not update the summary comment (exit ${patched.code}): ${patched.stderr.trim() || "no output"}`
			);
		}
		return { created: false, previous: undefined, url: htmlUrl(patched.stdout) };
	}

	const created = await exec("gh", ["api", "--method", "POST", base, "-f", `body=${body}`], {
		cwd: options.cwd,
		timeoutMs: timeout,
	});
	if (created.code !== 0) {
		throw new Error(
			`could not post the summary comment (exit ${created.code}): ${created.stderr.trim() || "no output"}`
		);
	}
	return { created: true, previous: undefined, url: htmlUrl(created.stdout) };
}

function htmlUrl(stdout: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(stdout);
		if (typeof parsed === "object" && parsed !== null && "html_url" in parsed) {
			const url = (parsed as { html_url?: unknown }).html_url;
			return typeof url === "string" ? url : undefined;
		}
	} catch {
		// gh output is not guaranteed JSON; the comment still posted.
	}
	return undefined;
}

/** Exported for the dry run, which prints the comment without posting it. */
export type { Applied, Removed };
