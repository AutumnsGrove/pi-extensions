/**
 * Pull-request snapshots, parsed from GitHub's REST payloads.
 *
 * A snapshot is everything one poll can see about a PR: its state and head SHA,
 * every check run and legacy commit status on that SHA, the issue comments, the
 * inline review comments, and the reviews. It is deliberately a flat,
 * JSON-shaped value with no classes, because it is diffed against a cursor and
 * that cursor is persisted in the session file.
 *
 * Every parser takes `unknown` and drops anything malformed rather than
 * throwing: GitHub adds fields, and a single odd entry must not kill a poll.
 */

export type PullState = "open" | "closed";

export interface PullSnapshot {
	number: number;
	title: string;
	url: string;
	state: PullState;
	merged: boolean;
	draft: boolean;
	headSha: string;
	headRef: string;
	baseRef: string;
	baseSha?: string;
	author?: string;
	authorBot: boolean;
	updatedAt?: string;
}

/** One check run or commit status, normalized into a single shape. */
export interface CheckEntry {
	/** Stable identity: `check:<id>` or `status:<context>`. */
	key: string;
	name: string;
	/** GitHub's run status: queued, in_progress, completed. */
	status: "queued" | "in_progress" | "completed" | "unknown";
	/** Lowercased conclusion, or null while the run is not finished. */
	conclusion: string | null;
	url?: string;
	app?: string;
	startedAt?: string;
	completedAt?: string;
}

export interface CommentEntry {
	/** Numeric id as a string, so issue and review comments share a cursor. */
	id: string;
	kind: "issue" | "review";
	author?: string;
	bot: boolean;
	body: string;
	createdAt?: string;
	url?: string;
	/** Review comments only. */
	path?: string;
	line?: number;
	replyTo?: string;
}

export interface ReviewEntry {
	id: string;
	author?: string;
	bot: boolean;
	state: string;
	body: string;
	submittedAt?: string;
	url?: string;
	/** Set when the body carries a `pi-review` marker, so the envelope can say so. */
	source?: "pi-review";
}

/** The hidden marker `pi-review` appends to every review body. */
export const PI_REVIEW_MARKER = "<!-- pi-review:review -->";

export interface Snapshot {
	pull: PullSnapshot;
	checks: CheckEntry[];
	/** Oldest first, as GitHub returns them; capped by the fetcher's page size. */
	comments: CommentEntry[];
	reviews: ReviewEntry[];
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;

const asString = (value: unknown): string | undefined =>
	typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;

const asNumber = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** GitHub returns `user.type: "Bot"`; App installations also end in `[bot]`. */
function authorOf(value: unknown): { login?: string; bot: boolean } {
	const user = asRecord(value);
	const login = asString(user?.login);
	const type = asString(user?.type);
	return { login, bot: type === "Bot" || Boolean(login?.endsWith("[bot]")) };
}

export function parsePull(value: unknown): PullSnapshot | undefined {
	const pull = asRecord(value);
	const head = asRecord(pull?.head);
	const base = asRecord(pull?.base);
	const number = asNumber(pull?.number);
	const headSha = asString(head?.sha);
	if (!pull || number === undefined || !headSha) return undefined;
	const author = authorOf(pull.user);
	const state = asString(pull.state) === "closed" ? "closed" : "open";
	return {
		number,
		title: asString(pull.title) ?? "",
		url: asString(pull.html_url) ?? "",
		state,
		merged: pull.merged === true,
		draft: pull.draft === true,
		headSha,
		headRef: asString(head?.ref) ?? "",
		baseRef: asString(base?.ref) ?? "",
		...(asString(base?.sha) ? { baseSha: asString(base?.sha) } : {}),
		...(author.login ? { author: author.login } : {}),
		authorBot: author.bot,
		...(asString(pull.updated_at) ? { updatedAt: asString(pull.updated_at) } : {}),
	};
}

const CHECK_STATUSES = new Set(["queued", "in_progress", "completed"]);

function normalizeStatus(value: unknown): CheckEntry["status"] {
	const status = asString(value)?.toLowerCase();
	return status && CHECK_STATUSES.has(status) ? (status as CheckEntry["status"]) : "unknown";
}

function normalizeConclusion(value: unknown): string | null {
	const conclusion = asString(value)?.toLowerCase();
	if (!conclusion || conclusion === "null") return null;
	return conclusion;
}

/** `GET /repos/{owner}/{repo}/commits/{sha}/check-runs` */
export function parseCheckRuns(value: unknown): CheckEntry[] {
	const runs = asArray(asRecord(value)?.check_runs);
	const out: CheckEntry[] = [];
	for (const raw of runs) {
		const run = asRecord(raw);
		const id = asNumber(run?.id);
		const name = asString(run?.name);
		if (id === undefined || !name) continue;
		const app = asRecord(run?.app);
		out.push({
			key: `check:${id}`,
			name,
			status: normalizeStatus(run?.status),
			conclusion: normalizeConclusion(run?.conclusion),
			...(asString(run?.html_url) ? { url: asString(run?.html_url) } : {}),
			...(asString(app?.name) ? { app: asString(app?.name) } : {}),
			...(asString(run?.started_at) ? { startedAt: asString(run?.started_at) } : {}),
			...(asString(run?.completed_at) ? { completedAt: asString(run?.completed_at) } : {}),
		});
	}
	return out;
}

/** `GET /repos/{owner}/{repo}/commits/{sha}/status` (legacy commit statuses). */
export function parseCommitStatuses(value: unknown): CheckEntry[] {
	const statuses = asArray(asRecord(value)?.statuses);
	const out: CheckEntry[] = [];
	for (const raw of statuses) {
		const status = asRecord(raw);
		const context = asString(status?.context);
		if (!context) continue;
		const state = asString(status?.state)?.toLowerCase();
		// A commit status is terminal as soon as it exists; `pending` is the
		// only non-terminal state.
		const conclusion =
			state === "success" || state === "failure" || state === "error"
				? state
				: state === "pending"
					? null
					: (state ?? null);
		out.push({
			key: `status:${context}`,
			name: context,
			status: state === "pending" ? "in_progress" : "completed",
			conclusion,
			...(asString(status?.target_url) ? { url: asString(status?.target_url) } : {}),
			...(asString(status?.created_at) ? { startedAt: asString(status?.created_at) } : {}),
		});
	}
	return out;
}

/** `GET /repos/{owner}/{repo}/issues/{number}/comments` */
export function parseIssueComments(value: unknown): CommentEntry[] {
	const out: CommentEntry[] = [];
	for (const raw of asArray(value)) {
		const comment = asRecord(raw);
		const id = asNumber(comment?.id);
		if (id === undefined) continue;
		const author = authorOf(comment?.user);
		out.push({
			id: String(id),
			kind: "issue",
			...(author.login ? { author: author.login } : {}),
			bot: author.bot,
			body: asString(comment?.body) ?? "",
			...(asString(comment?.created_at) ? { createdAt: asString(comment?.created_at) } : {}),
			...(asString(comment?.html_url) ? { url: asString(comment?.html_url) } : {}),
		});
	}
	return out;
}

/** `GET /repos/{owner}/{repo}/pulls/{number}/comments` */
export function parseReviewComments(value: unknown): CommentEntry[] {
	const out: CommentEntry[] = [];
	for (const raw of asArray(value)) {
		const comment = asRecord(raw);
		const id = asNumber(comment?.id);
		if (id === undefined) continue;
		const author = authorOf(comment?.user);
		const line = asNumber(comment?.line) ?? asNumber(comment?.original_line);
		const replyTo = asNumber(comment?.in_reply_to_id);
		out.push({
			id: String(id),
			kind: "review",
			...(author.login ? { author: author.login } : {}),
			bot: author.bot,
			body: asString(comment?.body) ?? "",
			...(asString(comment?.created_at) ? { createdAt: asString(comment?.created_at) } : {}),
			...(asString(comment?.html_url) ? { url: asString(comment?.html_url) } : {}),
			...(asString(comment?.path) ? { path: asString(comment?.path) } : {}),
			...(line !== undefined ? { line } : {}),
			...(replyTo !== undefined ? { replyTo: String(replyTo) } : {}),
		});
	}
	return out;
}

/** `GET /repos/{owner}/{repo}/pulls/{number}/reviews` */
export function parseReviews(value: unknown): ReviewEntry[] {
	const out: ReviewEntry[] = [];
	for (const raw of asArray(value)) {
		const review = asRecord(raw);
		const id = asNumber(review?.id);
		if (id === undefined) continue;
		const author = authorOf(review?.user);
		const body = asString(review?.body) ?? "";
		const source = body.includes(PI_REVIEW_MARKER) ? ("pi-review" as const) : undefined;
		out.push({
			id: String(id),
			...(author.login ? { author: author.login } : {}),
			bot: author.bot || source !== undefined,
			state: asString(review?.state)?.toUpperCase() ?? "UNKNOWN",
			body,
			...(source ? { source } : {}),
			...(asString(review?.submitted_at) ? { submittedAt: asString(review?.submitted_at) } : {}),
			...(asString(review?.html_url) ? { url: asString(review?.html_url) } : {}),
		});
	}
	return out;
}

export interface SnapshotPayload {
	pull: unknown;
	checkRuns: unknown;
	statuses: unknown;
	issueComments: unknown;
	reviewComments: unknown;
	reviews: unknown;
}

/** Combine the six REST payloads into one snapshot. */
export function buildSnapshot(payload: SnapshotPayload): Snapshot | undefined {
	const pull = parsePull(payload.pull);
	if (!pull) return undefined;
	return {
		pull,
		checks: [...parseCheckRuns(payload.checkRuns), ...parseCommitStatuses(payload.statuses)],
		comments: [...parseIssueComments(payload.issueComments), ...parseReviewComments(payload.reviewComments)],
		reviews: parseReviews(payload.reviews),
	};
}

export interface CheckSummary {
	total: number;
	done: number;
	failed: number;
	pending: number;
}

/** Counts for the widget and the subscribe result. */
export function oldestFirst<T extends { createdAt?: string; submittedAt?: string }>(items: T[]): T[] {
	const at = (item: T): number => {
		const value = item.createdAt ?? item.submittedAt;
		const time = value ? Date.parse(value) : Number.NaN;
		// Unknown timestamps keep their API order; a stable sort is enough.
		return Number.isFinite(time) ? time : 0;
	};
	return [...items].sort((a, b) => at(a) - at(b));
}

export function checkSummary(checks: CheckEntry[]): CheckSummary {
	let done = 0;
	let failed = 0;
	for (const check of checks) {
		if (check.status !== "completed" || check.conclusion === null) continue;
		done += 1;
		if (["failure", "timed_out", "cancelled", "action_required", "startup_failure", "error"].includes(check.conclusion)) {
			failed += 1;
		}
	}
	return { total: checks.length, done, failed, pending: checks.length - done };
}
