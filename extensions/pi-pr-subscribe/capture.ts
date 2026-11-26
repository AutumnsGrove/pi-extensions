/**
 * Recognising the comment a `bash` call just posted.
 *
 * There is no posting tool. The agent comments with plain `gh`, and this module
 * reads the ids out of the output the session already has. The cursor records
 * them, so the poller does not wake the agent about its own reply a few seconds
 * later.
 *
 * Best effort, by design. If the id is not in the output (a wrapper script, an
 * alias, output piped through `jq`), nothing is recorded and the comment wakes
 * the agent once. That is indistinguishable from a comment the user posted on
 * github.com under the same login, and rule 4 tells the agent it needs no reply.
 *
 * The ids matter more than the command shape: a `gh api` POST, a
 * `gh pr comment`, and a `gh pr review` all end with a URL or JSON body that
 * carries one.
 */

export interface PostedTarget {
	owner?: string;
	repo?: string;
	number?: number;
	kind: "issue-comment" | "review-comment" | "review";
}

const ID_PATTERNS: Array<{ kind: PostedTarget["kind"]; pattern: RegExp }> = [
	{ kind: "issue-comment", pattern: /#issuecomment-(\d+)/g },
	{ kind: "review-comment", pattern: /#discussion_r(\d+)/g },
	{ kind: "review", pattern: /#pullrequestreview-(\d+)/g },
];

/** Ids from output text: fragment URLs first, then JSON bodies with a URL beside the id. */
export function extractPostedIds(output: string): string[] {
	const ids = new Set<string>();
	for (const { pattern } of ID_PATTERNS) {
		for (const match of output.matchAll(pattern)) {
			if (match[1]) ids.add(match[1]);
		}
	}
	// A JSON API response carries `"id": 123` plus an `html_url` that names the
	// PR (and often the fragment, already handled above). Only trust ids that
	// sit next to a pull-request URL, so an unrelated id in the payload cannot
	// be mistaken for a comment.
	const jsonId = /"html_url"\s*:\s*"https:\/\/github\.com\/[^"]*\/pull\/\d+[^"]*"[^}]*?"id"\s*:\s*(\d+)/g;
	for (const match of output.matchAll(jsonId)) {
		if (match[1]) ids.add(match[1]);
	}
	const reversedJsonId = /"id"\s*:\s*(\d+)[^}]*?"html_url"\s*:\s*"https:\/\/github\.com\/[^"]*\/pull\/\d+[^"]*"/g;
	for (const match of output.matchAll(reversedJsonId)) {
		if (match[1]) ids.add(match[1]);
	}
	return [...ids];
}

/**
 * Does this `gh api` invocation write, rather than read?
 *
 * `gh api` defaults to POST as soon as a field or a body is given, so those
 * flags are the usual answer; `-X/--method POST` and `--input` say it outright.
 * Anything else — `--paginate`, `--jq`, a bare path — is a GET, and a GET posts
 * nothing to suppress.
 */
function makesAWrite(tail: string): boolean {
	if (/(?:^|\s)(?:-X|--method)[\s=]+POST\b/i.test(tail)) return true;
	return /(?:^|\s)(?:-f|--raw-field|-F|--field|--input)(?:[\s=]|$)/.test(tail);
}

/** What the command was aimed at, when it says so. */
export function extractPostedTarget(command: string): PostedTarget | undefined {
	const args = command.replace(/\\\n/g, " ");
	// `gh` must start the command or follow a shell separator; a `gh pr comment`
	// inside a commit message or a heredoc is not a posted comment.

	// gh api repos/{owner}/{repo}/issues/{n}/comments | .../pulls/{n}/comments | .../pulls/{n}/reviews
	//
	// Only a write counts. The same path is how a session *reads* the thread
	// (`gh api .../pulls/32/comments --jq '.[] | .body'`), and treating a read as
	// a post would silence the next six minutes of the session's own comments —
	// including one the user leaves on github.com.
	const api = /(?:^|[;&|]|\n)\s*gh\s+api\b([^\n]*)/.exec(args);
	if (api) {
		const tail = api[1] ?? "";
		const target = /repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(issues|pulls)\/(\d+)\/(comments|reviews)\b/.exec(
			tail
		);
		if (target?.[1] && target[2] && target[3] && target[4] && target[5] && makesAWrite(tail)) {
			const kind =
				target[5] === "reviews" ? "review" : target[3] === "pulls" ? "review-comment" : "issue-comment";
			return { owner: target[1], repo: target[2], number: Number(target[4]), kind };
		}
	}

	const review = /(?:^|[;&|]|\n)\s*gh\s+pr\s+review\b([^\n]*)/.exec(args);
	if (review) {
		const number = /(?:^|\s)(\d+)(?:\s|$)/.exec(review[1] ?? "");
		return { ...(number?.[1] ? { number: Number(number[1]) } : {}), kind: "review" };
	}

	const comment = /(?:^|[;&|]|\n)\s*gh\s+pr\s+comment\b([^\n]*)/.exec(args);
	if (comment) {
		const number = /(?:^|\s)(\d+)(?:\s|$)/.exec(comment[1] ?? "");
		return { ...(number?.[1] ? { number: Number(number[1]) } : {}), kind: "issue-comment" };
	}

	return undefined;
}

/** Does this captured target belong to that subscription? */
export function targetMatches(
	target: PostedTarget | undefined,
	ref: { owner: string; repo: string; number: number },
	cwdRepo: { owner: string; repo: string } | undefined
): boolean {
	if (!target) return false;
	if (target.number !== undefined && target.number !== ref.number) return false;
	if (target.owner && target.repo) {
		return (
			target.owner.toLowerCase() === ref.owner.toLowerCase() &&
			target.repo.toLowerCase() === ref.repo.toLowerCase()
		);
	}
	// No repo in the command: `gh` used the cwd's remote.
	if (!cwdRepo) return false;
	return (
		cwdRepo.owner.toLowerCase() === ref.owner.toLowerCase() &&
		cwdRepo.repo.toLowerCase() === ref.repo.toLowerCase()
	);
}
