/**
 * Which repository and pull request a session is talking about.
 *
 * The tool may default `owner`/`repo` to the git remote and `pullNumber` to the
 * current branch's open PR, which is the one deliberate departure from Claude's
 * tool surface: a local session knows more than a cloud one.
 *
 * The same parser is also the cross-repo guard. A model-supplied `owner`/`repo`
 * is only accepted when it matches one of the session's git remotes, so a
 * prompt-injected comment cannot widen the set of repos feeding events into the
 * session. Cross-repo subscriptions remain possible, but only through the
 * user's own `/subscribe` command.
 */

import type { Exec } from "./gh.ts";
import type { PrRef } from "./ref.ts";

export interface RepoRef {
	owner: string;
	repo: string;
}

/** `git@github.com:owner/repo.git`, `https://github.com/owner/repo`, … */
export function parseGitHubRemote(url: string): RepoRef | undefined {
	const value = url.trim();
	const patterns = [
		/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/,
		/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
		/^ssh:\/\/git@ssh\.github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
		/^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
		/^github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
	];
	for (const pattern of patterns) {
		const match = pattern.exec(value);
		if (match?.[1] && match[2]) return { owner: match[1], repo: match[2] };
	}
	return undefined;
}

const run = async (
	exec: Exec,
	command: string,
	args: string[],
	cwd: string,
	timeout = 10_000
): Promise<string | undefined> => {
	try {
		const result = await exec(command, args, { cwd, timeout });
		if ((result.code ?? 0) !== 0) return undefined;
		return result.stdout.trim() || undefined;
	} catch {
		return undefined;
	}
};

/** Every GitHub remote, `origin` first. */
export async function listRemotes(exec: Exec, cwd: string): Promise<RepoRef[]> {
	const names = (await run(exec, "git", ["remote"], cwd))?.split("\n").map((name) => name.trim()) ?? [];
	const ordered = ["origin", ...names.filter((name) => name !== "origin")];
	const seen = new Set<string>();
	const repos: RepoRef[] = [];
	for (const name of ordered) {
		if (!name) continue;
		const url = await run(exec, "git", ["remote", "get-url", name], cwd);
		const repo = url ? parseGitHubRemote(url) : undefined;
		if (!repo) continue;
		const key = `${repo.owner}/${repo.repo}`.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		repos.push(repo);
	}
	return repos;
}

export async function resolveRepo(exec: Exec, cwd: string): Promise<RepoRef | undefined> {
	const remotes = await listRemotes(exec, cwd);
	return remotes[0];
}

export function matchesRemote(remotes: RepoRef[], owner: string, repo: string): boolean {
	const key = `${owner}/${repo}`.toLowerCase();
	return remotes.some((remote) => `${remote.owner}/${remote.repo}`.toLowerCase() === key);
}

export async function hasGhAuth(exec: Exec, cwd: string): Promise<boolean> {
	return (await run(exec, "gh", ["auth", "status"], cwd)) !== undefined;
}

/** Open PR for the current branch. */
export async function resolvePullForBranch(
	exec: Exec,
	cwd: string
): Promise<{ number: number; url?: string } | undefined> {
	const raw = await run(exec, "gh", ["pr", "view", "--json", "number,url,state"], cwd, 15_000);
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw) as { number?: unknown; url?: unknown; state?: unknown };
		if (typeof parsed.number !== "number" || !Number.isInteger(parsed.number)) return undefined;
		if (parsed.state === "CLOSED" || parsed.state === "MERGED") {
			// `gh pr view` returns a closed PR for a merged branch too; still valid.
		}
		return { number: parsed.number, ...(typeof parsed.url === "string" ? { url: parsed.url } : {}) };
	} catch {
		return undefined;
	}
}

export async function resolveCwdPr(exec: Exec, cwd: string): Promise<PrRef | undefined> {
	const repo = await resolveRepo(exec, cwd);
	if (!repo) return undefined;
	const pull = await resolvePullForBranch(exec, cwd);
	if (!pull) return undefined;
	return { owner: repo.owner, repo: repo.repo, number: pull.number };
}

export const AUTH_HINT = "Run `gh auth login` (or `gh auth status` to see what is wrong), then subscribe again.";
export const NO_PR_HINT =
	"No open pull request for the current branch. Pass owner/repo and pullNumber, or run this from a branch with a PR.";
