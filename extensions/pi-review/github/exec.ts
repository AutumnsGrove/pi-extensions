/**
 * Command execution for the installer.
 *
 * `pi.exec` cannot write to a child's stdin, and `gh secret set` only reads a
 * value from stdin or from argv. A private key must never sit in argv (visible
 * in the process list), so the installer gets its own runner that can feed
 * stdin. Everything else keeps using `pi.exec`.
 */

import { spawn } from "node:child_process";

export interface CommandResult {
	stdout: string;
	stderr: string;
	code: number;
}

export interface CommandOptions {
	cwd: string;
	/** Written to the child's stdin, then closed. */
	stdin?: string;
	timeoutMs?: number;
}

export type CommandRunner = (
	command: string,
	args: string[],
	options: CommandOptions
) => Promise<CommandResult>;

const DEFAULT_TIMEOUT_MS = 60_000;
const OUTPUT_CAP = 1024 * 1024;

/** Spawn a command, optionally writing `stdin`, and capture its output. */
export const spawnRunner: CommandRunner = (command, args, options) => {
	return new Promise<CommandResult>((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (code: number): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve({
				stdout: stdout.length > OUTPUT_CAP ? stdout.slice(-OUTPUT_CAP) : stdout,
				stderr: stderr.length > OUTPUT_CAP ? stderr.slice(-OUTPUT_CAP) : stderr,
				code,
			});
		};

		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, args, {
				cwd: options.cwd,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (error) {
			resolve({ stdout: "", stderr: error instanceof Error ? error.message : String(error), code: 127 });
			return;
		}

		timer = setTimeout(() => {
			child.kill("SIGTERM");
			stderr += `\n[timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms]`;
		}, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (error) => {
			stderr += error.message;
			finish(127);
		});
		child.on("close", (code) => finish(code ?? 0));
		child.stdin?.on("error", () => {
			// A command that does not read stdin may close it early.
		});
		child.stdin?.end(options.stdin ?? "");
	});
};
