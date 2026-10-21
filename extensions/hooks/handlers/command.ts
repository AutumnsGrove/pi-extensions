/**
 * `command` hooks: run a process, feed it the event JSON on stdin, and read a
 * Claude-compatible result from its exit code and stdout.
 *
 * Exit 0 succeeds and may print a JSON object. Exit 2 is a blocking error and
 * stderr is the reason. Any other exit is a non-blocking error unless the hook
 * sets `onFailure: "block"`.
 */

import { spawn } from "node:child_process";
import type { HookEventName, HookHandlerConfig, HookInput, HookOutput, NormalizedHook } from "../types.ts";
import { normalizeOutput } from "../input.ts";

const MAX_OUTPUT = 1024 * 1024;

export interface ProcessResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	spawnError?: string;
	durationMs: number;
}

export interface CommandHookResult {
	output: HookOutput | null;
	error?: string;
	blocked: boolean;
	durationMs: number;
}

export function hookEnv(input: HookInput, transcriptPath: string | null): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	const projectDir = input.cwd;
	// Claude-compatible names first, then pi-specific ones.
	env.CLAUDE_PROJECT_DIR = projectDir;
	env.CLAUDE_HOOK_EVENT = input.hook_event_name;
	env.PI_PROJECT_DIR = projectDir;
	env.PI_CWD = projectDir;
	env.PI_HOOK_EVENT = input.hook_event_name;
	if (input.session_id) env.PI_SESSION_ID = input.session_id;
	if (transcriptPath) env.PI_TRANSCRIPT_PATH = transcriptPath;
	return env;
}

export async function runProcess(
	command: string,
	args: string[] | undefined,
	input: HookInput,
	options: {
		cwd: string;
		shell?: "bash" | "powershell";
		timeoutMs: number;
		signal?: AbortSignal;
	},
): Promise<ProcessResult> {
	const started = Date.now();
	const useShell = args === undefined;
	const child = useShell
		? spawn(command, {
				cwd: options.cwd,
				env: hookEnv(input, input.transcript_path as string | null),
				shell: options.shell === "powershell" ? "powershell" : true,
				stdio: ["pipe", "pipe", "pipe"],
			})
		: spawn(command, args, {
				cwd: options.cwd,
				env: hookEnv(input, input.transcript_path as string | null),
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
			});

	let stdout = "";
	let stderr = "";
	let timedOut = false;
	let spawnError: string | undefined;

	const append = (current: string, chunk: Buffer): string => {
		if (current.length >= MAX_OUTPUT) return current;
		const next = current + chunk.toString("utf8");
		return next.length > MAX_OUTPUT ? next.slice(0, MAX_OUTPUT) : next;
	};

	child.stdout?.on("data", (chunk: Buffer) => {
		stdout = append(stdout, chunk);
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr = append(stderr, chunk);
	});

	const kill = (): void => {
		if (!child.killed) {
			child.kill("SIGKILL");
		}
	};

	const timer = setTimeout(() => {
		timedOut = true;
		kill();
	}, Math.max(1, options.timeoutMs));
	if (timer.unref) timer.unref();

	const onAbort = (): void => kill();
	options.signal?.addEventListener("abort", onAbort, { once: true });

	child.on("error", (error) => {
		spawnError = error.message;
	});

	// The hook may not read stdin; an EPIPE must not become an unhandled error.
	child.stdin?.on("error", () => undefined);
	try {
		child.stdin?.end(`${JSON.stringify(input)}\n`);
	} catch {
		// The process may have exited before reading.
	}

	const exitCode = await new Promise<number | null>((resolve) => {
		child.on("close", (code) => resolve(code));
		child.on("error", () => resolve(null));
	});

	clearTimeout(timer);
	options.signal?.removeEventListener("abort", onAbort);

	return {
		exitCode,
		stdout,
		stderr,
		timedOut,
		spawnError,
		durationMs: Date.now() - started,
	};
}

/** Events where exit code 2 reports back to the model instead of blocking. */
function isPostEvent(event: HookEventName): boolean {
	return (
		event === "PostToolUse" ||
		event === "PostToolUseFailure" ||
		event === "Stop" ||
		event === "AgentSettled" ||
		event === "SessionEnd" ||
		event === "SessionCompactFailed" ||
		event === "PostCompact"
	);
}

export function interpretProcessResult(
	hook: NormalizedHook,
	result: ProcessResult,
): CommandHookResult {
	const handler = hook.handler as Extract<HookHandlerConfig, { type: "command" }>;

	if (result.timedOut) {
		const error = `hook timed out after ${Math.round((handler.timeout ?? 600) * 1000)}ms`;
		return {
			output: null,
			error,
			blocked: handler.onFailure === "block",
			durationMs: result.durationMs,
		};
	}
	if (result.spawnError) {
		return {
			output: null,
			error: result.spawnError,
			blocked: handler.onFailure === "block",
			durationMs: result.durationMs,
		};
	}

	const stdout = result.stdout.trim();
	let parsed: unknown;
	let parseError: string | undefined;
	if (stdout.startsWith("{")) {
		try {
			parsed = JSON.parse(stdout);
		} catch (error) {
			parseError = `invalid JSON on stdout: ${(error as Error).message}`;
		}
	}

	if (result.exitCode === 0) {
		if (parseError) {
			return {
				output: null,
				error: parseError,
				blocked: handler.onFailure === "block",
				durationMs: result.durationMs,
			};
		}
		return {
			output: normalizeOutput(parsed),
			blocked: false,
			durationMs: result.durationMs,
		};
	}

	if (result.exitCode === 2) {
		const reason = result.stderr.trim() || "Blocked by hook";
		if (isPostEvent(hook.event)) {
			return {
				output: { additionalContext: reason },
				blocked: false,
				durationMs: result.durationMs,
			};
		}
		// A JSON object cannot override an exit-2 block, matching Claude.
		return {
			output: { decision: "deny", reason },
			blocked: true,
			durationMs: result.durationMs,
		};
	}

	const message =
		result.stderr.trim() ||
		result.spawnError ||
		`hook exited with ${result.exitCode ?? "no status"}`;
	return {
		output: null,
		error: message,
		blocked: handler.onFailure === "block",
		durationMs: result.durationMs,
	};
}
