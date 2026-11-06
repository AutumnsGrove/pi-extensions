/**
 * `/pi-review install` — the identity half of the installer.
 *
 * Mirrors the shape of Claude Code's `/install-github-app`: preflight, say what
 * will change, create a GitHub App through the manifest flow (or reuse the one
 * already stored on the repo), write the App secrets, then walk the user through
 * installing it on the repository. Everything is injected (UI, command runner,
 * HTTP, browser, server) so the whole wizard is testable without a browser or
 * network.
 *
 * The App private key is only ever returned once, by GitHub, at exchange time.
 * It goes straight to `gh secret set` on stdin: never printed, logged, or
 * written to disk. If storing fails, the error names the App so the user can
 * generate a new key in its settings.
 */

import { randomBytes } from "node:crypto";
import { type Exec, type RepoRef, hasGhAuth, resolveRepo, run } from "./detect.ts";
import {
	type FetchLike,
	type CreatedApp,
	accountKind,
	authenticatedLogin,
	exchangeManifestCode,
	findAppInstallation,
} from "./github/app.ts";
import { type CommandRunner, spawnRunner } from "./github/exec.ts";
import {
	appAdvancedSettingsUrl,
	appInstallUrl,
	appNameFor,
	appSettingsUrl,
	buildManifest,
	installationsSettingsUrl,
	manifestSubmitUrl,
	parseRedirectUrl,
} from "./github/manifest.ts";
import { openExternalUrl } from "./github/open.ts";
import {
	ManifestCancelledError,
	ManifestTimeoutError,
	type ManifestServer,
	type ManifestServerOptions,
	startManifestServer,
} from "./github/server.ts";
import {
	APP_ID_SECRET,
	APP_KEY_SECRET,
	APP_SLUG_VARIABLE,
	deleteRepoSecret,
	deleteRepoVariable,
	getRepoVariable,
	listRepoSecretNames,
	setRepoSecret,
	setRepoVariable,
} from "./github/secrets.ts";

export interface WizardUI {
	/** Returns false on Escape or "No". */
	confirm(title: string, message: string): Promise<boolean>;
	/** Returns undefined on Escape. */
	select(title: string, options: string[]): Promise<string | undefined>;
	/** Returns undefined on Escape. */
	input(title: string, placeholder?: string): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

export interface InstallDeps {
	exec: Exec;
	/** stdin-capable runner for `gh secret set`. */
	run?: CommandRunner;
	fetch?: FetchLike;
	openUrl?: (url: string) => Promise<boolean>;
	startServer?: (options: ManifestServerOptions) => Promise<ManifestServer>;
	/** How long to wait for the browser redirect. */
	timeoutMs?: number;
}

export interface InstallOptions {
	cwd: string;
	env?: Record<string, string | undefined>;
	ui: WizardUI;
	deps: InstallDeps;
}

export interface AppIdentity {
	id: number;
	slug: string;
	name: string;
}

export type InstallOutcome =
	| { status: "aborted"; changed: string[]; reason?: string }
	| { status: "token"; changed: string[] }
	| { status: "existing"; repo: RepoRef; appSlug: string; installed: boolean; changed: string[] }
	| { status: "created"; repo: RepoRef; app: AppIdentity; installed: boolean; changed: string[] };

const APP_ARG_HINT = `${APP_ID_SECRET} and ${APP_KEY_SECRET} as repository secrets`;

const CREATE = "Create a Pi GitHub App (recommended)";
const REUSE = "Reuse the existing Pi GitHub App";
const TOKEN = "Use GITHUB_TOKEN instead (no App)";

/** Human-readable plan shown before anything is changed. */
export function renderInstallPlan(repo: RepoRef, hasIdentity: boolean): string {
	const name = appNameFor(repo);
	const lines = [
		"pi-review uses a GitHub App so reviews post as the App, not as you and not as `github-actions[bot]`.",
		"",
		"This will set up that identity:",
		`- create (or reuse) the App \`${name}\` on github.com; you approve it in the browser`,
		"- request only: contents read, pull requests write, issues write",
		`- store ${APP_KEY_SECRET} and ${APP_ID_SECRET} as repository secrets`,
		"- open GitHub so you can install the App on this repository",
		"",
		"Nothing is committed to the repository yet: the workflow and settings come next.",
	];
	if (hasIdentity) {
		lines.push("", `This repo already has App secrets. You can reuse them instead of creating another App.`);
	}
	return lines.join("\n");
}

function installUrlFor(app: { slug: string; id: number }): string {
	return appInstallUrl(app.slug || String(app.id));
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

async function confirmInstallation(
	options: InstallOptions,
	repo: RepoRef,
	match: { appId?: number; appSlug?: string },
	displayName: string,
	installUrl: string
): Promise<boolean> {
	const { exec, openUrl = async (url: string) => openExternalUrl(url) } = options.deps;
	const { ui, cwd } = options;

	const opened = await openUrl(installUrl);
	ui.notify(
		opened
			? `Opened the App installation page for ${displayName}.`
			: `Open this URL to install ${displayName}: ${installUrl}`,
		"info"
	);
	const confirmed = await ui.confirm(
		"Install the App",
		`Select ${repo.owner}/${repo.repo} on GitHub, install ${displayName}, then continue.`
	);
	if (!confirmed) return false;

	const lookup = await findAppInstallation(exec, cwd, repo, match);
	if (lookup.repoInstalled) return true;
	ui.notify(
		`Could not confirm the installation on ${repo.owner}/${repo.repo} yet. You can finish at ${installUrl}; reviews will fail until it is installed.`,
		"warning"
	);
	return false;
}

/**
 * Run the wizard. Throws for preflight failures; a user who presses Escape gets
 * an `aborted` outcome that lists what was already changed.
 */
export async function installPiReview(options: InstallOptions): Promise<InstallOutcome> {
	const { cwd, ui } = options;
	const exec = options.deps.exec;
	const commandRunner = options.deps.run ?? spawnRunner;
	const fetchImpl = options.deps.fetch;
	const startServer = options.deps.startServer ?? startManifestServer;
	const openUrl = options.deps.openUrl ?? (async (url: string) => openExternalUrl(url));

	const repo = await resolveRepo(exec, cwd);
	if (!repo) {
		throw new Error("Not a github.com checkout. Add an `origin` remote on github.com first, or run this in the repository you want reviewed.");
	}
	if (!(await hasGhAuth(exec, cwd))) {
		throw new Error("`gh` is not authenticated. Run `gh auth login` and try again.");
	}
	if (!(await repoAdmin(exec, cwd, repo))) {
		throw new Error(
			`Repository admin is required to set secrets on ${repo.owner}/${repo.repo}. Ask an admin, or run this against a repository you own.`
		);
	}

	const secrets = await listRepoSecretNames({ run: commandRunner, repo, cwd });
	const hasId = secrets.includes(APP_ID_SECRET);
	const hasKey = secrets.includes(APP_KEY_SECRET);
	const hasIdentity = hasId && hasKey;
	const partialIdentity = (hasId || hasKey) && !hasIdentity;

	if (partialIdentity) {
		ui.notify(
			`Only one of ${APP_ID_SECRET} / ${APP_KEY_SECRET} is set. The wizard will replace the incomplete pair.`,
			"warning"
		);
	}

	const proceed = await ui.confirm("Install pi-review", renderInstallPlan(repo, hasIdentity));
	if (!proceed) return { status: "aborted", changed: [] };

	const identityOptions = hasIdentity ? [REUSE, CREATE, TOKEN] : [CREATE, TOKEN];
	const choice = await ui.select("Identity for reviews", identityOptions);
	if (choice === undefined) return { status: "aborted", changed: [] };

	if (choice === TOKEN) {
		const changed: string[] = [];
		if (hasIdentity || partialIdentity) {
			const remove = await ui.confirm(
				"Use GITHUB_TOKEN?",
				`Delete ${APP_ID_SECRET} and ${APP_KEY_SECRET} from this repository so the workflow falls back to GITHUB_TOKEN?`
			);
			if (remove) {
				if (hasId) {
					await deleteRepoSecret({ run: commandRunner, repo, cwd, name: APP_ID_SECRET });
					changed.push(APP_ID_SECRET);
				}
				if (hasKey) {
					await deleteRepoSecret({ run: commandRunner, repo, cwd, name: APP_KEY_SECRET });
					changed.push(APP_KEY_SECRET);
				}
				await deleteRepoVariable({ run: commandRunner, repo, cwd, name: APP_SLUG_VARIABLE });
				changed.push(APP_SLUG_VARIABLE);
			}
		}
		return { status: "token", changed };
	}

	if (choice === REUSE) {
		const storedSlug = await getRepoVariable({ run: commandRunner, repo, cwd, name: APP_SLUG_VARIABLE });
		const appSlug = storedSlug ?? appNameFor(repo);
		const lookup = await findAppInstallation(exec, cwd, repo, { appSlug });
		if (!lookup.installation) {
			ui.notify(
				`No installation of \`${appSlug}\` is visible to your account. If the App was renamed, update ${APP_SLUG_VARIABLE} or create a new App.`,
				"warning"
			);
			return { status: "existing", repo, appSlug, installed: false, changed: [] };
		}
		const installed = lookup.repoInstalled
			? true
			: await confirmInstallation(
					options,
					repo,
					{ appId: lookup.installation.appId, appSlug: lookup.installation.appSlug },
					lookup.installation.appSlug,
					appInstallUrl(lookup.installation.appSlug)
				);
		return { status: "existing", repo, appSlug: lookup.installation.appSlug, installed, changed: [] };
	}

	// --- Create a new App -----------------------------------------------------
	const changed: string[] = [];
	const login = await authenticatedLogin(exec, cwd);
	if (!login) throw new Error("Could not read the authenticated `gh` account. Run `gh auth status`.");

	const ownerKind = await accountKind(exec, cwd, repo.owner);
	let organization: string | undefined = ownerKind === "organization" ? repo.owner : undefined;
	if (ownerKind === "organization" && login !== repo.owner) {
		const answer = await ui.select("Where should the GitHub App live?", [
			`${repo.owner} (organization)`,
			`${login} (personal account)`,
		]);
		if (answer === undefined) return { status: "aborted", changed };
		organization = answer.startsWith(repo.owner) ? repo.owner : undefined;
	}

	const state = randomBytes(16).toString("hex");
	const submitUrl = manifestSubmitUrl({ organization, state });
	const server = await startServer({
		state,
		submitUrl,
		buildManifest: (redirectUrl) => buildManifest({ repo, redirectUrl }),
		...(options.deps.timeoutMs === undefined ? {} : { timeoutMs: options.deps.timeoutMs }),
	});

	let code: string | undefined;
	try {
		const opened = await openUrl(server.startUrl);
		ui.notify(
			opened
				? "Opened GitHub in your browser. Approve the App, then come back."
				: `Open this URL to create the App: ${server.startUrl}`,
			"info"
		);
		ui.notify(
			"If the browser is on another machine, forward the local port or paste the redirect URL when prompted.",
			"info"
		);

		try {
			code = await server.waitForCode;
		} catch (error) {
			if (error instanceof ManifestTimeoutError) {
				const pasted = await ui.input(
					"Paste the URL from the browser's address bar (it contains code= and state=)"
				);
				const parsed = pasted ? parseRedirectUrl(pasted) : undefined;
				if (!parsed || parsed.state !== state) {
					return {
						status: "aborted",
						changed,
						reason: pasted ? "that URL does not belong to this run" : "cancelled",
					};
				}
				code = parsed.code;
			} else if (error instanceof ManifestCancelledError) {
				return { status: "aborted", changed, reason: "cancelled" };
			} else {
				throw error;
			}
		}
	} finally {
		await server.close();
	}

	if (!code) return { status: "aborted", changed };

	let app: CreatedApp;
	try {
		app = await exchangeManifestCode(code, { ...(fetchImpl ? { fetch: fetchImpl } : {}) });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`${message}\n\nThe App may already exist on GitHub. Check https://github.com/settings/apps; if it is there, generate a private key in its settings and set ${APP_ID_SECRET} / ${APP_KEY_SECRET} as repository secrets.`
		);
	}

	try {
		// The key first: the App ID is the marker a re-run looks for, so never set
		// it before the key it belongs to is stored.
		await setRepoSecret({ run: commandRunner, repo, cwd, name: APP_KEY_SECRET, value: app.pem });
		changed.push(APP_KEY_SECRET);
		await setRepoSecret({ run: commandRunner, repo, cwd, name: APP_ID_SECRET, value: String(app.id) });
		changed.push(APP_ID_SECRET);
		if (app.slug) {
			await setRepoVariable({ run: commandRunner, repo, cwd, name: APP_SLUG_VARIABLE, value: app.slug });
			changed.push(APP_SLUG_VARIABLE);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`The App was created (id ${app.id}${app.slug ? `, slug ${app.slug}` : ""}) but storing it in the repository failed: ${message}\n\nThat App cannot be recovered without a new key: open ${appAdvancedSettingsUrl(app.slug || String(app.id))}, generate a private key, and set ${APP_ARG_HINT}.`
		);
	}

	const installed = await confirmInstallation(
		options,
		repo,
		{ appId: app.id, ...(app.slug ? { appSlug: app.slug } : {}) },
		app.name || app.slug || String(app.id),
		installUrlFor(app)
	);

	return {
		status: "created",
		repo,
		app: { id: app.id, slug: app.slug, name: app.name },
		installed,
		changed,
	};
}

/** Markdown summary of what happened, including how to revoke each piece. */
export function renderInstallOutcome(outcome: InstallOutcome): string {
	if (outcome.status === "aborted") {
		const lines = ["## pi-review install cancelled", ""];
		if (outcome.reason) lines.push(`Reason: ${outcome.reason}.`, "");
		if (outcome.changed.length === 0) {
			lines.push("Nothing was changed.", "", "Run `/pi-review install` to start again.");
		} else {
			lines.push(
				"Already changed:",
				...outcome.changed.map((item) => `- \`${item}\``),
				"",
				"Run `/pi-review install` again: existing secrets are detected and can be reused."
			);
		}
		return lines.join("\n");
	}

	if (outcome.status === "token") {
		const lines = [
			"## pi-review will use GITHUB_TOKEN",
			"",
			"Reviews post as `github-actions[bot]` and the token cannot trigger other workflows.",
		];
		if (outcome.changed.length > 0) {
			lines.push("", "Removed:", ...outcome.changed.map((item) => `- \`${item}\``));
		}
		lines.push("", "Nothing was committed. The workflow and settings come next.");
		return lines.join("\n");
	}

	const repo = `${outcome.repo.owner}/${outcome.repo.repo}`;
	if (outcome.status === "existing") {
		const lines = [
			"## Existing Pi GitHub App reused",
			"",
			`- repository: ${repo}`,
			`- app slug: \`${outcome.appSlug}\``,
			`- installation: ${outcome.installed ? "confirmed on this repository" : "**not confirmed yet**"}`,
			"",
			`App settings: ${appSettingsUrl(outcome.appSlug)}`,
		];
		if (!outcome.installed) {
			lines.push(`Install it: ${appInstallUrl(outcome.appSlug)}`);
		}
		lines.push(
			"",
			"If reviews fail with 401, rotate the key: open the App settings, generate a private key, and run `/pi-review install` again.",
			"",
			"Nothing was committed. The workflow and settings come next."
		);
		return lines.join("\n");
	}

	const slug = outcome.app.slug || String(outcome.app.id);
	const lines = [
		"## Pi GitHub App ready",
		"",
		`- repository: ${repo}`,
		`- app: \`${outcome.app.name || outcome.app.slug}\` — id ${outcome.app.id}, slug \`${outcome.app.slug || "?"}\``,
		`- secrets: \`${APP_KEY_SECRET}\`, \`${APP_ID_SECRET}\``,
		`- installation: ${outcome.installed ? "confirmed on this repository" : "**not confirmed yet**"}`,
	];
	if (!outcome.installed) {
		lines.push(`- install it: ${appInstallUrl(slug)}`);
	}
	lines.push(
		"",
		"Nothing was committed. The workflow and settings come next.",
		"",
		"To revoke:",
		`- \`gh secret delete ${APP_ID_SECRET} --repo ${repo}\``,
		`- \`gh secret delete ${APP_KEY_SECRET} --repo ${repo}\``,
		`- uninstall the App: ${installationsSettingsUrl()}`,
		`- delete the App: ${appAdvancedSettingsUrl(slug)}`
	);
	return lines.join("\n");
}
