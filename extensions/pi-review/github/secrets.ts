/**
 * Repo secrets and variables for the installer.
 *
 * Secrets are written through `gh secret set` with the value on **stdin**: a
 * private key in argv would show up in the process list. Variables are for
 * non-sensitive values the workflow can read back (the App slug), because a
 * secret's value cannot be read after it is stored.
 */

import type { RepoRef } from "../detect.ts";
import type { CommandRunner } from "./exec.ts";

export const APP_ID_SECRET = "PI_REVIEW_APP_ID";
export const APP_KEY_SECRET = "PI_REVIEW_APP_PRIVATE_KEY";
/** Non-secret App slug, so a re-run can find the App without reading secrets. */
export const APP_SLUG_VARIABLE = "PI_REVIEW_APP_SLUG";

export interface GitHubCommandOptions {
	run: CommandRunner;
	repo: RepoRef;
	cwd: string;
}

function repoFlag(repo: RepoRef): string {
	return `${repo.owner}/${repo.repo}`;
}

function describeFailure(action: string, name: string, result: { stderr: string; stdout: string; code: number }): string {
	const detail = (result.stderr || result.stdout).trim();
	return `${action} ${name} failed (exit ${result.code})${detail ? `: ${detail}` : ""}`;
}

export async function listRepoSecretNames(options: GitHubCommandOptions): Promise<string[]> {
	const { run, repo, cwd } = options;
	const result = await run(
		"gh",
		["api", `repos/${repoFlag(repo)}/actions/secrets?per_page=100`, "--jq", ".secrets[].name"],
		{ cwd }
	);
	if (result.code !== 0) {
		throw new Error(describeFailure("Listing secrets for", repoFlag(repo), result));
	}
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

export async function setRepoSecret(
	options: GitHubCommandOptions & { name: string; value: string }
): Promise<void> {
	const { run, repo, cwd, name, value } = options;
	const result = await run("gh", ["secret", "set", name, "--repo", repoFlag(repo)], { cwd, stdin: value });
	if (result.code !== 0) throw new Error(describeFailure("Storing secret", name, result));
}

export async function deleteRepoSecret(
	options: GitHubCommandOptions & { name: string }
): Promise<void> {
	const { run, repo, cwd, name } = options;
	const result = await run("gh", ["secret", "delete", name, "--repo", repoFlag(repo)], { cwd });
	if (result.code !== 0) throw new Error(describeFailure("Deleting secret", name, result));
}

export async function setRepoVariable(
	options: GitHubCommandOptions & { name: string; value: string }
): Promise<void> {
	const { run, repo, cwd, name, value } = options;
	const result = await run(
		"gh",
		["variable", "set", name, "--body", value, "--repo", repoFlag(repo)],
		{ cwd }
	);
	if (result.code !== 0) throw new Error(describeFailure("Storing variable", name, result));
}

export async function getRepoVariable(
	options: GitHubCommandOptions & { name: string }
): Promise<string | undefined> {
	const { run, repo, cwd, name } = options;
	const result = await run("gh", ["variable", "get", name, "--repo", repoFlag(repo)], { cwd });
	if (result.code !== 0) return undefined;
	const value = result.stdout.trim();
	return value || undefined;
}

export async function deleteRepoVariable(
	options: GitHubCommandOptions & { name: string }
): Promise<void> {
	const { run, repo, cwd, name } = options;
	const result = await run("gh", ["variable", "delete", name, "--repo", repoFlag(repo)], { cwd });
	// A missing variable is not an error for the caller.
	if (result.code !== 0 && !/not found|404/i.test(result.stderr)) {
		throw new Error(describeFailure("Deleting variable", name, result));
	}
}
