/**
 * Read and resolve pull-request review threads through GitHub's GraphQL API.
 *
 * Only the unresolved threads written by bots are offered to the reviewer, and
 * the tool refuses any id outside that fetched set. That keeps a review from
 * resolving a human's thread or inventing an id.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Exec, RepoRef } from "../detect.ts";

export interface ReviewThread {
	id: string;
	path: string;
	line?: number;
	isOutdated: boolean;
	body: string;
	author?: string;
	/**
	 * `viewerCanResolve`: whether *this token* may resolve the thread. GitHub
	 * gates `resolveReviewThread` on Contents: write, not Pull requests: write,
	 * so a review token narrowed to `contents: read` can open a thread and post
	 * on it and still be refused when it tries to close it (#55). Asking GitHub
	 * is the only reliable answer; no setting can know it.
	 */
	canResolve: boolean;
}

/**
 * The refusal every `contents: read` review token gets, and why. Kept as one
 * string so the runner log, the prompt, the tool result, and the installer all
 * say the same thing.
 */
export const RESOLVE_REQUIRES_CONTENTS_WRITE =
	"resolveReviewThread requires the Contents: write permission, not Pull requests: write, so a review token narrowed to contents: read cannot resolve review threads";

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
          viewerCanResolve
          path
          line
          comments(first: 1) {
            nodes {
              body
              author { login __typename }
            }
          }
        }
      }
    }
  }
}`;

const RESOLVE_MUTATION = `mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) {
    thread { isResolved }
  }
}`;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

interface GraphQLNode {
	id?: unknown;
	isResolved?: unknown;
	isOutdated?: unknown;
	viewerCanResolve?: unknown;
	path?: unknown;
	line?: unknown;
	comments?: { nodes?: unknown };
}

/** Unresolved review threads started by a bot (the reviewer's own threads). */
export async function fetchBotThreads(
	exec: Exec,
	cwd: string,
	repo: RepoRef,
	number: number,
	timeoutMs = 30_000
): Promise<ReviewThread[]> {
	const result = await exec(
		"gh",
		[
			"api",
			"graphql",
			"-f",
			`query=${THREADS_QUERY}`,
			"-F",
			`owner=${repo.owner}`,
			"-F",
			`name=${repo.repo}`,
			"-F",
			`number=${number}`,
		],
		{ cwd, timeout: timeoutMs }
	);
	if ((result.code ?? 0) !== 0) {
		throw new Error(`Could not read review threads: ${(result.stderr || result.stdout).trim() || "gh failed"}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		throw new Error("GitHub returned a review-thread response that was not JSON.");
	}
	const nodes = asRecord(asRecord(asRecord(asRecord(asRecord(parsed)?.data)?.repository)?.pullRequest)?.reviewThreads)?.nodes;
	if (!Array.isArray(nodes)) return [];

	const threads: ReviewThread[] = [];
	for (const raw of nodes as GraphQLNode[]) {
		if (raw?.isResolved === true) continue;
		const comments = asRecord(raw.comments)?.nodes;
		const first = Array.isArray(comments) ? asRecord(comments[0]) : undefined;
		const author = asRecord(first?.author);
		if (author?.__typename !== "Bot") continue;
		if (typeof raw.id !== "string" || typeof raw.path !== "string") continue;
		threads.push({
			id: raw.id,
			path: raw.path,
			...(typeof raw.line === "number" ? { line: raw.line } : {}),
			isOutdated: raw.isOutdated === true,
			body: typeof first?.body === "string" ? first.body : "",
			...(typeof author.login === "string" ? { author: author.login } : {}),
			// Absent means GitHub did not say, which is not permission to try.
			canResolve: raw.viewerCanResolve === true,
		});
	}
	return threads;
}

export interface ResolveResult {
	resolved: string[];
	failed: { id: string; error: string }[];
}

/** Messages from a GraphQL response's `errors` array, if it has one. */
function graphqlErrors(stdout: string): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return [];
	}
	const errors = asRecord(parsed)?.errors;
	if (!Array.isArray(errors)) return [];
	return errors.map((entry) => {
		const message = asRecord(entry)?.message;
		return typeof message === "string" && message ? message : "GraphQL error";
	});
}

const NOT_ACCESSIBLE = /not accessible by integration|resource not accessible|FORBIDDEN/i;

/** A refusal that is about the token, not about the request. */
export function isPermissionRefusal(result: ResolveResult): boolean {
	return result.failed.length > 0 && result.failed.every((entry) => NOT_ACCESSIBLE.test(entry.error));
}

export interface ResolveDetails extends ResolveResult {
	/** Ids the model supplied that were not in the fetched set. */
	ignored: string[];
}

/** Resolve threads by id; stops at nothing, reporting per-id failures. */
export async function resolveThreads(
	exec: Exec,
	cwd: string,
	threadIds: string[],
	timeoutMs = 30_000
): Promise<ResolveResult> {
	const resolved: string[] = [];
	const failed: { id: string; error: string }[] = [];
	for (const threadId of threadIds) {
		const result = await exec(
			"gh",
			["api", "graphql", "-f", `query=${RESOLVE_MUTATION}`, "-f", `threadId=${threadId}`],
			{ cwd, timeout: timeoutMs }
		);
		// `gh` exits non-zero on a GraphQL `errors` array, but a response that
		// carries errors with exit 0 must not be counted as resolved either.
		const errors = graphqlErrors(result.stdout);
		if ((result.code ?? 0) === 0 && errors.length === 0) {
			resolved.push(threadId);
			continue;
		}
		const detail = (result.stderr || result.stdout).trim() || errors.join("; ") || "gh failed";
		failed.push({ id: threadId, error: detail });
		// A summary line that only says "resolved 0 threads" hides whether this
		// was a permission refusal or a bad node id, so name the id and quote
		// GitHub in the job log, where an operator can see it (#55).
		console.error(`pi-review: could not resolve review thread ${threadId}: ${detail}`);
	}
	return { resolved, failed };
}

/**
 * `resolve_review_threads`: only ids from the fetched, bot-authored set are
 * accepted; the model cannot resolve anything it was not shown.
 */
export function createResolveThreadsTool(deps: {
	getThreads: () => Promise<ReviewThread[]>;
	resolve: (ids: string[]) => Promise<ResolveResult>;
}) {
	return defineTool({
		name: "resolve_review_threads",
		label: "Resolve review threads",
		description:
			"Mark review threads as resolved after verifying the new changes fixed them. Only ids from the open threads provided in the review context are accepted, and only when this token is allowed to resolve them.",
		promptSnippet: "Resolve review threads that the new changes fixed",
		promptGuidelines: [
			"Use resolve_review_threads only for threads listed in the review context whose finding you can verify is fixed by the diff. Leave every thread you are unsure about unresolved.",
		],
		parameters: Type.Object({
			threadIds: Type.Array(Type.String(), {
				minItems: 1,
				maxItems: 50,
				description: "Thread ids from <open-review-threads>",
			}),
			reason: Type.Optional(
				Type.String({ description: "One line on what fixed the finding, recorded in the tool result" })
			),
		}),
		async execute(_toolCallId, params) {
			const threads = await deps.getThreads();
			const allowed = new Map(threads.map((thread) => [thread.id, thread]));
			const known = params.threadIds.filter((id) => allowed.has(id));
			const ignored = params.threadIds.filter((id) => !allowed.has(id));
			// `viewerCanResolve` is GitHub's own answer, so a thread this token may
			// not close is refused here instead of costing one doomed mutation each.
			const valid = known.filter((id) => allowed.get(id)?.canResolve === true);
			const refused = known.filter((id) => allowed.get(id)?.canResolve !== true);
			if (valid.length === 0) {
				const details: ResolveDetails = { resolved: [], failed: [], ignored };
				const text =
					refused.length > 0
						? `This token cannot resolve ${refused.length === 1 ? "that thread" : "those threads"} (${refused.join(", ")}): ${RESOLVE_REQUIRES_CONTENTS_WRITE}. Leave them open and say in the summary that they remain open.`
						: `None of those thread ids are open bot threads on this repository${ignored.length > 0 ? ` (ignored: ${ignored.join(", ")})` : ""}. Use the ids from <open-review-threads>.`;
				return {
					content: [{ type: "text" as const, text }],
					details,
					isError: true,
				};
			}
			const result = await deps.resolve(valid);
			const permission = isPermissionRefusal(result);
			const lines = [
				`Resolved ${result.resolved.length} thread${result.resolved.length === 1 ? "" : "s"}.`,
				...(params.reason ? [`Reason: ${params.reason}`] : []),
				...(ignored.length > 0 ? [`Ignored unknown ids: ${ignored.join(", ")}`] : []),
				...(refused.length > 0
					? [`Not resolvable by this token: ${refused.join(", ")} (${RESOLVE_REQUIRES_CONTENTS_WRITE})`]
					: []),
				...(result.failed.length > 0
					? [`Failed: ${result.failed.map((entry) => `${entry.id} (${entry.error})`).join(", ")}`]
					: []),
				...(permission ? ["The token lacks the permission, so say in the summary that the threads remain open."] : []),
			];
			const details: ResolveDetails = { ...result, ignored };
			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details,
				...(result.failed.length > 0 && result.resolved.length === 0 ? { isError: true } : {}),
			};
		},
	});
}
