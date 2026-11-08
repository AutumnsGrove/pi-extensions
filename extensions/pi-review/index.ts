/**
 * pi-review — one-command agentic PR review for pi.
 *
 * In an interactive session `/pi-review` manages the installer and runs local
 * dry runs. When `PI_REVIEW=1` (set by the generated workflow, or by
 * `/pi-review run`) the same extension becomes the review harness: it loads the
 * pull request, injects the review instructions and diff, registers
 * `submit_review`, and validates inline comments against the diff before one
 * review is posted.
 *
 * Milestone 1 (this build): the runner + `/pi-review run` + `/pi-review status`.
 * The install wizard, GitHub App, workflow generation, provider auth, and
 * settings panel land in the following milestones; see PLAN.md and the issue.
 */

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
	type Exec,
	type RepoRef,
	detectPullRequest,
	hasGhAuth,
	resolveBaseRef,
	resolveBranch,
	resolveHeadSha,
	resolveRepo,
	run,
} from "./detect.ts";
import { parseDiff } from "./diff.ts";
import { type CommandRunner, spawnRunner } from "./github/exec.ts";
import { openExternalUrl } from "./github/open.ts";
import { listRepoSecretNames } from "./github/secrets.ts";
import { editSettings } from "./panel.ts";
import { API_KEY_SECRET, installPiReview, renderInstallOutcome, type WizardUI } from "./install.ts";
import { parseRunArgs, reviewChildEnv, reviewPromptFor, reviewTools, runLocalReview } from "./local.ts";
import { renderReviewMarkdown, type ReviewMeta } from "./review.ts";
import { loadReviewTarget } from "./context.ts";
import { isReviewRunner, registerReviewRunner } from "./runner.ts";
import { SETTINGS_PATH, WORKFLOW_PATH, type ReviewSettings, parseSettings, renderSettings } from "./settings.ts";
import { resolveDefaultBranch, writeWorkflowBranch } from "./github/git.ts";
import { renderWorkflow } from "./workflow.ts";
import { renderUninstallOutcome, uninstallPiReview } from "./uninstall.ts";

const COMMAND_NAME = "pi-review";
const STATUS_KEY = "pi-review";
const MESSAGE_TYPE = "pi-review";
const EXTENSION_PATH = fileURLToPath(new URL("./index.ts", import.meta.url));

const SUBCOMMANDS = ["run", "status", "install", "settings", "uninstall", "help"];

/**
 * Aborts in-flight command work. Pi invalidates the command ctx on reload, so
 * every await that can outlive the command (device sign-in, dialogs, the local
 * review child) watches this signal instead of calling a stale ctx.
 */
let activeRun: AbortController | undefined;

function beginRun(): AbortController {
	activeRun?.abort(new Error("pi-review: a newer command took over."));
	const controller = new AbortController();
	activeRun = controller;
	return controller;
}

function endRun(controller: AbortController): void {
	if (activeRun === controller) activeRun = undefined;
}

/** The ctx throws this once pi reloads extensions or switches sessions. */
function isStaleContextError(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.message.startsWith("This extension ctx is stale after session replacement or reload.")
	);
}

/** Teardown runs after a reload too; never let it turn into a command error. */
function quietly(action: () => void): void {
	try {
		action();
	} catch {
		// The ctx is stale after reload/quit; there is no one left to tell.
	}
}

/** Resolve `fallback` as soon as `signal` aborts, even if `promise` never settles. */
async function abortable<T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined,
	fallback: T
): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return fallback;
	return await Promise.race([
		promise,
		new Promise<T>((resolve) => {
			signal.addEventListener("abort", () => resolve(fallback), { once: true });
		}),
	]);
}

function execFor(pi: ExtensionAPI): Exec {
	return (command, args, options) => pi.exec(command, args, options);
}

function modelLabel(ctx: ExtensionCommandContext): string | undefined {
	const model = ctx.model;
	return model ? `${model.provider}/${model.id}` : undefined;
}

async function showMessage(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	content: string,
	details: Record<string, unknown> = {}
): Promise<void> {
	pi.sendMessage(
		{ customType: MESSAGE_TYPE, content, display: true, details },
		{ triggerTurn: false }
	);
}

function helpText(): string {
	return [
		"## pi-review",
		"",
		"Agentic pull-request review for pi, run by pi inside GitHub Actions.",
		"",
		"- `/pi-review run [--post] [--pr N] [--base ref] [--model provider/id] [--thinking level] [--bash]` —",
		"  run the review agent locally against the current branch or a PR. Dry run by default;",
		"  prints the review instead of posting it. `--post` publishes it to the pull request.",
		"- `/pi-review status` — show the repository, pull request, base, diff size, and model a review would use.",
		"- `/pi-review install` — create the Pi GitHub App, mint the review key, then commit the settings and the generated workflow to a branch for review.",
		"- `/pi-review settings` — edit `.github/pi-review.json` in an editor; the workflow is regenerated and committed to a settings branch.",
		"- `/pi-review uninstall` — commit the removal to a branch and offer to delete the credentials.",
		"See `extensions/pi-review/PLAN.md` and the tracking issue.",
	].join("\n");
}

async function showRunResult(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	result: Awaited<ReturnType<typeof runLocalReview>>,
	meta: ReviewMeta,
	posted: boolean
): Promise<void> {
	if (!result.review) {
		const reasons = [
			result.timedOut ? "timed out" : undefined,
			result.aborted ? "aborted" : undefined,
			`exit ${result.code}`,
		].filter(Boolean);
		const tail = result.stderr.trim().slice(-4000);
		const body = [
			"### pi-review did not submit a review",
			"",
			reasons.join(" · "),
			result.text ? `\n${result.text}` : "",
			tail ? `\n\`\`\`\n${tail}\n\`\`\`` : "",
		]
			.filter(Boolean)
			.join("\n");
		await showMessage(pi, ctx, body, { dryRun: !posted, error: true });
		ctx.ui.notify(`pi-review: no review submitted (${reasons.join(", ")})`, "error");
		return;
	}

	const markdown = renderReviewMarkdown(result.review, meta);
	const footer = posted
		? result.url
			? `\n\nPosted: ${result.url}`
			: "\n\nPosted."
		: "\n\n---\n_Dry run — nothing was posted. Re-run with `/pi-review run --post` to publish._";
	await showMessage(pi, ctx, `${markdown}${footer}`, {
		dryRun: !posted,
		comments: result.review.comments.length,
		dropped: result.review.dropped.length,
		url: result.url,
	});
	const summary = `${result.review.comments.length} inline comment${result.review.comments.length === 1 ? "" : "s"}${posted ? " · posted" : " · dry run"}`;
	ctx.ui.notify(`pi-review: review ${posted ? "posted" : "ready"} (${summary})`, "info");
}

async function runCommand(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	argv: string[],
	signal: AbortSignal
): Promise<void> {
	if (!ctx.isProjectTrusted()) {
		ctx.ui.notify("pi-review: the project is not trusted; a review run needs a trusted checkout", "warning");
	}
	const options = parseRunArgs(argv);
	const exec = execFor(pi);

	const repo = await resolveRepo(exec, ctx.cwd);
	if (options.post && !repo) {
		throw new Error("--post needs a github.com `origin` remote");
	}
	const pr =
		options.prNumber ??
		((await hasGhAuth(exec, ctx.cwd)) ? await detectPullRequest(exec, ctx.cwd) : undefined);
	if (options.post && pr === undefined) {
		throw new Error(
			"--post needs a pull request: run from a branch with an open PR, or pass --pr <number>"
		);
	}
	if (pr !== undefined) await warnOnCheckoutMismatch(exec, ctx, pr);

	const baseRef = options.baseRef ?? (await resolveBaseRef(exec, ctx.cwd));
	const model = options.model ?? modelLabel(ctx);
	const thinking = options.thinking ?? ctx.thinkingLevel;

	// The local dry run mirrors the committed settings when they exist.
	let resolveThreads = false;
	try {
		const raw = await readFile(join(ctx.cwd, SETTINGS_PATH), "utf8");
		// Never resolve threads from a dry run; only `--post` may mutate the PR.
		resolveThreads = options.post && parseSettings(JSON.parse(raw)).review.resolveStaleThreads;
	} catch {
		resolveThreads = false;
	}

	ctx.ui.setStatus(STATUS_KEY, "reviewing…");
	ctx.ui.setWorkingMessage("pi-review: reviewing the change…");
	try {
		const result = await runLocalReview({
			cwd: ctx.cwd,
			extensionPath: EXTENSION_PATH,
			prompt: reviewPromptFor({ number: pr, repo, baseRef }),
			model,
			thinking,
			tools: reviewTools(options.bash, resolveThreads),
			dryRun: !options.post,
			env: {
				...reviewChildEnv({ prNumber: pr, baseRef }),
				...(resolveThreads ? { PI_REVIEW_RESOLVE_THREADS: "1" } : {}),
			},
			signal,
			onProgress: (line) =>
				quietly(() => ctx.ui.setStatus(STATUS_KEY, `reviewing · ${line}`)),
		});
		await showRunResult(
			pi,
			ctx,
			result,
			{ repo, number: pr, model, baseRef },
			options.post
		);
	} finally {
		quietly(() => ctx.ui.setWorkingMessage());
		quietly(() => ctx.ui.setStatus(STATUS_KEY, undefined));
	}
}

/**
 * `/pi-review run --pr N` reviews the PR diff but reads files from the local
 * checkout. If the checkout is neither the PR head nor a merge containing it,
 * findings can refer to the wrong code, so say so before spending the run.
 */
async function warnOnCheckoutMismatch(
	exec: Exec,
	ctx: ExtensionCommandContext,
	pr: number
): Promise<void> {
	const [localHead, prHead] = await Promise.all([
		resolveHeadSha(exec, ctx.cwd),
		run(exec, "gh", ["pr", "view", String(pr), "--json", "headRefOid", "--jq", ".headRefOid"], {
			cwd: ctx.cwd,
			timeout: 15_000,
		}),
	]);
	if (!localHead || !prHead || localHead === prHead) return;
	const ancestor = await exec("git", ["merge-base", "--is-ancestor", prHead, "HEAD"], { cwd: ctx.cwd });
	if ((ancestor.code ?? 1) === 0) return;
	ctx.ui.notify(
		`pi-review: the checkout is ${localHead.slice(0, 7)}, but PR #${pr} head is ${prHead.slice(0, 7)} — file reads may not match the diff`,
		"warning"
	);
}

async function settingsCommand(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	signal?: AbortSignal
): Promise<void> {
	const path = join(ctx.cwd, SETTINGS_PATH);
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		ctx.ui.notify("pi-review is not installed here (no .github/pi-review.json). Run `/pi-review install` first.", "info");
		return;
	}

	let existing: ReviewSettings;
	try {
		existing = parseSettings(JSON.parse(raw));
	} catch (error) {
		ctx.ui.notify(
			`Invalid settings: ${error instanceof Error ? error.message : String(error)}`,
			"error"
		);
		return;
	}

	const choice = await editSettings(existing, wizardUi(ctx, signal));
	if (choice === undefined) {
		ctx.ui.notify("Settings unchanged.", "info");
		return;
	}

	let settings: ReviewSettings;
	if (choice === "json") {
		const edited = await abortable(
			ctx.ui.editor("pi-review settings (JSON)", raw),
			signal,
			undefined
		);
		if (edited === undefined || edited === raw) {
			ctx.ui.notify("Settings unchanged.", "info");
			return;
		}
		try {
			settings = parseSettings(JSON.parse(edited));
		} catch (error) {
			ctx.ui.notify(
				`Invalid settings: ${error instanceof Error ? error.message : String(error)}`,
				"error"
			);
			return;
		}
	} else {
		settings = choice;
	}
	if (!settings.model) {
		ctx.ui.notify("Settings need a model id before they can be saved.", "error");
		return;
	}
	if (!settings.providerEnv) {
		ctx.ui.notify(
			`No env var is known for provider \`${settings.provider}\`; set "providerEnv" in the file.`,
			"warning"
		);
	}

	const exec = execFor(pi);
	const repo = await resolveRepo(exec, ctx.cwd);
	if (!repo) {
		ctx.ui.notify("Not a github.com checkout; cannot commit the settings.", "error");
		return;
	}

	ctx.ui.setStatus(STATUS_KEY, "writing settings…");
	try {
		const defaultBranch = (await resolveDefaultBranch(exec, ctx.cwd, repo)) ?? "main";
		const result = await writeWorkflowBranch({
			exec,
			cwd: ctx.cwd,
			repo,
			defaultBranch,
			branch: "pi-review/settings",
			files: [
				{ path: SETTINGS_PATH, content: renderSettings(settings) },
				{ path: WORKFLOW_PATH, content: renderWorkflow(settings) },
			],
			message: "Update pi-review settings",
		});
		await openExternalUrl(result.compareUrl);
		await showMessage(
			pi,
			ctx,
			[
				"## pi-review settings updated",
				"",
				`- branch: \`${result.branch}\`${result.committed ? "" : " (already up to date)"}`,
				`- files: \`${SETTINGS_PATH}\`, \`${WORKFLOW_PATH}\``,
				`- open the PR: ${result.compareUrl}`,
			].join("\n")
		);
	} finally {
		quietly(() => ctx.ui.setStatus(STATUS_KEY, undefined));
	}
}

async function uninstallCommand(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	signal?: AbortSignal
): Promise<void> {
	ctx.ui.setStatus(STATUS_KEY, "uninstall: checking the repository…");
	try {
		const outcome = await uninstallPiReview({
			cwd: ctx.cwd,
			ui: wizardUi(ctx, signal),
			deps: {
				exec: execFor(pi),
				run: spawnRunner,
				openUrl: async (url) => openExternalUrl(url),
			},
		});
		await showMessage(pi, ctx, renderUninstallOutcome(outcome), { uninstall: outcome.status });
	} finally {
		quietly(() => ctx.ui.setStatus(STATUS_KEY, undefined));
	}
}

async function showStatus(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const exec = execFor(pi);
	const repo = await resolveRepo(exec, ctx.cwd);
	const branch = await resolveBranch(exec, ctx.cwd);
	const gh = await hasGhAuth(exec, ctx.cwd);
	const pr = gh ? await detectPullRequest(exec, ctx.cwd) : undefined;
	const baseRef = await resolveBaseRef(exec, ctx.cwd);
	const target = await loadReviewTarget({ exec, cwd: ctx.cwd, env: process.env, prNumber: pr });
	const diff = parseDiff(target.diff);

	const lines = [
		"## pi-review status",
		"",
		`- repository: ${repo ? `${repo.owner}/${repo.repo}` : "not a github.com checkout"}`,
		`- branch: ${branch ?? "(detached)"}`,
		`- gh CLI: ${gh ? "authenticated" : "not signed in"}`,
		`- pull request: ${pr ? `#${pr}` : "none for this branch"}`,
		`- base: ${baseRef ?? target.baseRef}`,
		`- diff: ${diff.files.length} file${diff.files.length === 1 ? "" : "s"} (+${diff.additions} −${diff.deletions})`,
		`- model: ${modelLabel(ctx) ?? "not set"}${ctx.thinkingLevel ? ` (thinking: ${ctx.thinkingLevel})` : ""}`,
		`- workflow: not installed yet (milestone 3)`,
	];
	if (target.notes.length > 0) {
		lines.push("", "Notes:", ...target.notes.map((note) => `- ${note}`));
	}
	lines.push(...(await describeReviewSetup(pi, ctx, repo)));
	lines.push("", "Run `/pi-review run` for a local dry run.");
	await showMessage(pi, ctx, lines.join("\n"));
}

function commandRunnerFor(pi: ExtensionAPI): CommandRunner {
	return (command, args, options) => pi.exec(command, args, { cwd: options.cwd, timeout: options.timeoutMs });
}

async function describeReviewSetup(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	repo: RepoRef | undefined
): Promise<string[]> {
	const settingsPath = join(ctx.cwd, SETTINGS_PATH);
	let raw: string | undefined;
	try {
		raw = await readFile(settingsPath, "utf8");
	} catch {
		raw = undefined;
	}
	if (raw === undefined) {
		return ["", "- workflow: not installed — run `/pi-review install`"];
	}

	let settings: ReviewSettings;
	try {
		settings = parseSettings(JSON.parse(raw));
	} catch (error) {
		return ["", `- settings: invalid — ${error instanceof Error ? error.message : String(error)}`];
	}

	let workflowPresent = true;
	try {
		await access(join(ctx.cwd, WORKFLOW_PATH));
	} catch {
		workflowPresent = false;
	}

	const lines = [
		"",
		`- workflow: ${workflowPresent ? `\`${WORKFLOW_PATH}\`` : `**missing** \`${WORKFLOW_PATH}\``}`,
		`- identity: ${settings.identity === "app" ? "GitHub App" : "GITHUB_TOKEN"}`,
		`- review model: ${settings.provider ? `${settings.provider}/` : ""}${settings.model || "(not set)"} · thinking ${settings.thinking}`,
		`- tools: ${settings.tools.bash ? "read, grep, find, ls, bash" : "read, grep, find, ls"}`,
		`- verify: ${
			settings.tools.bash && settings.verify.installDependencies
				? settings.verify.installCommand
					? "custom install command before the review"
					: "dependencies installed from lockfiles before the review"
				: "read-only; tests are not run"
		}`,
		`- verdict: ${settings.review.event} · max ${settings.review.maxInlineComments} inline comments`,
		`- strictness: ${settings.review.strictness}`,
		`- package ref: \`${settings.pi.packageRef}\` · pi ${settings.pi.version}`,
	];

	if (repo) {
		try {
			const secrets = await listRepoSecretNames({ run: commandRunnerFor(pi), repo, cwd: ctx.cwd });
			lines.push(`- ${API_KEY_SECRET}: ${secrets.includes(API_KEY_SECRET) ? "set" : "**missing**"}`);
		} catch {
			lines.push("- secrets: cannot read (admin required)");
		}
	}
	return lines;
}

function wizardUi(ctx: ExtensionCommandContext, signal?: AbortSignal): WizardUI {
	const opts = signal ? { signal } : undefined;
	return {
		confirm: (title, message) => ctx.ui.confirm(title, message, opts),
		select: (title, options) => ctx.ui.select(title, options, opts),
		input: (title, placeholder) => ctx.ui.input(title, placeholder, opts),
		// The multi-line editor has no signal option; race it so a reload cannot
		// leave the command waiting on a dialog pi already removed.
		editor: (title, prefill) => abortable(ctx.ui.editor(title, prefill), signal, undefined),
		wait: async (title, message, waitOpts) => {
			// A one-option selector: any close (Enter, Escape, timeout) stops waiting.
			await ctx.ui.select(`${title}\n\n${message}`, ["Cancel sign-in"], waitOpts);
		},
		notify: (message, type) => ctx.ui.notify(message, type),
	};
}

async function installCommand(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	signal: AbortSignal
): Promise<void> {
	ctx.ui.setStatus(STATUS_KEY, "install: checking the repository…");
	try {
		const outcome = await installPiReview({
			cwd: ctx.cwd,
			env: process.env,
			ui: wizardUi(ctx, signal),
			signal,
			deps: {
				exec: execFor(pi),
				run: spawnRunner,
				openUrl: async (url) => openExternalUrl(url),
			},
			defaults: {
				...(ctx.model ? { provider: ctx.model.provider, model: ctx.model.id } : {}),
				...(ctx.thinkingLevel ? { thinking: ctx.thinkingLevel } : {}),
			},
		});
		await showMessage(pi, ctx, renderInstallOutcome(outcome), { install: outcome.status });
		if (outcome.status === "created" && !outcome.installed) {
			ctx.ui.notify("pi-review: the App is created; finish by installing it on the repository", "warning");
		}
	} finally {
		quietly(() => ctx.ui.setStatus(STATUS_KEY, undefined));
	}
}

export default function piReview(pi: ExtensionAPI): void {
	pi.registerCommand(COMMAND_NAME, {
		description: "Agentic PR review: local dry run and status (install/settings land next)",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const matches = SUBCOMMANDS.filter((name) => name.startsWith(prefix));
			return matches.length > 0 ? matches.map((name) => ({ value: name, label: name })) : null;
		},
		handler: async (args, ctx) => {
			const [subcommand = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const run = beginRun();
			try {
				switch (subcommand) {
					case "":
					case "help":
						await showMessage(pi, ctx, helpText());
						return;
					case "run":
						await runCommand(pi, ctx, rest, run.signal);
						return;
					case "status":
						await showStatus(pi, ctx);
						return;
					case "install":
						await installCommand(pi, ctx, run.signal);
						return;
					case "settings":
						await settingsCommand(pi, ctx, run.signal);
						return;
					case "uninstall":
						await uninstallCommand(pi, ctx, run.signal);
						return;
					default:
						ctx.ui.notify(`pi-review: unknown subcommand "${subcommand}" (try /pi-review help)`, "error");
				}
			} catch (error) {
				// A reload invalidates ctx; reporting that error would itself use the stale ctx.
				if (isStaleContextError(error) || run.signal.aborted) return;
				const message = error instanceof Error ? error.message : String(error);
				quietly(() => ctx.ui.notify(`pi-review: ${message}`, "error"));
			} finally {
				endRun(run);
			}
		},
	});

	if (isReviewRunner()) registerReviewRunner(pi);

	// Reload and quit emit session_shutdown before invalidating the ctx; the
	// session-changing commands invalidate it during the switch. Stop dialogs and
	// background work on all of them so the command unwinds instead of calling
	// into a ctx that is about to disappear.
	const stop = (): void => {
		activeRun?.abort(new Error("pi-review stopped because the session changed."));
		activeRun = undefined;
	};
	pi.on("session_shutdown", stop);
	pi.on("session_before_switch", stop);
	pi.on("session_before_fork", stop);
	pi.on("session_before_tree", stop);
}
