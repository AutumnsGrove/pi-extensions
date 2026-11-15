/**
 * The pieces the dry run and the runner both need: run a command, read an
 * issue, and read the checkout's manifest.
 *
 * Everything goes through the injected `Exec` so tests never touch a real `gh`
 * or a real checkout, and so the CI run and the local run take one code path.
 * Nothing here writes anything.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { EvidenceContext } from "./evidence.ts";
import { treeAt } from "./evidence.ts";
import { MANIFEST_PATH, type Manifest, readManifest } from "./manifest.ts";

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
}

export type Exec = (
	command: string,
	args: string[],
	options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }
) => Promise<ExecResult>;

/** The real one. Never rejects: a non-zero exit is data, not an exception. */
export const nodeExec: Exec = (command, args, options = {}) =>
	new Promise((resolve) => {
		execFile(
			command,
			args,
			{
				cwd: options.cwd,
				timeout: options.timeoutMs ?? 60_000,
				maxBuffer: 32 * 1024 * 1024,
				env: { ...process.env, ...options.env },
			},
			(error, stdout, stderr) => {
				const code =
					typeof (error as { code?: unknown } | null)?.code === "number"
						? ((error as { code: number }).code ?? 1)
						: error
							? 1
							: 0;
				resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
			}
		);
	});

export class GhError extends Error {
	// Explicit field, not a parameter property: this module runs under node's
	// strip-only TypeScript, which cannot compile them.
	readonly stderr: string;

	constructor(message: string, stderr: string) {
		super(message);
		this.name = "GhError";
		this.stderr = stderr;
	}
}

export interface Issue {
	number: number;
	title: string;
	body: string;
	labels: string[];
	state: "OPEN" | "CLOSED" | "UNKNOWN";
	url?: string;
	author?: string;
}

interface GhIssue {
	number?: unknown;
	title?: unknown;
	body?: unknown;
	state?: unknown;
	url?: unknown;
	author?: { login?: unknown };
	labels?: { name?: unknown }[];
}

/** One `gh issue view`. The body is the one stored, not an event echo. */
export async function readIssue(exec: Exec, cwd: string, number: number): Promise<Issue> {
	const result = await exec(
		"gh",
		["issue", "view", String(number), "--json", "number,title,body,labels,state,url,author"],
		{ cwd, timeoutMs: 30_000 }
	);
	if (result.code !== 0) {
		throw new GhError(`gh issue view ${number} failed (exit ${result.code})`, result.stderr.trim());
	}
	let parsed: GhIssue;
	try {
		parsed = JSON.parse(result.stdout) as GhIssue;
	} catch {
		throw new GhError(`gh issue view ${number} did not return JSON`, result.stdout.slice(0, 200));
	}
	const state = typeof parsed.state === "string" ? parsed.state.toUpperCase() : "UNKNOWN";
	return {
		number: typeof parsed.number === "number" ? parsed.number : number,
		title: typeof parsed.title === "string" ? parsed.title : "",
		body: typeof parsed.body === "string" ? parsed.body : "",
		labels: Array.isArray(parsed.labels)
			? parsed.labels.map((label) => (typeof label?.name === "string" ? label.name : "")).filter(Boolean)
			: [],
		state: state === "OPEN" || state === "CLOSED" ? state : "UNKNOWN",
		url: typeof parsed.url === "string" ? parsed.url : undefined,
		author: typeof parsed.author?.login === "string" ? parsed.author.login : undefined,
	};
}

export interface Checkout {
	root: string;
	manifest: Manifest;
	evidence: EvidenceContext;
}

/** The target repository's vocabulary and tree, as one object. */
export function readCheckout(root: string): Checkout {
	const manifestPath = join(root, MANIFEST_PATH);
	if (!existsSync(manifestPath)) {
		throw new Error(`no ${MANIFEST_PATH} in ${root} — pi-tag has no vocabulary to work from`);
	}
	return { root, manifest: readManifest(manifestPath), evidence: { title: "", exists: treeAt(root) } };
}

/** Evidence for one issue: the tree plus that issue's title. */
export function evidenceFor(checkout: Checkout, title: string): EvidenceContext {
	return { title, exists: checkout.evidence.exists };
}
