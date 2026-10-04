#!/usr/bin/env node
/**
 * Shell entrypoint for the cost tracker. Shares state with the pi extension
 * (`extensions/cost-tracker/index.ts`) via `~/.pi/agent/cost-tracker/`.
 *
 *   node extensions/cost-tracker/cli.ts start <label>
 *   node extensions/cost-tracker/cli.ts stop
 *   node extensions/cost-tracker/cli.ts status
 *   node extensions/cost-tracker/cli.ts report
 *   node extensions/cost-tracker/cli.ts export
 *
 * Run through `pnpm cost <cmd>`.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	COST_END,
	COST_START,
	aggregateByLabel,
	allRunsWithHistory,
	defaultLabel,
	formatDuration,
	formatTokens,
	formatUsd,
	readActive,
	readRuns,
	renderCostTable,
	startRun,
	stopRun,
	upsertCostBlock,
} from "./ledger.ts";

const USAGE = `Usage: cost <command>

Commands:
  start <label>   Begin a tracked run in the current directory
  stop            Finalize the active run and export the table
  status          Show the active run and its elapsed time
  report          Print the ledger table
  export          Rewrite the README cost block from the ledger
`;

function exportCostTable(cwd: string): string | undefined {
	const readme = join(cwd, "README.md");
	if (!existsSync(readme)) {
		return undefined;
	}
	const markdown = readFileSync(readme, "utf8");
	const table = renderCostTable(allRunsWithHistory());
	writeFileSync(readme, upsertCostBlock(markdown, table), "utf8");
	return readme;
}

function cmdStart(args: string[]): void {
	const cwd = process.cwd();
	const label = args.join(" ").trim() || defaultLabel(cwd);
	const run = startRun(label, cwd);
	console.log(`Tracking "${run.label}" in ${run.cwd}`);
	console.log(`Started ${run.startedAt}`);
	console.log("Run `pnpm cost stop` when done (or /cost stop inside pi).");
}

function cmdStop(): void {
	const active = readActive();
	if (!active) {
		console.error("No active run. Start one with `pnpm cost start <label>`.");
		process.exitCode = 1;
		return;
	}
	const result = stopRun();
	if (!result) {
		console.error("No active run.");
		process.exitCode = 1;
		return;
	}
	console.log(
		`Finalized "${result.run.label}": ${formatUsd(result.run.usage.cost)} · ${formatTokens(
			result.run.usage.totalTokens
		)} tok · ${result.records} messages`
	);
	const exported = exportCostTable(active.cwd);
	console.log(exported ? `Table updated in ${exported}` : "No README.md to export to.");
}

function cmdStatus(): void {
	const active = readActive();
	if (!active) {
		const runs = readRuns();
		console.log(`No active run. ${runs.length} finalized run(s) in the ledger.`);
		return;
	}
	const elapsed = formatDuration(Date.now() - Date.parse(active.startedAt));
	console.log(`Run:     ${active.label}`);
	console.log(`Cwd:     ${active.cwd}`);
	console.log(`Started: ${active.startedAt} (${elapsed} ago)`);
	console.log("Final cost is computed from session files on `cost stop`.");
}

function cmdReport(): void {
	const runs = allRunsWithHistory();
	const totals = aggregateByLabel(runs);
	if (totals.length === 0) {
		console.log("No runs recorded yet.");
		return;
	}
	for (const entry of totals) {
		console.log(
			`${entry.label.padEnd(20)} ${formatUsd(entry.usage.cost).padStart(9)}  ${formatTokens(
				entry.usage.totalTokens
			).padStart(7)}  ${entry.runs} run(s)`
		);
	}
}

function cmdExport(): void {
	const exported = exportCostTable(process.cwd());
	if (!exported) {
		console.error("No README.md in the current directory.");
		process.exitCode = 1;
		return;
	}
	const markdown = readFileSync(exported, "utf8");
	if (!markdown.includes(COST_START) || !markdown.includes(COST_END)) {
		console.log(
			`Appended a new cost block to ${exported} (add ${COST_START} / ${COST_END} to place it).`
		);
		return;
	}
	console.log(`Cost table written to ${exported}`);
}

function main(): void {
	const [command = "", ...args] = process.argv.slice(2);
	switch (command) {
		case "start":
			cmdStart(args);
			return;
		case "stop":
			cmdStop();
			return;
		case "status":
			cmdStatus();
			return;
		case "report":
			cmdReport();
			return;
		case "export":
			cmdExport();
			return;
		default:
			console.log(USAGE);
			if (command && command !== "help" && command !== "--help") {
				process.exitCode = 1;
			}
	}
}

main();
