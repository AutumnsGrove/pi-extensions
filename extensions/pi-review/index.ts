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

import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
	type Exec,
	detectPullRequest,
	hasGhAuth,
	resolveBaseRef,
	resolveBranch,
	resolveRepo,
} from "./detect.ts";
import { parseDiff } from "./diff.ts";
import { parseRunArgs, reviewChildEnv, reviewPromptFor, reviewTools, runLocalReview } from "./local.ts";
import { renderReviewMarkdown, type ReviewMeta } from "./review.ts";
import { loadReviewTarget } from "./context.ts";
import { isReviewRunner, registerReviewRunner } from "./runner.ts";

const COMMAND_NAME = "pi-review";
const STATUS_KEY = "pi-review";
const MESSAGE_TYPE = "pi-review";
const EXTENSION_PATH = fileURLToPath(new URL("./index.ts", import.meta.url));

const SUBCOMMANDS = ["run", "status", "install", "settings", "uninstall", "help"];

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
		"",
		"Not implemented yet (next milestones): `install`, `settings`, `uninstall`.",
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
	argv: string[]
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
	const baseRef = options.baseRef ?? (await resolveBaseRef(exec, ctx.cwd));
	const model = options.model ?? modelLabel(ctx);
	const thinking = options.thinking ?? ctx.thinkingLevel;

	ctx.ui.setStatus(STATUS_KEY, "reviewing…");
	ctx.ui.setWorkingMessage("pi-review: reviewing the change…");
	try {
		const result = await runLocalReview({
			cwd: ctx.cwd,
			extensionPath: EXTENSION_PATH,
			prompt: reviewPromptFor({ number: pr, repo, baseRef }),
			model,
			thinking,
			tools: reviewTools(options.bash),
			dryRun: !options.post,
			env: reviewChildEnv({ prNumber: pr, baseRef }),
			onProgress: (line) => ctx.ui.setStatus(STATUS_KEY, `reviewing · ${line}`),
		});
		await showRunResult(
			pi,
			ctx,
			result,
			{ repo, number: pr, model, baseRef },
			options.post
		);
	} finally {
		ctx.ui.setWorkingMessage();
		ctx.ui.setStatus(STATUS_KEY, undefined);
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
	lines.push("", "Run `/pi-review run` for a local dry run.");
	await showMessage(pi, ctx, lines.join("\n"));
}

function pendingText(subcommand: string): string {
	return [
		`### \`/pi-review ${subcommand}\` is not implemented yet`,
		"",
		"This build ships the runner, `submit_review` validation, `/pi-review run`, and `/pi-review status`.",
		`The ${subcommand} step belongs to the next milestones (GitHub App + workflow + provider auth + settings panel).`,
		"See `extensions/pi-review/PLAN.md` for the design and the open issue for progress.",
	].join("\n");
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
			try {
				switch (subcommand) {
					case "":
					case "help":
						await showMessage(pi, ctx, helpText());
						return;
					case "run":
						await runCommand(pi, ctx, rest);
						return;
					case "status":
						await showStatus(pi, ctx);
						return;
					case "install":
					case "settings":
					case "uninstall":
						await showMessage(pi, ctx, pendingText(subcommand));
						return;
					default:
						ctx.ui.notify(`pi-review: unknown subcommand "${subcommand}" (try /pi-review help)`, "error");
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`pi-review: ${message}`, "error");
			}
		},
	});

	if (isReviewRunner()) registerReviewRunner(pi);
}
