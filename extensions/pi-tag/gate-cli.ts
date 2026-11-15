#!/usr/bin/env node
/**
 * The gate step in CI: read the event payload, decide, write `outputs`.
 *
 * All of the thinking is in `gate.ts`, which is tested. This only does the
 * plumbing GitHub needs — `GITHUB_OUTPUT` lines, and an event payload from
 * `GITHUB_EVENT_PATH` — so the decision can be exercised without a workflow run.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { gate, type GateEvent, type GatePolicy, type GateResult } from "./gate.ts";
import { SETTINGS_PATH, readSettings, DEFAULT_SETTINGS } from "./settings.ts";

export function toEnvName(key: string): string {
	return key.replace(/[^a-zA-Z0-9_]/g, "_").toUpperCase();
}

/** The `key=value` block the workflow reads back through `steps.gate.outputs`. */
export function formatOutputs(result: GateResult): string {
	const lines = [
		`run=${result.run}`,
		`reason=${result.reason}`,
		`issue=${result.issue ?? ""}`,
		`fix=${result.fix}`,
		`note<<PI_TAG_NOTE\n${result.note}\nPI_TAG_NOTE`,
		`dry_run=${result.dryRun}`,
	];
	return `${lines.join("\n")}\n`;
}

/** GitHub's payload, flattened to the few fields the gate reads. */
export function readEvent(payload: Record<string, unknown>): GateEvent {
	const issue = record(payload.issue);
	const comment = record(payload.comment);
	return {
		eventName: typeof payload.event_name === "string" ? payload.event_name : guessEventName(payload),
		issue: issue
			? {
					number: number(issue.number),
					isPullRequest: issue.pull_request !== undefined && issue.pull_request !== null,
					state: typeof issue.state === "string" ? issue.state : undefined,
					authorAssociation:
						typeof issue.author_association === "string" ? issue.author_association : undefined,
					userType: typeof record(issue.user)?.type === "string" ? String(record(issue.user)?.type) : undefined,
					login: typeof record(issue.user)?.login === "string" ? String(record(issue.user)?.login) : undefined,
				}
			: undefined,
		comment: comment
			? {
					body: typeof comment.body === "string" ? comment.body : "",
					authorAssociation:
						typeof comment.author_association === "string" ? comment.author_association : undefined,
					userType: typeof record(comment.user)?.type === "string" ? String(record(comment.user)?.type) : undefined,
					login: typeof record(comment.user)?.login === "string" ? String(record(comment.user)?.login) : undefined,
				}
			: undefined,
		dispatch: record(payload.inputs)
			? {
					issueNumber: string(record(payload.inputs)?.issue_number),
					dryRun: record(payload.inputs)?.dry_run !== false && string(record(payload.inputs)?.dry_run) !== "false",
				}
			: undefined,
	};
}

function guessEventName(payload: Record<string, unknown>): string {
	if (payload.inputs !== undefined) return "workflow_dispatch";
	if (payload.comment !== undefined) return "issue_comment";
	if (payload.issue !== undefined) return "issues";
	return "unknown";
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function number(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function string(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return undefined;
}

export function policyFrom(settings: ReturnType<typeof readSettings>, botLogin?: string): GatePolicy {
	return {
		mention: settings.triggers.mention,
		fixWord: settings.triggers.fix,
		who: settings.triggers.who,
		botLogin,
		removal: settings.labels.remove,
	};
}

function main(): number {
	const args = process.argv.slice(2);
	const flag = (name: string): string | undefined => {
		const index = args.indexOf(name);
		return index === -1 ? undefined : args[index + 1];
	};

	const eventPath = flag("--event") ?? process.env.GITHUB_EVENT_PATH;
	if (!eventPath) {
		console.error("no event payload: pass --event or set GITHUB_EVENT_PATH");
		return 2;
	}

	let payload: Record<string, unknown>;
	try {
		payload = JSON.parse(readFileSync(eventPath, "utf8")) as Record<string, unknown>;
	} catch (error) {
		console.error(`cannot read ${eventPath}: ${error instanceof Error ? error.message : String(error)}`);
		return 2;
	}

	const settingsPath = flag("--settings") ?? SETTINGS_PATH;
	let settings = DEFAULT_SETTINGS;
	try {
		settings = readSettings(settingsPath);
	} catch {
		// Fine: a repository with no settings file gets the documented defaults.
	}

	const botLogin = flag("--bot-login") ?? process.env.PI_TAG_BOT_LOGIN ?? undefined;
	const result = gate(readEvent(payload), policyFrom(settings, botLogin));

	const output = formatOutputs(result);
	const githubOutput = process.env.GITHUB_OUTPUT;
	if (githubOutput) appendFileSync(githubOutput, output);
	process.stdout.write(output);
	console.log(`gate: ${result.run ? "run" : "skip"} — ${result.reason}`);
	return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	process.exitCode = main();
}
