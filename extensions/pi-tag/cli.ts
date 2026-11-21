#!/usr/bin/env node
/**
 * pi-tag, end to end: read an issue, run the agent, check what it proposed,
 * print it — and, only with `--apply`, write it.
 *
 *   node extensions/pi-tag/cli.ts --repo ../lattice --issue 1657
 *   node extensions/pi-tag/cli.ts --repo ../lattice --issue 1657 --json
 *   node extensions/pi-tag/cli.ts --repo ../lattice --issue 1648 \
 *     --fix "the fonts also live in \`landing\`"
 *
 * Without `--apply`, nothing is written anywhere: it is the dry run that phase 0
 * gates on and the tool for prompt work. With `--apply`, it writes labels and one
 * comment, in that order, and says so in the comment if anything failed.
 */

import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyLabels, resolveRepo } from "./apply.ts";
import { findSummary, renderComment, renderFailure, upsertComment, worthPosting } from "./comment.ts";
import { GhError, type Issue, evidenceFor, nodeExec, readCheckout, readIssue } from "./github.ts";
import { buildProposal, ProposalError } from "./proposal.ts";
import { buildPrompt } from "./prompt.ts";
import { formatReport, jsonReport } from "./report.ts";
import { runPi } from "./runner.ts";
import { SETTINGS_PATH, readSettings } from "./settings.ts";

interface Args {
	repo: string;
	issue?: number;
	provider: string;
	model: string;
	thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	timeoutMs: number;
	json: boolean;
	showPrompt: boolean;
	apply: boolean;
	author: string;
	runUrl?: string;
	note?: string;
	fix?: string;
	previous: string[];
	/** Flags the caller actually passed, so the settings file can supply the rest. */
	provided: Set<string>;
	help: boolean;
}

const USAGE = `pi-tag — read the tree, check the evidence, tag the issue

  node extensions/pi-tag/cli.ts [options]

  --repo <path>        checkout to read (default: .)
  --issue <number>     issue to label (required)
  --apply              write labels and the comment (default: print only)
  --author <login>     the bot's login, for finding its own comment
  --run-url <url>      link to put in the comment
  --note <text>        a maintainer's request, as a steer
  --fix <text>         an @pi fix request; enables removals
  --previous <a,b>     labels from a previous run, when not applying
  --provider <name>    (default: opencode-go)
  --model <id>         (default: glm-5.3-flash)
  --thinking <level>   off|minimal|low|medium|high|xhigh|max (default: medium)
  --timeout <seconds>  how long to let pi work (default: 300)
  --json               machine-readable output, including the comment
  --show-prompt        print the system prompt and context first
  --help               this text`;

export function parseArgs(argv: string[]): Args {
	const args: Args = {
		repo: ".",
		provider: "opencode-go",
		model: "glm-5.3-flash",
		thinking: "medium",
		timeoutMs: 300_000,
		json: false,
		showPrompt: false,
		apply: false,
		author: "github-actions[bot]",
		previous: [],
		provided: new Set(),
		help: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index] ?? "";
		const next = (): string => {
			const value = argv[index + 1];
			if (value === undefined) throw new Error(`${flag} needs a value`);
			index += 1;
			args.provided.add(flag);
			return value;
		};
		switch (flag) {
			case "--repo":
				args.repo = next();
				break;
			case "--issue":
				args.issue = Number(next());
				break;
			case "--apply":
				args.apply = true;
				break;
			case "--author":
				args.author = next();
				break;
			case "--run-url":
				args.runUrl = next();
				break;
			case "--note":
				args.note = next();
				break;
			case "--fix":
				args.fix = next();
				break;
			case "--previous":
				args.previous = next()
					.split(",")
					.map((name) => name.trim())
					.filter(Boolean);
				break;
			case "--provider":
				args.provider = next();
				break;
			case "--model":
				args.model = next();
				break;
			case "--thinking":
				args.thinking = next() as Args["thinking"];
				break;
			case "--timeout":
				args.timeoutMs = Number(next()) * 1000;
				break;
			case "--json":
				args.json = true;
				break;
			case "--show-prompt":
				args.showPrompt = true;
				break;
			case "--help":
			case "-h":
				args.help = true;
				break;
			default:
				throw new Error(`unknown option ${flag}`);
		}
	}
	return args;
}

/** Everything the repository's settings can decide, overridden by a flag. */
function settingsDefaults(root: string): {
	provider?: string;
	model?: string;
	thinking?: Args["thinking"];
	manifest?: string;
	always?: boolean;
	considered?: boolean;
} {
	try {
		const settings = readSettings(resolve(root, SETTINGS_PATH));
		return {
			provider: settings.provider,
			model: settings.model,
			thinking: settings.thinking,
			manifest: settings.labels.manifest,
			always: settings.comment.always,
			considered: settings.comment.considered,
		};
	} catch {
		return {};
	}
}

/**
 * Tell the workflow this run reported itself, so the `failure()` fallback stays
 * quiet instead of posting a second comment on top of the sticky.
 */
export function noteHandled(): void {
	if (process.env.GITHUB_OUTPUT) {
		try {
			appendFileSync(process.env.GITHUB_OUTPUT, "handled=true\n");
		} catch {
			// Not being able to say so only costs a duplicate comment on failure.
		}
	}
}

async function main(): Promise<number> {
	let args: Args;
	try {
		args = parseArgs(process.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		console.error(USAGE);
		return 2;
	}
	if (args.help) {
		console.log(USAGE);
		return 0;
	}
	if (args.issue === undefined || Number.isNaN(args.issue)) {
		console.error("--issue is required\n");
		console.error(USAGE);
		return 2;
	}

	const root = resolve(args.repo);

	// The settings in the target repository win over the built-in defaults, and a
	// flag wins over both.
	const defaults = settingsDefaults(root);
	if (!args.provided.has("--provider") && defaults.provider) args.provider = defaults.provider;
	if (!args.provided.has("--model") && defaults.model) args.model = defaults.model;
	if (!args.provided.has("--thinking") && defaults.thinking) args.thinking = defaults.thinking;

	let checkout;
	try {
		checkout = readCheckout(root, defaults.manifest);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 2;
	}

	let issue: Issue;
	try {
		issue = await readIssue(nodeExec, root, args.issue);
	} catch (error) {
		if (error instanceof GhError) {
			console.error(`${error.message}\n${error.stderr}`);
			return 2;
		}
		throw error;
	}
	if (issue.state === "CLOSED") {
		console.error(`#${issue.number} is closed; the workflow would skip it`);
		return 2;
	}

	const repo = args.apply ? await resolveRepo(nodeExec, root) : undefined;
	if (args.apply && !repo) {
		console.error("cannot resolve owner/repo for this checkout; set up gh or run without --apply");
		return 2;
	}

	// Attribution comes from the bot's own comment, and only when writing.
	let previous = args.previous;
	let existingId: number | undefined;
	if (args.apply && repo) {
		const found = await findSummary(nodeExec, repo, issue.number, { cwd: root, author: args.author });
		existingId = found.id;
		previous = found.previous ?? [];
	}

	const prompt = buildPrompt({
		manifest: checkout.manifest,
		issue: { number: issue.number, title: issue.title, body: issue.body, labels: issue.labels },
		...(args.note && args.fix === undefined ? { note: args.note } : {}),
		...(args.fix !== undefined ? { fix: { note: args.fix, previous } } : {}),
	});

	if (args.showPrompt) {
		process.stderr.write(
			`--- system (${prompt.system.length} chars) ---\n${prompt.system}\n\n--- context (${prompt.context.length} chars) ---\n${prompt.context}\n\n`
		);
	}

	const fail = async (reason: string): Promise<number> => {
		console.error(reason);
		if (args.apply && repo) {
			await upsertComment(nodeExec, repo, issue.number, renderFailure(reason, previous, args.runUrl), {
				cwd: root,
				author: args.author,
				existingId,
			})
				.then(() => noteHandled())
				.catch((error: unknown) => {
					console.error(`could not record the failure: ${error instanceof Error ? error.message : String(error)}`);
				});
		}
		return 1;
	};

	const run = await runPi({
		cwd: root,
		system: prompt.system,
		context: prompt.context,
		provider: args.provider,
		model: args.model,
		thinking: args.thinking,
		timeoutMs: args.timeoutMs,
	});
	if (!run.ok) return fail(run.error ?? "pi failed");

	let proposal;
	try {
		proposal = buildProposal({
			reply: run.output,
			manifest: checkout.manifest,
			issue: { title: issue.title, labels: issue.labels },
			evidence: evidenceFor(checkout, issue.title),
			...(previous.length > 0 ? { previous } : {}),
			...(args.fix !== undefined ? { fix: { note: args.fix } } : {}),
		});
	} catch (error) {
		if (error instanceof ProposalError) {
			return fail(`${error.message}\n\n${error.excerpt.slice(0, 1_500)}`);
		}
		throw error;
	}

	const body = renderComment({
		proposal,
		previous,
		...(args.runUrl ? { runUrl: args.runUrl } : {}),
		model: args.model,
		...(defaults.considered === false ? { considered: false } : {}),
	});

	if (prompt.truncated && !args.json) {
		console.error("note: the issue body was truncated to the prompt budget\n");
	}

	if (!args.apply) {
		console.log(args.json ? JSON.stringify(jsonReport(issue, proposal, body), null, 2) : formatReport(issue, proposal));
		if (!args.json) {
			console.log(`\n--- comment that would be posted ---\n${body}`);
		}
		return 0;
	}

	if (!repo) return 2;

	// A run that changes nothing and is configured to stay quiet leaves the
	// previous comment alone rather than bumping its date.
	if (defaults.always === false && !worthPosting(proposal)) {
		console.log(formatReport(issue, proposal));
		console.log("\nnothing changed, and comment.always is false: leaving the comment alone");
		return 0;
	}

	// Labels first, then the comment: a cancellation between them leaves a stale
	// marker, which can only under-remove. The other order would claim labels the
	// issue does not have.
	let applied;
	try {
		applied = await applyLabels(
			nodeExec,
			issue.number,
			repo,
			{ add: proposal.applied.map((entry) => entry.name), remove: proposal.removed.map((entry) => entry.name) },
			{ cwd: root }
		);
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}

	try {
		await upsertComment(nodeExec, repo, issue.number, body, { cwd: root, author: args.author, existingId });
	} catch (error) {
		console.error(`labels were written but the comment was not: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}

	console.log(formatReport(issue, proposal));
	console.log(
		`\napplied to #${issue.number}: +${applied.added.join(",") || "none"} -${applied.removed.join(",") || "none"}`
	);
	return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main()
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error) => {
			console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
			process.exitCode = 1;
		});
}
