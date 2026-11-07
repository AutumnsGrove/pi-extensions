/**
 * `/pi-review install` — the installer.
 *
 * Mirrors the shape of Claude Code's `/install-github-app`: preflight, say what
 * will change, set up the review identity (a GitHub App through the manifest
 * flow, or `GITHUB_TOKEN`), collect the review settings, and commit the settings
 * file plus the generated workflow to a branch with a ready PR-compare URL.
 *
 * Everything is injected (UI, command runner, HTTP, browser, redirect server,
 * branch writer) so the whole wizard is testable without a browser or network.
 *
 * The App private key is only ever returned once, by GitHub, at exchange time.
 * It goes straight to `gh secret set` on stdin: never printed, logged, or
 * written to disk. If storing fails, the error names the App so the user can
 * generate a new key in its settings.
 */

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { providerFlow, reviewKeyName } from "./auth/index.ts";
import { authorizeOpenCodeGo } from "./auth/opencode.ts";
import { authorizeOpenRouter } from "./auth/openrouter.ts";
import { type Exec, type RepoRef, hasGhAuth, resolveRepo, run } from "./detect.ts";
import {
	type FetchLike,
	type CreatedApp,
	type RepoInstallation,
	accountKind,
	authenticatedLogin,
	exchangeManifestCode,
	fetchAppInfo,
	getRepoInstallation,
	waitForRepoInstallation,
} from "./github/app.ts";
import { type CommandRunner, spawnRunner } from "./github/exec.ts";
import { resolveDefaultBranch, writeWorkflowBranch, type BranchResult } from "./github/git.ts";
import { createAppJwt } from "./github/jwt.ts";
import {
	type CachePaths,
	cachedAppFor,
	loadAppCache,
	saveAppKey,
	saveCachedApp,
} from "./global.ts";
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
import {
	DEFAULT_PI_VERSION,
	SETTINGS_PATH,
	THINKING_LEVELS,
	WORKFLOW_PATH,
	type IdentityMode,
	type ReviewSettings,
	type ThinkingLevel,
	defaultSettings,
	renderSettings,
} from "./settings.ts";
import { renderWorkflow } from "./workflow.ts";

export const API_KEY_SECRET = "PI_REVIEW_API_KEY";

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
	/** Verify the installation after the user installs (tests inject this). */
	waitForInstallation?: (options: { repo: RepoRef; jwt: string }) => Promise<RepoInstallation | undefined>;
	/** Write the settings + workflow branch (tests inject this). */
	writeBranch?: typeof writeWorkflowBranch;
	/** Provider credential flows (tests inject these). */
	authorizeOpenCode?: typeof authorizeOpenCodeGo;
	authorizeOpenRouter?: typeof authorizeOpenRouter;
	/** Override the machine-wide App cache (tests). */
	cachePath?: string;
	keyDir?: string;
	/** Tests set false so a run never writes a real key to disk. */
	saveAppKeyLocally?: boolean;
}

export interface InstallOptions {
	cwd: string;
	env?: Record<string, string | undefined>;
	ui: WizardUI;
	deps: InstallDeps;
	/** Prefills from the running session. */
	defaults?: { provider?: string; model?: string; thinking?: ThinkingLevel };
}

export interface AppIdentity {
	id: number;
	slug: string;
	name: string;
}

export interface WorkflowOutcome extends BranchResult {
	settingsPath: string;
	workflowPath: string;
}

interface OutcomeBase {
	changed: string[];
	apiKeySet?: boolean;
	apiKeyPresent?: boolean;
	workflow?: WorkflowOutcome;
	workflowSkipped?: boolean;
	workflowError?: string;
}

export type InstallOutcome = OutcomeBase &
	(
		| { status: "aborted"; reason?: string }
		| { status: "token"; repo: RepoRef }
		| { status: "existing"; repo: RepoRef; appSlug: string; installed: boolean; verified: boolean }
		| { status: "created"; repo: RepoRef; app: AppIdentity; installed: boolean }
	);

const APP_ARG_HINT = `${APP_ID_SECRET} and ${APP_KEY_SECRET} as repository secrets`;

const CREATE = "Create a Pi GitHub App (one per owner, recommended)";
const REUSE = "Reuse the Pi GitHub App on this repository";
const EXISTING = "Use an existing Pi GitHub App (App ID + key file)";
const TOKEN = "Use GITHUB_TOKEN instead (no App)";

interface Preflight {
	repo: RepoRef;
	secrets: string[];
	hasId: boolean;
	hasKey: boolean;
	hasIdentity: boolean;
	partialIdentity: boolean;
}

/** Human-readable plan shown before anything is changed. */
export function renderInstallPlan(
	repo: RepoRef,
	hasIdentity: boolean,
	defaults: InstallOptions["defaults"] = {}
): string {
	const name = appNameFor(repo);
	const model = defaults.model
		? `${defaults.provider ? `${defaults.provider}/` : ""}${defaults.model}`
		: "a model you choose";
	const lines = [
		"pi-review uses a GitHub App so reviews post as the App, not as you and not as `github-actions[bot]`.",
		"",
		"This will set up the review:",
		`- create (or reuse) the App \`${name}\` on github.com; one App per owner, installed on each repo`,
		"- request only: contents read, pull requests write, issues write",
		`- store ${APP_KEY_SECRET} and ${APP_ID_SECRET} as repository secrets`,
		"- open GitHub so you can install the App on this repository",
		`- use ${model} for reviews (change it later in \`.github/pi-review.json\`)`,
		`- commit ${SETTINGS_PATH} and ${WORKFLOW_PATH} to a new branch and open a PR-compare page`,
		"",
		"The default branch is never written to. Nothing runs until you merge that branch.",
	];
	if (hasIdentity) {
		lines.push("", "This repo already has App secrets. You can reuse them instead of creating another App.");
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

async function preflight(options: InstallOptions): Promise<Preflight> {
	const { exec, cwd } = { exec: options.deps.exec, cwd: options.cwd };
	const ui = options.ui;
	const repo = await resolveRepo(exec, cwd);
	if (!repo) {
		throw new Error(
			"Not a github.com checkout. Add an `origin` remote on github.com first, or run this in the repository you want reviewed."
		);
	}
	if (!(await hasGhAuth(exec, cwd))) {
		throw new Error("`gh` is not authenticated. Run `gh auth login` and try again.");
	}
	if (!(await repoAdmin(exec, cwd, repo))) {
		throw new Error(
			`Repository admin is required to set secrets on ${repo.owner}/${repo.repo}. Ask an admin, or run this against a repository you own.`
		);
	}
	const commandRunner = options.deps.run ?? spawnRunner;
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
	return { repo, secrets, hasId, hasKey, hasIdentity, partialIdentity };
}

async function promptInstallation(
	options: InstallOptions,
	repo: RepoRef,
	displayName: string,
	installUrl: string
): Promise<boolean> {
	const openUrl = options.deps.openUrl ?? (async (url: string) => openExternalUrl(url));
	const opened = await openUrl(installUrl);
	options.ui.notify(
		opened
			? `Opened the App installation page for ${displayName}.`
			: `Open this URL to install ${displayName}: ${installUrl}`,
		"info"
	);
	return await options.ui.confirm(
		"Install the App",
		`Select ${repo.owner}/${repo.repo} on GitHub, install ${displayName}, then continue.`
	);
}

type IdentityOutcome = OutcomeBase &
	(
		| { status: "aborted"; reason?: string }
		| { status: "token"; identity: "token"; repo: RepoRef }
		| {
				status: "existing";
				repo: RepoRef;
				appSlug: string;
				installed: boolean;
				verified: boolean;
				identity: "app";
		  }
		| { status: "created"; repo: RepoRef; app: AppIdentity; installed: boolean; identity: "app" }
	);

/**
 * Attach the machine-wide cached App for this owner, if its key file still
 * exists and verifies. Returns undefined (after a warning) so the normal
 * choices run when anything is off.
 */
async function tryCachedApp(
	options: InstallOptions,
	repo: RepoRef,
	cachePaths: CachePaths
): Promise<IdentityOutcome | undefined> {
	const { ui, cwd } = options;
	const fetchImpl = options.deps.fetch;
	const commandRunner = options.deps.run ?? spawnRunner;

	const cache = await loadAppCache(cachePaths);
	const entry = cachedAppFor(cache, repo.owner);
	if (!entry) return undefined;

	let pem: string;
	try {
		pem = await readFile(entry.keyPath, "utf8");
	} catch {
		ui.notify(
			`Cached App \`${entry.slug}\` key is missing at ${entry.keyPath}; falling back to the App choices.`,
			"warning"
		);
		return undefined;
	}
	if (!pem.includes("PRIVATE KEY")) {
		ui.notify(`Cached key at ${entry.keyPath} is not a PEM private key; falling back.`, "warning");
		return undefined;
	}

	let info: Awaited<ReturnType<typeof fetchAppInfo>>;
	try {
		info = await fetchAppInfo(createAppJwt(entry.appId, pem), {
			...(fetchImpl ? { fetch: fetchImpl } : {}),
		});
	} catch (error) {
		ui.notify(
			`Cached App could not be verified (${error instanceof Error ? error.message : String(error)}); falling back to the App choices.`,
			"warning"
		);
		return undefined;
	}

	const changed: string[] = [];
	try {
		await setRepoSecret({ run: commandRunner, repo, cwd, name: APP_KEY_SECRET, value: pem });
		changed.push(APP_KEY_SECRET);
		await setRepoSecret({ run: commandRunner, repo, cwd, name: APP_ID_SECRET, value: String(entry.appId) });
		changed.push(APP_ID_SECRET);
		await setRepoVariable({ run: commandRunner, repo, cwd, name: APP_SLUG_VARIABLE, value: info.slug });
		changed.push(APP_SLUG_VARIABLE);
	} catch (error) {
		ui.notify(
			`Could not store the cached App secrets (${error instanceof Error ? error.message : String(error)}); falling back.`,
			"warning"
		);
		return undefined;
	}

	ui.notify(`Using the cached Pi GitHub App \`${info.slug}\` (id ${entry.appId}).`, "info");

	const jwt = createAppJwt(entry.appId, pem);
	let verified = false;
	try {
		verified = Boolean(
			await getRepoInstallation(fetchImpl ?? (globalThis.fetch as unknown as FetchLike), repo, jwt)
		);
	} catch {
		verified = false;
	}
	let installed = verified;
	if (!installed) {
		installed = await promptInstallation(options, repo, info.name || info.slug, appInstallUrl(info.slug));
	}

	return {
		status: "existing",
		identity: "app",
		repo,
		appSlug: info.slug,
		installed,
		verified,
		changed,
	};
}

async function resolveIdentity(options: InstallOptions, state: Preflight): Promise<IdentityOutcome> {
	const { ui, cwd } = options;
	const exec = options.deps.exec;
	const commandRunner = options.deps.run ?? spawnRunner;
	const fetchImpl = options.deps.fetch;
	const startServer = options.deps.startServer ?? startManifestServer;
	const openUrl = options.deps.openUrl ?? (async (url: string) => openExternalUrl(url));
	const { repo } = state;
	const cachePaths: CachePaths = {
		...(options.deps.cachePath ? { cachePath: options.deps.cachePath } : {}),
		...(options.deps.keyDir ? { keyDir: options.deps.keyDir } : {}),
	};

	if (!state.hasIdentity) {
		const cached = await tryCachedApp(options, repo, cachePaths);
		if (cached) return cached;
	}

	const identityOptions = state.hasIdentity
		? [REUSE, CREATE, EXISTING, TOKEN]
		: [CREATE, EXISTING, TOKEN];
	const choice = await ui.select("Identity for reviews", identityOptions);
	if (choice === undefined) return { status: "aborted", changed: [] };

	if (choice === TOKEN) {
		const changed: string[] = [];
		if (state.hasIdentity || state.partialIdentity) {
			const remove = await ui.confirm(
				"Use GITHUB_TOKEN?",
				`Delete ${APP_ID_SECRET} and ${APP_KEY_SECRET} from this repository so the workflow falls back to GITHUB_TOKEN?`
			);
			if (remove) {
				if (state.hasId) {
					await deleteRepoSecret({ run: commandRunner, repo, cwd, name: APP_ID_SECRET });
					changed.push(APP_ID_SECRET);
				}
				if (state.hasKey) {
					await deleteRepoSecret({ run: commandRunner, repo, cwd, name: APP_KEY_SECRET });
					changed.push(APP_KEY_SECRET);
				}
				await deleteRepoVariable({ run: commandRunner, repo, cwd, name: APP_SLUG_VARIABLE });
				changed.push(APP_SLUG_VARIABLE);
			}
		}
		return { status: "token", identity: "token", repo, changed };
	}

	if (choice === REUSE) {
		const storedSlug = await getRepoVariable({ run: commandRunner, repo, cwd, name: APP_SLUG_VARIABLE });
		const appSlug = storedSlug ?? appNameFor(repo);
		// The stored private key cannot be read back, so the installation cannot
		// be verified from here; the user confirms it instead.
		const installed = await promptInstallation(options, repo, appSlug, appInstallUrl(appSlug));
		return {
			status: "existing",
			identity: "app",
			repo,
			appSlug,
			installed,
			verified: false,
			changed: [],
		};
	}

	if (choice === EXISTING) {
		const changed: string[] = [];
		const idRaw = await ui.input("App ID (GitHub App settings, near the top)");
		const appId = Number(idRaw);
		if (!idRaw?.trim() || !Number.isInteger(appId) || appId <= 0) {
			return { status: "aborted", changed, reason: "a numeric App ID is required" };
		}
		const keyPath = await ui.input("Path to the App private key (.pem; App settings → Generate a private key)");
		if (!keyPath?.trim()) return { status: "aborted", changed, reason: "cancelled" };
		const resolvedPath = keyPath.trim().replace(/^~(?=$|\/)/, homedir());
		let pem: string;
		try {
			pem = await readFile(resolvedPath, "utf8");
		} catch {
			throw new Error(`Could not read the private key at ${resolvedPath}.`);
		}
		if (!pem.includes("PRIVATE KEY")) {
			throw new Error("That file does not look like a PEM private key.");
		}

		let info: Awaited<ReturnType<typeof fetchAppInfo>>;
		try {
			info = await fetchAppInfo(createAppJwt(appId, pem), {
				...(fetchImpl ? { fetch: fetchImpl } : {}),
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Could not use that App: ${message}. Check the App ID and that the key is a current private key for that App.`
			);
		}

		try {
			await setRepoSecret({ run: commandRunner, repo, cwd, name: APP_KEY_SECRET, value: pem });
			changed.push(APP_KEY_SECRET);
			await setRepoSecret({ run: commandRunner, repo, cwd, name: APP_ID_SECRET, value: String(appId) });
			changed.push(APP_ID_SECRET);
			await setRepoVariable({ run: commandRunner, repo, cwd, name: APP_SLUG_VARIABLE, value: info.slug });
			changed.push(APP_SLUG_VARIABLE);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`That App is valid (${info.slug}) but storing its secrets failed: ${message}. The key is not stored; fix the cause and run install again.`
			);
		}

		try {
			await saveCachedApp(repo.owner, { appId, slug: info.slug, keyPath: resolvedPath }, cachePaths);
		} catch (error) {
			ui.notify(
				`Could not cache the App for other repositories: ${error instanceof Error ? error.message : String(error)}`,
				"warning"
			);
		}

		const confirmed = await promptInstallation(
			options,
			repo,
			info.name || info.slug,
			appInstallUrl(info.slug)
		);
		let installed = false;
		if (confirmed) {
			const jwt = createAppJwt(appId, pem);
			const wait =
				options.deps.waitForInstallation ??
				(async ({ repo: target, jwt: token }: { repo: RepoRef; jwt: string }) => {
					const doFetch = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
					return waitForRepoInstallation(doFetch, target, token);
				});
			try {
				installed = Boolean(await wait({ repo, jwt }));
			} catch (error) {
				ui.notify(
					`Could not verify the installation: ${error instanceof Error ? error.message : String(error)}`,
					"warning"
				);
			}
		}
		return {
			status: "existing",
			identity: "app",
			repo,
			appSlug: info.slug,
			installed,
			verified: installed,
			changed,
		};
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

	const stateId = randomBytes(16).toString("hex");
	const submitUrl = manifestSubmitUrl({ organization, state: stateId });
	const server = await startServer({
		state: stateId,
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
				if (!parsed || parsed.state !== stateId) {
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

	if (options.deps.saveAppKeyLocally !== false) {
		try {
			const keyPath = await saveAppKey(repo.owner, app.pem, cachePaths);
			await saveCachedApp(
				repo.owner,
				{ appId: app.id, slug: app.slug, keyPath },
				cachePaths
			);
			ui.notify(
				`Saved the App key at ${keyPath} so other repositories can reuse this App without asking.`,
				"info"
			);
		} catch (error) {
			ui.notify(
				`Could not save the App key locally: ${error instanceof Error ? error.message : String(error)}`,
				"warning"
			);
		}
	}

	const displayName = app.name || app.slug || String(app.id);
	const installUrl = installUrlFor(app);
	const confirmed = await promptInstallation(options, repo, displayName, installUrl);
	let installed = false;
	if (confirmed) {
		const jwt = createAppJwt(app.id, app.pem);
		const wait =
			options.deps.waitForInstallation ??
			(async ({ repo: target, jwt: token }: { repo: RepoRef; jwt: string }) => {
				const doFetch = fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
				return waitForRepoInstallation(doFetch, target, token);
			});
		try {
			installed = Boolean(await wait({ repo, jwt }));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ui.notify(`Could not verify the installation: ${message}`, "warning");
		}
		if (!installed) {
			ui.notify(
				`Could not confirm the installation on ${repo.owner}/${repo.repo} yet. You can finish at ${installUrl}; reviews will fail until it is installed.`,
				"warning"
			);
		}
	}

	return {
		status: "created",
		identity: "app",
		repo,
		app: { id: app.id, slug: app.slug, name: app.name },
		installed,
		changed,
	};
}

async function detectPiVersion(exec: Exec, cwd: string): Promise<string> {
	const version = await run(exec, "pi", ["--version"], { cwd, timeout: 15_000 });
	const clean = version?.trim().replace(/^v/, "");
	return clean && /^\d+\.\d+\.\d+/.test(clean) ? clean : DEFAULT_PI_VERSION;
}

/**
 * Ref of this package to check out in the workflow. Defaults to the local
 * pi-extensions commit; `PI_REVIEW_PACKAGE_REF` overrides it (use a tag for a
 * real install).
 */
async function detectPackageRef(exec: Exec, cwd: string, env: Record<string, string | undefined>): Promise<string> {
	const override = env.PI_REVIEW_PACKAGE_REF;
	if (override) return override;
	const root = fileURLToPath(new URL("../../", import.meta.url));
	const origin = await run(exec, "git", ["-C", root, "remote", "get-url", "origin"], { cwd });
	if (!origin || !/pi-extensions/.test(origin)) return "main";
	const sha = await run(exec, "git", ["-C", root, "rev-parse", "HEAD"], { cwd });
	return sha ?? "main";
}

async function collectReviewSettings(
	options: InstallOptions,
	identity: IdentityMode,
	piVersion: string,
	packageRef: string
): Promise<ReviewSettings | undefined> {
	const { ui } = options;
	const defaults = options.defaults ?? {};
	const settings = defaultSettings({
		identity,
		...(defaults.provider ? { provider: defaults.provider } : {}),
		...(defaults.model ? { model: defaults.model } : {}),
		...(defaults.thinking ? { thinking: defaults.thinking } : {}),
		piVersion,
		packageRef,
	});

	if (!settings.model) {
		const model = await ui.input("Model id for reviews (provider/model)", "provider/model");
		if (!model?.trim()) return undefined;
		settings.model = model.trim();
	}

	const thinking = await ui.select("Thinking level", [...THINKING_LEVELS]);
	if (thinking === undefined) return undefined;
	settings.thinking = thinking as ThinkingLevel;

	const tools = await ui.select("Reviewer tools", [
		"Read-only (read, grep, find, ls)",
		"Allow running tests (+ bash)",
	]);
	if (tools === undefined) return undefined;
	settings.tools.bash = tools.startsWith("Allow");
	if (settings.tools.bash) {
		settings.verify.installDependencies = await ui.confirm(
			"Install dependencies for tests?",
			[
				"The workflow will install the project's dependencies (pnpm/npm/yarn, from the lockfile) before the review, so the agent can run tests instead of only reading code.",
				"",
				"That runs package install scripts from the checkout and adds a few minutes to each review. If it fails, the reviewer is told the dependencies are unavailable.",
			].join("\n")
		);
	} else {
		settings.verify.installDependencies = false;
	}

	const verdict = await ui.select("Review verdict", [
		"Comment only (recommended)",
		"Request changes on problems",
	]);
	if (verdict === undefined) return undefined;
	settings.review.event = verdict.startsWith("Request") ? "REQUEST_CHANGES" : "COMMENT";

	return settings;
}

/**
 * Store `PI_REVIEW_API_KEY` for the configured provider: a device sign-in for
 * OpenCode Go, PKCE for OpenRouter, or a pasted key for anything else. A key
 * already in the repo is left alone.
 */
async function configureReviewKey(
	options: InstallOptions,
	repo: RepoRef,
	secrets: string[],
	settings: ReviewSettings
): Promise<boolean> {
	const { ui, cwd } = options;
	const commandRunner = options.deps.run ?? spawnRunner;
	if (secrets.includes(API_KEY_SECRET)) return false;
	if (!settings.providerEnv) {
		ui.notify(
			`No env var is known for provider \`${settings.provider}\`. Set "providerEnv" in ${SETTINGS_PATH} and add the key as ${API_KEY_SECRET}.`,
			"warning"
		);
		return false;
	}

	const flow = providerFlow(settings.provider);
	const signIn =
		flow === "opencode-go"
			? "Sign in to OpenCode Go (recommended)"
			: flow === "openrouter"
				? "Authorize OpenRouter (recommended)"
				: undefined;
	const choice = await ui.select(`Review API key for ${settings.provider}`, [
		...(signIn ? [signIn] : []),
		"Paste an API key",
		"Skip for now",
	]);
	if (choice === undefined || choice.startsWith("Skip")) return false;

	let key: string | undefined;
	if (choice.startsWith("Paste")) {
		key = await ui.input(
			`Paste the ${settings.provider} API key (visible while typing; stored as a repository secret)`
		);
	} else if (flow === "opencode-go") {
		const authorize = options.deps.authorizeOpenCode ?? authorizeOpenCodeGo;
		key = await authorize({
			keyName: reviewKeyName(repo),
			notify: (message) => ui.notify(message, "info"),
		});
	} else if (flow === "openrouter") {
		const authorize = options.deps.authorizeOpenRouter ?? authorizeOpenRouter;
		const openUrl = options.deps.openUrl ?? (async (url: string) => openExternalUrl(url));
		key = await authorize({
			keyLabel: reviewKeyName(repo),
			notify: (message) => ui.notify(message, "info"),
			openUrl,
			onCodePrompt: () => ui.input("Paste the code OpenRouter showed you"),
			...(options.deps.fetch ? { fetch: options.deps.fetch } : {}),
		});
	}

	if (!key?.trim()) return false;
	await setRepoSecret({ run: commandRunner, repo, cwd, name: API_KEY_SECRET, value: key.trim() });
	return true;
}

async function writeSetupFiles(
	options: InstallOptions,
	repo: RepoRef,
	settings: ReviewSettings
): Promise<WorkflowOutcome> {
	const exec = options.deps.exec;
	const cwd = options.cwd;
	const defaultBranch = (await resolveDefaultBranch(exec, cwd, repo)) ?? "main";
	const writeBranch = options.deps.writeBranch ?? writeWorkflowBranch;
	const files = [
		{ path: SETTINGS_PATH, content: renderSettings(settings) },
		{ path: WORKFLOW_PATH, content: renderWorkflow(settings) },
	];
	const result = await writeBranch({
		exec,
		cwd,
		repo,
		defaultBranch,
		files,
		message: "Add pi-review workflow and settings",
	});
	return {
		...result,
		settingsPath: SETTINGS_PATH,
		workflowPath: WORKFLOW_PATH,
	};
}

/**
 * Run the wizard. Throws for preflight failures; a user who presses Escape gets
 * an `aborted` outcome that lists what was already changed.
 */
export async function installPiReview(options: InstallOptions): Promise<InstallOutcome> {
	const { ui, cwd } = options;
	const exec = options.deps.exec;
	const env = options.env ?? process.env;
	const state = await preflight(options);
	const { repo } = state;

	const proceed = await ui.confirm(
		"Install pi-review",
		renderInstallPlan(repo, state.hasIdentity, options.defaults)
	);
	if (!proceed) return { status: "aborted", changed: [] };

	const identity = await resolveIdentity(options, state);
	if (identity.status === "aborted") return identity;

	const piVersion = await detectPiVersion(exec, cwd);
	const packageRef = await detectPackageRef(exec, cwd, env);
	const settings = await collectReviewSettings(
		options,
		identity.identity,
		piVersion,
		packageRef
	);
	if (!settings) {
		return {
			...identity,
			workflowSkipped: true,
			apiKeyPresent: state.secrets.includes(API_KEY_SECRET),
		};
	}

	const changed = [...identity.changed];
	let apiKeySet = false;
	try {
		apiKeySet = await configureReviewKey(options, repo, state.secrets, settings);
		if (apiKeySet) changed.push(API_KEY_SECRET);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ui.notify(`Could not set ${API_KEY_SECRET}: ${message}`, "warning");
	}

	let workflow: WorkflowOutcome | undefined;
	let workflowError: string | undefined;
	try {
		workflow = await writeSetupFiles(options, repo, settings);
		if (workflow.committed) {
			ui.notify(`Pushed ${workflow.branch}. Open the compare page to create the PR.`, "info");
		} else {
			ui.notify(
				`${workflow.branch} already matches the generated workflow; nothing new to commit.`,
				"info"
			);
		}
		const openUrl = options.deps.openUrl ?? (async (url: string) => openExternalUrl(url));
		await openUrl(workflow.compareUrl);
	} catch (error) {
		workflowError = error instanceof Error ? error.message : String(error);
		ui.notify(`Could not write the workflow: ${workflowError}`, "warning");
	}

	return {
		...identity,
		changed,
		apiKeySet,
		apiKeyPresent: state.secrets.includes(API_KEY_SECRET) || apiKeySet,
		...(workflow ? { workflow } : {}),
		...(workflowError ? { workflowError } : {}),
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

	const repo = `${outcome.repo.owner}/${outcome.repo.repo}`;
	const lines: string[] = [];
	if (outcome.status === "token") {
		lines.push(
			"## pi-review will use GITHUB_TOKEN",
			"",
			"Reviews post as `github-actions[bot]` and the token cannot trigger other workflows."
		);
	} else if (outcome.status === "existing") {
		lines.push(
			"## Existing Pi GitHub App reused",
			"",
			`- repository: ${repo}`,
			`- app slug: \`${outcome.appSlug}\``,
			`- installation: ${outcome.installed ? "confirmed by you (automatic verification needs the App key, which cannot be read back)" : "**not confirmed yet**"}`
		);
		if (!outcome.installed) lines.push(`- install it: ${appInstallUrl(outcome.appSlug)}`);
		lines.push("", `App settings: ${appSettingsUrl(outcome.appSlug)}`);
	} else {
		const slug = outcome.app.slug || String(outcome.app.id);
		lines.push(
			"## Pi GitHub App ready",
			"",
			`- repository: ${repo}`,
			`- app: \`${outcome.app.name || outcome.app.slug}\` — id ${outcome.app.id}, slug \`${outcome.app.slug || "?"}\``,
			`- secrets: \`${APP_KEY_SECRET}\`, \`${APP_ID_SECRET}\``,
			`- installation: ${outcome.installed ? "confirmed on this repository" : "**not confirmed yet**"}`
		);
		if (!outcome.installed) lines.push(`- install it: ${appInstallUrl(slug)}`);
	}

	lines.push("", "## Workflow");
	if (outcome.workflowSkipped) {
		lines.push(
			"Not written: the settings prompts were cancelled. Run `/pi-review install` again; the identity is already set up and can be reused."
		);
	} else if (outcome.workflowError) {
		lines.push(`Could not write it: ${outcome.workflowError}`, "", "The identity above is still set up. Fix the cause and run install again.");
	} else if (outcome.workflow) {
		const workflow = outcome.workflow;
		lines.push(
			`- branch: \`${workflow.branch}\`${workflow.committed ? "" : " (already up to date)"}`,
			`- files: \`${workflow.settingsPath}\`, \`${workflow.workflowPath}\``,
			`- open the PR: ${workflow.compareUrl}`
		);
	}

	lines.push("", "## Review credential");
	if (outcome.apiKeyPresent) {
		lines.push(`- \`${API_KEY_SECRET}\`: set`);
	} else {
		lines.push(
			`- \`${API_KEY_SECRET}\`: **not set** — the workflow will fail until it is`,
			`- set it with \`gh secret set ${API_KEY_SECRET} --repo ${repo}\``
		);
	}

	if (outcome.changed.length > 0) {
		lines.push("", "## Changed", ...outcome.changed.map((item) => `- \`${item}\``));
	}

	if (outcome.status === "created") {
		const slug = outcome.app.slug || String(outcome.app.id);
		lines.push(
			"",
			"## To revoke",
			`- \`gh secret delete ${APP_ID_SECRET} --repo ${repo}\``,
			`- \`gh secret delete ${APP_KEY_SECRET} --repo ${repo}\``,
			`- uninstall the App: ${installationsSettingsUrl()}`,
			`- delete the App: ${appAdvancedSettingsUrl(slug)}`
		);
	}

	if (outcome.status === "existing") {
		lines.push(
			"",
			"If reviews fail with 401, rotate the key: open the App settings, generate a private key, and set `PI_REVIEW_APP_PRIVATE_KEY` again."
		);
	}

	return lines.join("\n");
}
