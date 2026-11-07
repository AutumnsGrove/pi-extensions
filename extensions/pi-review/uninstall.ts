/**
 * `/pi-review uninstall` — put the repository back.
 *
 * Removes the committed settings and workflow on a branch (never by pushing to
 * the default branch), then offers to delete the repository secrets and the
 * slug variable. The GitHub App itself is not deleted over the API: the App
 * stays installed until the user removes it, and the summary links the pages
 * that do it.
 */

import { access } from "node:fs/promises";
import { join } from "node:path";
import { type Exec, type RepoRef, hasGhAuth, resolveRepo, run } from "./detect.ts";
import { type CommandRunner, spawnRunner } from "./github/exec.ts";
import { type BranchResult, resolveDefaultBranch, writeWorkflowBranch } from "./github/git.ts";
import {
	appAdvancedSettingsUrl,
	appSettingsUrl,
	installationsSettingsUrl,
} from "./github/manifest.ts";
import { openExternalUrl } from "./github/open.ts";
import {
	APP_ID_SECRET,
	APP_KEY_SECRET,
	APP_SLUG_VARIABLE,
	deleteRepoSecret,
	deleteRepoVariable,
	getRepoVariable,
	listRepoSecretNames,
} from "./github/secrets.ts";
import { API_KEY_SECRET, type WizardUI } from "./install.ts";
import { SETTINGS_PATH, WORKFLOW_PATH } from "./settings.ts";

export interface UninstallDeps {
	exec: Exec;
	run?: CommandRunner;
	writeBranch?: typeof writeWorkflowBranch;
	openUrl?: (url: string) => Promise<boolean>;
}

export interface UninstallOptions {
	cwd: string;
	ui: WizardUI;
	deps: UninstallDeps;
}

export interface UninstallOutcome {
	status: "aborted" | "done";
	repo: RepoRef;
	changed: string[];
	appSlug?: string;
	workflow?: BranchResult;
	workflowError?: string;
	nothingToDo?: boolean;
	secretsRemoved: string[];
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function repoAdmin(exec: Exec, cwd: string, repo: RepoRef): Promise<boolean> {
	const value = await run(
		exec,
		"gh",
		["api", `repos/${repo.owner}/${repo.repo}`, "--jq", ".permissions.admin"],
		{ cwd, timeout: 15_000 }
	);
	return value === "true";
}

export async function uninstallPiReview(options: UninstallOptions): Promise<UninstallOutcome> {
	const { cwd, ui } = options;
	const exec = options.deps.exec;
	const runner = options.deps.run ?? spawnRunner;
	const openUrl = options.deps.openUrl ?? (async (url: string) => openExternalUrl(url));

	const repo = await resolveRepo(exec, cwd);
	if (!repo) {
		throw new Error("Not a github.com checkout. Run this in the repository pi-review is installed on.");
	}
	if (!(await hasGhAuth(exec, cwd))) {
		throw new Error("`gh` is not authenticated. Run `gh auth login` and try again.");
	}
	if (!(await repoAdmin(exec, cwd, repo))) {
		throw new Error(
			`Repository admin is required to delete secrets on ${repo.owner}/${repo.repo}. Ask an admin.`
		);
	}

	const secrets = await listRepoSecretNames({ run: runner, repo, cwd });
	const appSlug = await getRepoVariable({ run: runner, repo, cwd, name: APP_SLUG_VARIABLE });
	const settingsPresent = await exists(join(cwd, SETTINGS_PATH));
	const workflowPresent = await exists(join(cwd, WORKFLOW_PATH));
	const identitySecrets = [API_KEY_SECRET, APP_ID_SECRET, APP_KEY_SECRET].filter((name) =>
		secrets.includes(name)
	);

	if (!settingsPresent && !workflowPresent && identitySecrets.length === 0 && !appSlug) {
		ui.notify("pi-review is not installed in this repository; nothing to remove.", "info");
		return { status: "done", repo, changed: [], secretsRemoved: [], nothingToDo: true };
	}

	const removedFiles = [
		...(settingsPresent ? [SETTINGS_PATH] : []),
		...(workflowPresent ? [WORKFLOW_PATH] : []),
	];
	const plan = [
		"Removing pi-review from this repository will:",
		...(removedFiles.length > 0
			? [
					`- commit the removal of ${removedFiles.map((path) => `\`${path}\``).join(" and ")} to a new branch`,
					"- open the PR-compare page (the workflow keeps running until that PR merges)",
				]
			: ["- find no committed workflow or settings to remove"]),
		...(identitySecrets.length > 0
			? [`- delete repository secrets: ${identitySecrets.map((name) => `\`${name}\``).join(", ")}`]
			: []),
		...(appSlug ? [`- delete the \`${APP_SLUG_VARIABLE}\` variable`] : []),
		"",
		"The GitHub App is not deleted automatically; the summary links the pages to uninstall and delete it.",
	];
	if (!(await ui.confirm("Uninstall pi-review", plan.join("\n")))) {
		return { status: "aborted", repo, changed: [], secretsRemoved: [] };
	}

	const changed: string[] = [];
	let workflow: BranchResult | undefined;
	let workflowError: string | undefined;
	if (removedFiles.length > 0) {
		try {
			const defaultBranch = (await resolveDefaultBranch(exec, cwd, repo)) ?? "main";
			const writeBranch = options.deps.writeBranch ?? writeWorkflowBranch;
			workflow = await writeBranch({
				exec,
				cwd,
				repo,
				defaultBranch,
				branch: "pi-review/remove",
				files: [],
				deletePaths: removedFiles,
				message: "Remove pi-review workflow and settings",
			});
			changed.push(...removedFiles);
			ui.notify(
				workflow.committed
					? `Pushed ${workflow.branch}. Open the compare page and merge it to finish removing the workflow.`
					: `${workflow.branch} already has the removal; nothing new to commit.`,
				"info"
			);
			await openUrl(workflow.compareUrl);
		} catch (error) {
			workflowError = error instanceof Error ? error.message : String(error);
			ui.notify(`Could not write the removal branch: ${workflowError}`, "warning");
		}
	}

	const secretsRemoved: string[] = [];
	if (identitySecrets.length > 0 || appSlug) {
		const proceed = await ui.confirm(
			"Delete the credentials?",
			[
				`Delete ${identitySecrets.length > 0 ? identitySecrets.map((name) => `\`${name}\``).join(", ") : "the secrets"}${appSlug ? ` and the \`${APP_SLUG_VARIABLE}\` variable` : ""}?`,
				"",
				"The workflow still on the default branch will fail on its next run after this.",
			].join("\n")
		);
		if (proceed) {
			for (const name of identitySecrets) {
				await deleteRepoSecret({ run: runner, repo, cwd, name });
				secretsRemoved.push(name);
				changed.push(name);
			}
			if (appSlug) {
				await deleteRepoVariable({ run: runner, repo, cwd, name: APP_SLUG_VARIABLE });
				changed.push(APP_SLUG_VARIABLE);
			}
		}
	}

	return {
		status: "done",
		repo,
		changed,
		secretsRemoved,
		...(appSlug ? { appSlug } : {}),
		...(workflow ? { workflow } : {}),
		...(workflowError ? { workflowError } : {}),
	};
}

/** Markdown summary, including the manual App steps. */
export function renderUninstallOutcome(outcome: UninstallOutcome): string {
	if (outcome.status === "aborted") {
		return ["## pi-review uninstall cancelled", "", "Nothing was changed."].join("\n");
	}
	const repo = `${outcome.repo.owner}/${outcome.repo.repo}`;
	if (outcome.nothingToDo) {
		return [
			"## Nothing to remove",
			"",
			`No pi-review settings, workflow, secrets, or App variable were found on ${repo}.`,
		].join("\n");
	}

	const lines = ["## pi-review uninstalled", "", `- repository: ${repo}`];
	if (outcome.workflow) {
		lines.push(
			`- removal branch: \`${outcome.workflow.branch}\`${outcome.workflow.committed ? "" : " (already up to date)"}`,
			`- merge it to remove the workflow: ${outcome.workflow.compareUrl}`
		);
	} else if (outcome.workflowError) {
		lines.push(`- removal branch failed: ${outcome.workflowError}`);
	}
	if (outcome.secretsRemoved.length > 0) {
		lines.push(`- deleted secrets: ${outcome.secretsRemoved.map((name) => `\`${name}\``).join(", ")}`);
	}
	if (outcome.changed.includes(APP_SLUG_VARIABLE)) {
		lines.push(`- deleted variable: \`${APP_SLUG_VARIABLE}\``);
	}

	lines.push("", "## The GitHub App");
	if (outcome.appSlug) {
		lines.push(
			`The App \`${outcome.appSlug}\` was not deleted automatically.`,
			`- settings: ${appSettingsUrl(outcome.appSlug)}`,
			`- uninstall it: ${installationsSettingsUrl()}`,
			`- delete it: ${appAdvancedSettingsUrl(outcome.appSlug)}`
		);
	} else {
		lines.push(
			"No App slug was stored; manage installations and Apps here:",
			`- installations: ${installationsSettingsUrl()}`,
			"- apps: https://github.com/settings/apps"
		);
	}
	return lines.join("\n");
}
