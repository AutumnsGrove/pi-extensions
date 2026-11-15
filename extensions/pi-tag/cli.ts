#!/usr/bin/env node
/**
 * The dry run: what would pi-tag do to this issue, and why.
 *
 *   node extensions/pi-tag/cli.ts --repo ../lattice --issue 1657
 *   node extensions/pi-tag/cli.ts --repo ../lattice --issue 1657 --json
 *   node extensions/pi-tag/cli.ts --repo ../lattice --issue 1648 --fix "the fonts also live in \`landing\`"
 *
 * Writes nothing, anywhere. It reads the target's manifest and tree, fetches the
 * issue through `gh`, runs the same agent the workflow will run, and prints the
 * proposal the validator produced. Phase 0 is this command over the last 40
 * issues: if it does not change any decisions, the premise is wrong.
 */

import { resolve } from "node:path";
import { GhError, evidenceFor, nodeExec, readCheckout, readIssue } from "./github.ts";
import { buildProposal, ProposalError } from "./proposal.ts";
import { buildPrompt } from "./prompt.ts";
import { jsonReport, formatReport } from "./report.ts";
import { runPi } from "./runner.ts";

interface Args {
	repo: string;
	issue?: number;
	provider: string;
	model: string;
	thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	json: boolean;
	fix?: string;
	previous: string[];
	timeoutMs: number;
	help: boolean;
}

const USAGE = `pi-tag dry run — writes nothing

  node extensions/pi-tag/cli.ts [options]

  --repo <path>        checkout to read (default: .)
  --issue <number>     issue to label (required)
  --fix <text>         an @pi fix request; enables removals
  --previous <a,b>     labels from a previous run's applied marker
  --provider <name>    (default: opencode-go)
  --model <id>         (default: glm-5.3-flash)
  --thinking <level>   off|minimal|low|medium|high|xhigh|max (default: medium)
  --timeout <seconds>  how long to let pi work (default: 300)
  --json               machine-readable output
  --help               this text`;

function parseArgs(argv: string[]): Args {
	const args: Args = {
		repo: ".",
		provider: "opencode-go",
		model: "glm-5.3-flash",
		thinking: "medium",
		json: false,
		previous: [],
		timeoutMs: 300_000,
		help: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		const next = (): string => {
			const value = argv[index + 1];
			if (value === undefined) throw new Error(`${flag} needs a value`);
			index += 1;
			return value;
		};
		switch (flag) {
			case "--repo":
				args.repo = next();
				break;
			case "--issue":
				args.issue = Number(next());
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
	let checkout;
	try {
		checkout = readCheckout(root);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 2;
	}

	let issue;
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

	const prompt = buildPrompt({
		manifest: checkout.manifest,
		issue: {
			number: issue.number,
			title: issue.title,
			body: issue.body,
			labels: issue.labels,
		},
		...(args.fix ? { fix: { note: args.fix, previous: args.previous } } : {}),
	});

	const run = await runPi({
		cwd: root,
		system: prompt.system,
		context: prompt.context,
		provider: args.provider,
		model: args.model,
		thinking: args.thinking,
		timeoutMs: args.timeoutMs,
	});

	if (!run.ok) {
		console.error(`pi failed: ${run.error ?? "unknown error"}`);
		if (run.output) console.error(run.output.slice(0, 2_000));
		return 1;
	}

	let proposal;
	try {
		proposal = buildProposal({
			reply: run.output,
			manifest: checkout.manifest,
			issue: { title: issue.title, labels: issue.labels },
			evidence: evidenceFor(checkout, issue.title),
			...(args.previous.length > 0 ? { previous: args.previous } : {}),
			...(args.fix ? { fix: { note: args.fix } } : {}),
		});
	} catch (error) {
		if (error instanceof ProposalError) {
			console.error(`${error.message}\n\n--- reply ---\n${error.excerpt.slice(0, 2_000)}`);
			return 1;
		}
		throw error;
	}

	if (prompt.truncated && !args.json) {
		console.error("note: the issue body was truncated to the prompt budget\n");
	}

	console.log(args.json ? JSON.stringify(jsonReport(issue, proposal), null, 2) : formatReport(issue, proposal));
	return 0;
}

main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error) => {
		console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
		process.exitCode = 1;
	});
