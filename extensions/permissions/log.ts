/**
 * Decision log.
 *
 * Two records are written per decision: a compact `pi.appendEntry()` in the
 * session (for `/tree` and replay) and a redacted JSONL line under
 * `.pi/permissions/decisions.jsonl` (for the JEV-vs-LLM benchmark).
 *
 * Redaction is deliberately aggressive. Turn on `log.fullState` only for a
 * throwaway project: tool inputs can contain file contents and credentials.
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { DecisionRecord } from "./types.ts";

const SECRET_PATTERNS: Array<[RegExp, string]> = [
	[/sk-[A-Za-z0-9_-]{16,}/g, "sk-***"],
	[/ghp_[A-Za-z0-9]{20,}/g, "ghp_***"],
	[/github_pat_[A-Za-z0-9_]{20,}/g, "github_pat_***"],
	[/xox[baprs]-[A-Za-z0-9-]{10,}/g, "xox-***"],
	[/AKIA[0-9A-Z]{16}/g, "AKIA***"],
	[/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, "$1***$2"],
	[/(Bearer\s+)[A-Za-z0-9._-]{10,}/gi, "$1***"],
	[
		/((?:password|passwd|secret|token|api[_-]?key|authorization)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
		"$1***",
	],
];

export function redactString(value: string, max = 4000): string {
	let out = value.length > max ? `${value.slice(0, max)}…` : value;
	for (const [pattern, replacement] of SECRET_PATTERNS) {
		out = out.replace(pattern, replacement);
	}
	return out;
}

const SECRET_KEY = /(password|passwd|secret|token|api[_-]?key|authorization|credential)/i;

export function redactValue(value: unknown, depth = 0): unknown {
	if (depth > 4) return "[depth]";
	if (typeof value === "string") return redactString(value);
	if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
	if (Array.isArray(value)) return value.slice(0, 20).map((entry) => redactValue(entry, depth + 1));
	if (typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
			out[key] = SECRET_KEY.test(key) ? "***" : redactValue(entry, depth + 1);
		}
		return out;
	}
	return String(value);
}

export function redactRecord(record: DecisionRecord, fullState: boolean): DecisionRecord {
	if (fullState) return record;
	return {
		...record,
		cwd: record.cwd,
		input: redactValue(record.input) as Record<string, unknown>,
		reviewer: record.reviewer
			? { ...record.reviewer, reasons: record.reviewer.reasons.map((r) => redactString(r, 500)) }
			: undefined,
	};
}

export function decisionsPath(cwd: string): string {
	return join(cwd, ".pi", "permissions", "decisions.jsonl");
}

/** Best-effort: logging must never make a permission decision fail. */
export async function appendDecision(
	ctx: ExtensionContext,
	record: DecisionRecord,
	fullState: boolean,
): Promise<void> {
	const dir = join(ctx.cwd, ".pi", "permissions");
	await mkdir(dir, { recursive: true });
	const ignore = join(dir, ".gitignore");
	if (!existsSync(ignore)) {
		await writeFile(ignore, "*\n", "utf8").catch(() => undefined);
	}
	const line = JSON.stringify(redactRecord(record, fullState));
	await appendFile(join(dir, "decisions.jsonl"), `${line}\n`, "utf8");
}

export async function readDecisions(cwd: string, limit = 10): Promise<DecisionRecord[]> {
	try {
		const text = await readFile(decisionsPath(cwd), "utf8");
		const lines = text.trim().split("\n").filter(Boolean);
		return lines.slice(-limit).map((line) => JSON.parse(line) as DecisionRecord);
	} catch {
		return [];
	}
}

export function formatRecord(record: DecisionRecord): string {
	const stamp = record.ts.replace("T", " ").slice(0, 19);
	const rule = record.rule?.matched.length ? ` rule=${record.rule.matched[0]}` : "";
	const reviewer = record.reviewer
		? ` reviewer=${record.reviewer.provider}/${record.reviewer.confidence.toFixed(2)}`
		: "";
	const cached = record.cached ? " cached" : "";
	const subject = summarizeInput(record.tool, record.input);
	return `${stamp} ${record.decision.toUpperCase()} ${record.tool} ${subject} [${record.source}${rule}${reviewer}${cached}]`;
}

function summarizeInput(tool: string, input: Record<string, unknown>): string {
	if (tool === "bash" || tool === "powershell") {
		return redactString(String(input.command ?? ""), 120);
	}
	const subject =
		typeof input.file_path === "string"
			? input.file_path
			: typeof input.path === "string"
				? input.path
				: typeof input.pattern === "string"
					? input.pattern
					: "";
	return redactString(subject || JSON.stringify(input), 120);
}
