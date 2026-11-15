/**
 * pi-tag as a pi command: `/pi-tag run`, `/pi-tag status`, `/pi-tag generate`.
 *
 * The heavy lifting lives in the modules the CI job runs — `cli.ts` is the same
 * entry point in both places, so a local run and a workflow run cannot drift.
 * This file is the thin part: read a subcommand, show the result, and write the
 * one file (`generate`) that a person would otherwise hand-edit.
 *
 * Note the deliberate absence of a `submit_labels` tool. Validation happens once,
 * in `proposal.ts`, after the model has answered; the model gets no chance to
 * retry inside its own run. That is why a refusal has to be legible in the
 * comment — it is the only feedback channel there is.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateWorkflow } from "./workflow.ts";
import { SETTINGS_PATH, WORKFLOW_PATH, readSettings } from "./settings.ts";
import { MANIFEST_PATH, readManifest } from "./manifest.ts";

const COMMAND_NAME = "pi-tag";
const SUBCOMMANDS = ["run", "status", "generate", "help"];
const SELF_DIR = dirname(fileURLToPath(import.meta.url));

function helpText(): string {
	return [
		"pi-tag — read the tree, check the evidence, tag the issue",
		"",
		"/pi-tag run [--issue N] [--apply] [--fix <note>]   tag an issue (dry run unless --apply)",
		"/pi-tag status                                     what this repo would use",
		"/pi-tag generate                                   write the workflow from the settings",
		"",
		`Settings: ${SETTINGS_PATH} · Vocabulary: ${MANIFEST_PATH}`,
	].join("\n");
}

type Ctx = Pick<ExtensionCommandContext, "cwd" | "ui">;

async function show(ctx: Ctx, text: string): Promise<void> {
	await ctx.ui.editor("pi-tag", text);
}

function statusText(cwd: string): string {
	const lines: string[] = [];
	let settings;
	try {
		settings = readSettings(resolve(cwd, SETTINGS_PATH));
		lines.push(`${SETTINGS_PATH}: ${settings.identity} identity · ${settings.provider}/${settings.model}`);
		lines.push(`  thinking ${settings.thinking} · timeout ${settings.timeoutMinutes}m · remove ${settings.labels.remove}`);
		lines.push(`  triggers ${settings.triggers.mention} · ${settings.triggers.fix} · who ${settings.triggers.who.join(", ")}`);
	} catch (error) {
		lines.push(`${SETTINGS_PATH}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
	}

	try {
		const manifest = readManifest(resolve(cwd, MANIFEST_PATH));
		const auto = manifest.labels.filter((label) => manifest.policy.auto_groups.includes(label.group));
		lines.push(`${MANIFEST_PATH}: ${manifest.labels.length} labels, ${auto.length} assignable by a machine`);
		lines.push(`  auto groups: ${manifest.policy.auto_groups.join(", ")}`);
	} catch (error) {
		lines.push(`${MANIFEST_PATH}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
	}

	const workflowFile = resolve(cwd, WORKFLOW_PATH);
	if (existsSync(workflowFile)) {
		lines.push(`${WORKFLOW_PATH}: present`);
	} else {
		lines.push(`${WORKFLOW_PATH}: missing — run /pi-tag generate`);
	}
	return lines.join("\n");
}

/** Write the workflow, and say whether it changed. Never touches anything else. */
export function generateInto(cwd: string, options: { source?: string; ref?: string; botLogin?: string } = {}): {
	path: string;
	changed: boolean;
} {
	const settings = readSettings(resolve(cwd, SETTINGS_PATH));
	const target = resolve(cwd, WORKFLOW_PATH);
	const body = generateWorkflow({ settings, ...options });
	const before = existsSync(target) ? readFileSync(target, "utf8") : undefined;
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, body);
	return { path: target, changed: before !== body };
}

/** Run the same CLI the workflow runs, streaming its output. */
function runCli(args: string[], cwd: string, onData: (chunk: string) => void): Promise<number> {
	return new Promise((resolvePromise) => {
		const child = spawn(process.execPath, [join(SELF_DIR, "cli.ts"), ...args], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env },
		});
		child.stdout?.on("data", (chunk: Buffer) => onData(chunk.toString()));
		child.stderr?.on("data", (chunk: Buffer) => onData(chunk.toString()));
		child.on("close", (code) => resolvePromise(code ?? 1));
		child.on("error", () => resolvePromise(1));
	});
}

export default function piTag(pi: ExtensionAPI): void {
	pi.registerCommand(COMMAND_NAME, {
		description: "Tag an issue from the tree and the label manifest (dry run by default)",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const matches = SUBCOMMANDS.filter((name) => name.startsWith(prefix));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const [subcommand = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			try {
				switch (subcommand) {
					case "":
					case "help":
						await show(ctx, helpText());
						return;

					case "status":
						await show(ctx, statusText(ctx.cwd));
						return;

					case "generate": {
						const result = generateInto(ctx.cwd);
						ctx.ui.notify(
							`pi-tag: ${WORKFLOW_PATH} ${result.changed ? "written" : "already up to date"}`,
							"info"
						);
						return;
					}

					case "run": {
						// No --apply unless asked for: the default must stay the safe one.
						const argv = rest.length > 0 ? rest : [];
						let output = "";
						const code = await runCli(argv, ctx.cwd, (chunk) => {
							output += chunk;
						});
						await show(ctx, output.trim() || "pi-tag: no output");
						if (code !== 0) ctx.ui.notify(`pi-tag: the run exited ${code}`, "error");
						return;
					}

					default:
						ctx.ui.notify(`pi-tag: unknown subcommand "${subcommand}" (try /pi-tag help)`, "error");
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`pi-tag: ${message}`, "error");
			}
		},
	});
}
