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
}

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
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
		});
	}
	return threads;
}

export interface ResolveResult {
	resolved: string[];
	failed: { id: string; error: string }[];
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
		if ((result.code ?? 0) === 0) resolved.push(threadId);
		else failed.push({ id: threadId, error: (result.stderr || result.stdout).trim() || "gh failed" });
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
			"Mark review threads as resolved after verifying the new changes fixed them. Only ids from the open threads provided in the review context are accepted.",
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
			const valid = params.threadIds.filter((id) => allowed.has(id));
			const ignored = params.threadIds.filter((id) => !allowed.has(id));
			if (valid.length === 0) {
				const details: ResolveDetails = { resolved: [], failed: [], ignored };
				return {
					content: [
						{
							type: "text" as const,
							text: `None of those thread ids are open bot threads on this repository${ignored.length > 0 ? ` (ignored: ${ignored.join(", ")})` : ""}. Use the ids from <open-review-threads>.`,
						},
					],
					details,
					isError: true,
				};
			}
			const result = await deps.resolve(valid);
			const lines = [
				`Resolved ${result.resolved.length} thread${result.resolved.length === 1 ? "" : "s"}.`,
				...(params.reason ? [`Reason: ${params.reason}`] : []),
				...(ignored.length > 0 ? [`Ignored unknown ids: ${ignored.join(", ")}`] : []),
				...(result.failed.length > 0
					? [`Failed: ${result.failed.map((entry) => `${entry.id} (${entry.error})`).join(", ")}`]
					: []),
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
