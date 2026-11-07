/**
 * Local dry run: spawn a headless `pi` with the same extension, tools, and
 * prompt the CI workflow uses, and bring the result back into the session.
 *
 * `/pi-review run` is the manual test loop for the workflow. It parses the
 * child's JSON event stream for progress, reads the `submit_review` artifact
 * the child writes, and never posts unless `--post` is given.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ValidatedReview } from "./review.ts";

const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const OUTPUT_CAP = 4 * 1024 * 1024;

export interface HeadlessRunOptions {
	cwd: string;
	/** Path to this extension's `index.ts`. */
	extensionPath: string;
	prompt: string;
	model?: string;
	thinking?: string;
	tools: string[];
	/** Validate and print instead of posting. */
	dryRun: boolean;
	/** Allow REQUEST_CHANGES as the review event. */
	requestChanges?: boolean;
	/** Extra environment; merged over the current process env. */
	env?: Record<string, string | undefined>;
	timeoutMs?: number;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
}

export interface HeadlessRunResult {
	code: number;
	timedOut: boolean;
	aborted: boolean;
	stdout: string;
	stderr: string;
	/** Last assistant text, if any. */
	text: string;
	toolCalls: string[];
	review?: ValidatedReview;
	markdown?: string;
	url?: string;
}

export interface RunArgs {
	post: boolean;
	prNumber?: number;
	baseRef?: string;
	model?: string;
	thinking?: string;
	bash: boolean;
}

/** Parse `/pi-review run` arguments. Throws on an unknown flag. */
export function parseRunArgs(argv: string[]): RunArgs {
	const args: RunArgs = { post: false, bash: false };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]!;
		const next = (): string => {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("--")) {
				throw new Error(`${arg} needs a value`);
			}
			index += 1;
			return value;
		};
		switch (arg) {
			case "--post":
				args.post = true;
				break;
			case "--dry-run":
				args.post = false;
				break;
			case "--pr": {
				const value = Number(next());
				if (!Number.isInteger(value) || value < 1) throw new Error("--pr needs a pull request number");
				args.prNumber = value;
				break;
			}
			case "--base":
				args.baseRef = next();
				break;
			case "--model":
				args.model = next();
				break;
			case "--thinking":
				args.thinking = next();
				break;
			case "--bash":
				args.bash = true;
				break;
			default:
				throw new Error(`Unknown option: ${arg}`);
		}
	}
	return args;
}

/**
 * Target variables the child must receive. Without these the child re-detects
 * from git and reviews the local branch even when `--pr`/`--base` were given,
 * and `--post` fails after the review has already run.
 */
export function reviewChildEnv(options: {
	prNumber?: number | undefined;
	baseRef?: string | undefined;
}): Record<string, string> {
	const env: Record<string, string> = {};
	if (options.prNumber !== undefined) env.PR_NUMBER = String(options.prNumber);
	if (options.baseRef) env.PI_REVIEW_BASE_REF = options.baseRef;
	return env;
}

/** Tools the review agent gets. `bash` is opt-in because it can read the env. */
export function reviewTools(includeBash: boolean, resolveThreads = false): string[] {
	const tools = ["read", "grep", "find", "ls", "submit_review"];
	if (includeBash) tools.splice(4, 0, "bash");
	if (resolveThreads) tools.push("resolve_review_threads");
	return tools;
}

/** Prefer the running pi binary/script so the child matches the parent. */
export function piInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const bunVirtual = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !bunVirtual && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

/** The exact isolation flags the CI workflow uses. */
export function buildPiArgs(options: HeadlessRunOptions): string[] {
	const args = [
		"-p",
		"--mode",
		"json",
		"--no-session",
		"-na",
		"-nc",
		"--offline",
		"-ne",
		"-e",
		options.extensionPath,
		"-ns",
		"-np",
		"--no-themes",
		"--no-mcp",
		"--tools",
		options.tools.join(","),
	];
	if (options.model) args.push("--model", options.model);
	if (options.thinking) args.push("--thinking", options.thinking);
	args.push(options.prompt);
	return args;
}

function appendCapped(current: string, chunk: string): string {
	const next = current + chunk;
	return next.length > OUTPUT_CAP ? next.slice(next.length - OUTPUT_CAP) : next;
}

export interface RunSummary {
	text: string;
	toolCalls: string[];
}

/** Reconstruct the last assistant text and the tool call order from JSONL. */
export function summarizeEvents(stdout: string): RunSummary {
	const toolCalls: string[] = [];
	let text = "";
	for (const line of stdout.split("\n")) {
		if (!line.startsWith("{")) continue;
		let event: {
			type?: string;
			toolName?: string;
			message?: { role?: string; content?: unknown };
		};
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event.type === "tool_execution_start" && typeof event.toolName === "string") {
			toolCalls.push(event.toolName);
		}
		if (event.type === "message_end" && event.message?.role === "assistant") {
			const content = event.message.content;
			if (!Array.isArray(content)) continue;
			const joined = content
				.filter((part): part is { type: string; text: string } => {
					return (
						typeof part === "object" &&
						part !== null &&
						(part as { type?: unknown }).type === "text" &&
						typeof (part as { text?: unknown }).text === "string"
					);
				})
				.map((part) => part.text)
				.join("\n")
				.trim();
			if (joined) text = joined;
		}
	}
	return { text, toolCalls };
}

export interface ReviewArtifact {
	dryRun: boolean;
	review: ValidatedReview;
	url?: string;
	markdown?: string;
}

/** Read the artifact `submit_review` wrote, ignoring anything malformed. */
export async function readReviewArtifact(path: string | undefined): Promise<ReviewArtifact | undefined> {
	if (!path) return undefined;
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<ReviewArtifact>;
		if (!parsed.review || typeof parsed.review.summary !== "string") return undefined;
		if (!Array.isArray(parsed.review.comments)) return undefined;
		return {
			dryRun: parsed.dryRun !== false,
			review: parsed.review,
			...(parsed.url ? { url: parsed.url } : {}),
			...(parsed.markdown ? { markdown: parsed.markdown } : {}),
		};
	} catch {
		return undefined;
	}
}

/** Create the temp artifact path used to move the review out of the child. */
export async function createArtifactPath(): Promise<{ dir: string; path: string }> {
	const dir = await mkdtemp(join(tmpdir(), "pi-review-run-"));
	return { dir, path: join(dir, "review.json") };
}

export async function removeArtifact(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true });
}

export function reviewPromptFor(options: {
	number?: number;
	repo?: { owner: string; repo: string };
	baseRef?: string;
}): string {
	if (options.number) {
		const where = options.repo ? ` in ${options.repo.owner}/${options.repo.repo}` : "";
		return `Review pull request #${options.number}${where}.`;
	}
	return `Review the current branch against ${options.baseRef ?? "its base branch"}.`;
}

/**
 * Run the review in a child pi. Resolves with the parsed result; it only
 * rejects if the process could not be spawned at all.
 */
export async function runHeadlessReview(
	options: HeadlessRunOptions & { outputPath: string }
): Promise<HeadlessRunResult> {
	const args = buildPiArgs(options);
	const invocation = piInvocation(args);
	const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, PI_REVIEW: "1" };
	// Never let the parent's "post" configuration leak into a dry run.
	env.PI_REVIEW_OUTPUT = options.outputPath;
	env.PI_REVIEW_DRY_RUN = options.dryRun ? "1" : "0";
	env.PI_REVIEW_REQUEST_CHANGES = options.requestChanges ? "1" : "0";
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	return await new Promise<HeadlessRunResult>((resolve, reject) => {
		const child = spawn(invocation.command, invocation.args, {
			cwd: options.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env,
		});

		let stdout = "";
		let stderr = "";
		let lineBuffer = "";
		let timedOut = false;
		let aborted = false;
		let toolCalls = 0;

		const timer =
			timeoutMs > 0
				? setTimeout(() => {
						timedOut = true;
						child.kill("SIGTERM");
					}, timeoutMs)
				: undefined;

		const onAbort = (): void => {
			aborted = true;
			child.kill("SIGTERM");
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });

		const handleLine = (line: string): void => {
			if (!line.startsWith("{")) return;
			let event: { type?: string; toolName?: string };
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event.type === "tool_execution_start" && event.toolName) {
				toolCalls += 1;
				options.onProgress?.(`${event.toolName} · ${toolCalls} tool call${toolCalls === 1 ? "" : "s"}`);
			} else if (event.type === "turn_start") {
				options.onProgress?.(`thinking · ${toolCalls} tool call${toolCalls === 1 ? "" : "s"}`);
			}
		};

		child.stdout!.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			stdout = appendCapped(stdout, text);
			lineBuffer += text;
			const lines = lineBuffer.split("\n");
			lineBuffer = lines.pop() ?? "";
			for (const line of lines) handleLine(line);
		});
		child.stderr!.on("data", (chunk: Buffer) => {
			stderr = appendCapped(stderr, chunk.toString("utf8"));
		});

		child.on("error", (error) => {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			reject(error);
		});

		child.on("close", async (code) => {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			const summary = summarizeEvents(stdout);
			const artifact = await readReviewArtifact(options.outputPath);
			resolve({
				code: code ?? 0,
				timedOut,
				aborted,
				stdout,
				stderr,
				text: summary.text,
				toolCalls: summary.toolCalls,
				...(artifact ? { review: artifact.review } : {}),
				...(artifact?.markdown ? { markdown: artifact.markdown } : {}),
				...(artifact?.url ? { url: artifact.url } : {}),
			});
		});
	});
}

/** Convenience for the command: run, clean up, and return the result. */
export async function runLocalReview(
	options: Omit<HeadlessRunOptions, "extensionPath" | "outputPath"> & { extensionPath: string }
): Promise<HeadlessRunResult> {
	const { dir, path } = await createArtifactPath();
	try {
		return await runHeadlessReview({ ...options, outputPath: path });
	} finally {
		await removeArtifact(dir);
	}
}
