/**
 * Put the generated settings + workflow on a branch and push it.
 *
 * The installer never commits to the default branch: it fetches the default,
 * branches from it, adds only the two generated files, commits, pushes, and
 * restores the branch the user was on. The caller opens the compare URL.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type Exec, type RepoRef, run } from "../detect.ts";

export const SETUP_BRANCH = "pi-review/setup";

export interface GeneratedFile {
	/** Repository-relative path. */
	path: string;
	content: string;
}

export interface BranchOptions {
	exec: Exec;
	cwd: string;
	repo: RepoRef;
	defaultBranch: string;
	files: GeneratedFile[];
	message: string;
}

export interface BranchResult {
	branch: string;
	compareUrl: string;
	committed: boolean;
	pushed: boolean;
	restoredBranch?: string;
	files: string[];
}

async function git(
	exec: Exec,
	cwd: string,
	args: string[],
	timeout = 60_000
): Promise<string | undefined> {
	return run(exec, "git", args, { cwd, timeout });
}

/** The repository's default branch, as GitHub sees it. */
export async function resolveDefaultBranch(
	exec: Exec,
	cwd: string,
	repo: RepoRef
): Promise<string | undefined> {
	const value = await run(
		exec,
		"gh",
		["api", `repos/${repo.owner}/${repo.repo}`, "--jq", ".default_branch"],
		{ cwd, timeout: 15_000 }
	);
	return value || undefined;
}

async function remoteBranchExists(exec: Exec, cwd: string, branch: string): Promise<boolean> {
	const value = await git(exec, cwd, ["ls-remote", "--heads", "origin", branch]);
	return Boolean(value?.trim());
}

/** `pi-review/setup`, or the first free `pi-review/setup-N`. */
export async function chooseBranchName(exec: Exec, cwd: string): Promise<string> {
	if (!(await remoteBranchExists(exec, cwd, SETUP_BRANCH))) return SETUP_BRANCH;
	for (let suffix = 2; suffix <= 9; suffix += 1) {
		const candidate = `${SETUP_BRANCH}-${suffix}`;
		if (!(await remoteBranchExists(exec, cwd, candidate))) return candidate;
	}
	throw new Error(
		`${SETUP_BRANCH} and its first eight suffixes all exist on the remote. Delete one or merge the open setup PR first.`
	);
}

export function compareUrl(repo: RepoRef, base: string, branch: string): string {
	return `https://github.com/${repo.owner}/${repo.repo}/compare/${base}...${branch}?expand=1`;
}

function failure(action: string, result: { stderr?: string; code?: number }): Error {
	const detail = (result.stderr ?? "").trim();
	return new Error(`${action} failed (exit ${result.code ?? "?"})${detail ? `: ${detail}` : ""}`);
}

/**
 * Write the files, commit them on a fresh branch off the default, and push.
 * Throws on a dirty tree or a git failure before anything is pushed.
 */
export async function writeWorkflowBranch(options: BranchOptions): Promise<BranchResult> {
	const { exec, cwd, repo, defaultBranch, files, message } = options;

	const original = await git(exec, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
	const dirty = await git(exec, cwd, ["status", "--porcelain"]);
	if (dirty === undefined) throw new Error("Could not read the git status. Is this a git repository?");
	if (dirty.trim()) {
		throw new Error(
			`The working tree has uncommitted changes. Commit or stash them first, then run install again:\n${dirty
				.split("\n")
				.slice(0, 8)
				.join("\n")}`
		);
	}

	const fetched = await exec("git", ["fetch", "origin", defaultBranch], { cwd, timeout: 120_000 });
	if ((fetched.code ?? 0) !== 0) throw failure(`git fetch origin ${defaultBranch}`, fetched);

	const branch = await chooseBranchName(exec, cwd);
	const checkout = await exec("git", ["checkout", "-B", branch, `origin/${defaultBranch}`], { cwd });
	if ((checkout.code ?? 0) !== 0) throw failure(`git checkout -B ${branch}`, checkout);

	const paths = files.map((file) => file.path);
	try {
		for (const file of files) {
			const full = join(cwd, file.path);
			await mkdir(dirname(full), { recursive: true });
			await writeFile(full, file.content, "utf8");
		}

		const added = await exec("git", ["add", "--", ...paths], { cwd });
		if ((added.code ?? 0) !== 0) throw failure("git add", added);

		const staged = await git(exec, cwd, ["status", "--porcelain", "--", ...paths]);
		if (staged === undefined) throw new Error("Could not read the staged changes.");
		const committed = Boolean(staged.trim());

		if (committed) {
			const commit = await exec("git", ["commit", "-m", message], { cwd });
			if ((commit.code ?? 0) !== 0) throw failure("git commit", commit);
			const push = await exec("git", ["push", "-u", "origin", branch], { cwd, timeout: 120_000 });
			if ((push.code ?? 0) !== 0) throw failure(`git push origin ${branch}`, push);
		}

		return {
			branch,
			compareUrl: compareUrl(repo, defaultBranch, branch),
			committed,
			pushed: committed,
			...(original && original !== "HEAD" ? { restoredBranch: original } : {}),
			files: paths,
		};
	} finally {
		// Return the user to where they started even if the push failed.
		if (original && original !== "HEAD") {
			await git(exec, cwd, ["checkout", original]);
		}
	}
}
