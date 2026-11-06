/**
 * Repository, branch, and GitHub detection for pi-review.
 *
 * Everything here goes through the injected `Exec`, so the installer (`gh`
 * auth, repo admin), the local dry run, and the CI runner share one code path
 * and one fake in tests. No function throws for a missing tool: absent `git`,
 * `gh`, or credentials come back as `undefined` so the caller can degrade.
 */

export interface ExecResultLike {
	stdout: string;
	stderr?: string;
	code?: number;
}

export interface Exec {
	(command: string, args: string[], options?: { cwd?: string; timeout?: number }): Promise<ExecResultLike>;
}

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
		/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
		/^github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
	];
	for (const pattern of patterns) {
		const match = pattern.exec(value);
		if (match?.[1] && match[2]) return { owner: match[1], repo: match[2] };
	}
	return undefined;
}

/** Run a command, returning trimmed stdout only when it exits zero. */
export async function run(
	exec: Exec,
	command: string,
	args: string[],
	options: { cwd: string; timeout?: number }
): Promise<string | undefined> {
	try {
		const result = await exec(command, args, options);
		if ((result.code ?? 0) !== 0) return undefined;
		return result.stdout.trim();
	} catch {
		return undefined;
	}
}

export async function resolveRepo(exec: Exec, cwd: string): Promise<RepoRef | undefined> {
	const url = await run(exec, "git", ["remote", "get-url", "origin"], { cwd });
	if (!url) return undefined;
	return parseGitHubRemote(url);
}

export async function resolveBranch(exec: Exec, cwd: string): Promise<string | undefined> {
	const branch = await run(exec, "git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
	if (!branch || branch === "HEAD") return undefined;
	return branch;
}

export async function resolveHeadSha(exec: Exec, cwd: string): Promise<string | undefined> {
	return run(exec, "git", ["rev-parse", "HEAD"], { cwd });
}

async function refExists(exec: Exec, cwd: string, ref: string): Promise<boolean> {
	const sha = await run(exec, "git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd });
	return Boolean(sha);
}

/**
 * Base branch to diff against, in priority order: an explicit ref, the
 * workflow/CI environment, `origin/HEAD`, then the usual defaults.
 */
export async function resolveBaseRef(
	exec: Exec,
	cwd: string,
	preferred?: string | undefined,
	env: Record<string, string | undefined> = process.env
): Promise<string | undefined> {
	const candidates: string[] = [];
	if (preferred) candidates.push(preferred);
	const fromEnv = env.PI_REVIEW_BASE_REF ?? env.GITHUB_BASE_REF;
	if (fromEnv) candidates.push(fromEnv);

	const remoteHead = await run(exec, "git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd });
	if (remoteHead) {
		// In a CI checkout the local default branch may not exist, so try the
		// remote-tracking ref too before falling back to main/master.
		candidates.push(remoteHead.replace(/^origin\//, ""), remoteHead);
	}

	candidates.push("origin/main", "origin/master", "main", "master");

	for (const candidate of candidates) {
		if (await refExists(exec, cwd, candidate)) return candidate;
	}
	return undefined;
}

export async function hasGhAuth(exec: Exec, cwd: string): Promise<boolean> {
	const result = await run(exec, "gh", ["auth", "status"], { cwd, timeout: 10_000 });
	return result !== undefined;
}

/** Open pull request for the current branch, if `gh` is usable. */
export async function detectPullRequest(exec: Exec, cwd: string): Promise<number | undefined> {
	const value = await run(exec, "gh", ["pr", "view", "--json", "number", "--jq", ".number"], {
		cwd,
		timeout: 15_000,
	});
	if (!value) return undefined;
	const number = Number(value);
	return Number.isInteger(number) && number > 0 ? number : undefined;
}

/** Environment variable a provider's key is normally read from. */
export function providerEnvName(provider: string): string | undefined {
	const normalized = provider.toLowerCase().replace(/_/g, "-");
	if (normalized === "opencode-go" || normalized === "opencode") return "OPENCODE_API_KEY";
	if (normalized === "openrouter") return "OPENROUTER_API_KEY";
	if (normalized === "anthropic") return "ANTHROPIC_API_KEY";
	if (normalized === "openai") return "OPENAI_API_KEY";
	if (normalized === "google" || normalized === "gemini") return "GOOGLE_API_KEY";
	if (normalized === "zai" || normalized === "z-ai") return "ZAI_API_KEY";
	return undefined;
}
