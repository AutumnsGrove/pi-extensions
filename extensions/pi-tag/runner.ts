/**
 * The headless pi invocation.
 *
 * Same isolation as pi-review's reviewer: no session, no project trust, no
 * context files, no extensions, no skills, no prompt templates, no MCP, no
 * themes, offline startup. The tool allowlist is read-only and there is no
 * `bash` — a tagger has nothing to execute, and a shell plus an untrusted issue
 * body plus a token in the environment is surface for nothing.
 *
 * The system prompt is ~4 KB and goes on the command line; the context message
 * can be tens of KB and also goes on the command line, well under ARG_MAX. That
 * keeps the local dry run and the CI run byte-identical, which is the point.
 */

import type { Exec } from "./github.ts";
import { nodeExec } from "./github.ts";

export interface PiRunOptions {
	cwd: string;
	system: string;
	context: string;
	provider: string;
	model: string;
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	timeoutMs?: number;
	piBinary?: string;
	exec?: Exec;
	env?: Record<string, string>;
}

export interface PiRun {
	ok: boolean;
	output: string;
	error?: string;
	code: number;
}

/** Read-only, and nothing that can execute anything. */
export const READ_ONLY_TOOLS = "read,grep,find,ls";

export function piArgs(options: PiRunOptions): string[] {
	return [
		"--print",
		"--no-session",
		"--no-approve",
		"--no-context-files",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-mcp",
		"--offline",
		"--tools",
		READ_ONLY_TOOLS,
		"--provider",
		options.provider,
		"--model",
		options.model,
		"--thinking",
		options.thinking ?? "medium",
		"--append-system-prompt",
		options.system,
		options.context,
	];
}

export async function runPi(options: PiRunOptions): Promise<PiRun> {
	const exec = options.exec ?? nodeExec;
	const result = await exec(options.piBinary ?? "pi", piArgs(options), {
		cwd: options.cwd,
		timeoutMs: options.timeoutMs ?? 300_000,
		env: options.env,
	});
	const output = result.stdout.trim();
	if (result.code !== 0) {
		const seconds = Math.round((options.timeoutMs ?? 300_000) / 1000);
		return {
			ok: false,
			output,
			code: result.code,
			error: result.timedOut
				? `pi was still working after ${seconds}s`
				: result.stderr.trim() || `pi exited ${result.code}`,
		};
	}
	return { ok: true, output, code: 0 };
}
