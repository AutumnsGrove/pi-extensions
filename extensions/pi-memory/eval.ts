/**
 * Eval harness for the parts that are cheap to measure.
 *
 * `/memory eval` replays the project's saved sessions through recall and
 * reports the real token overhead, how often recall fires, and which memories
 * keep coming back. With `--extract` it also runs the extraction prompt on a
 * few sessions and reports what would have been saved, what the validator
 * rejected, and why — without writing anything.
 *
 * The point is to keep the three hard numbers visible: per-turn recall cost,
 * extraction cadence/cost, and the false-save reasons.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { collectSlice, type SliceEntry } from "./extract.ts";
import { selectRecall } from "./recall.ts";
import type { MemoryFile, MemoryLimits } from "./types.ts";

export interface SessionFile {
	path: string;
	entries: SliceEntry[];
}

/** Parse a session JSONL. Bad lines are skipped; a corrupt file yields nothing. */
export function parseSessionJsonl(text: string): SliceEntry[] {
	const entries: SliceEntry[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		let value: unknown;
		try {
			value = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const record = value as Record<string, unknown>;
		if (record.type !== "message" && record.type !== "custom_message") continue;
		if (typeof record.id !== "string") continue;
		const message = record.message;
		entries.push({
			id: record.id,
			type: record.type as string,
			customType: typeof record.customType === "string" ? record.customType : undefined,
			content: record.content,
			message:
				message && typeof message === "object"
					? (message as { role?: string; content?: unknown })
					: undefined,
		});
	}
	return entries;
}

/** Recent session files for a project, newest first. */
export function readSessionFiles(dir: string, limit: number): SessionFile[] {
	let names: string[];
	try {
		names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
	} catch {
		return [];
	}
	const files = names
		.map((name) => {
			const path = join(dir, name);
			try {
				return { path, mtimeMs: statSync(path).mtimeMs };
			} catch {
				return undefined;
			}
		})
		.filter((entry): entry is { path: string; mtimeMs: number } => entry !== undefined)
		.sort((a, b) => b.mtimeMs - a.mtimeMs)
		.slice(0, Math.max(0, limit));
	const sessions: SessionFile[] = [];
	for (const file of files) {
		try {
			sessions.push({ path: file.path, entries: parseSessionJsonl(readFileSync(file.path, "utf8")) });
		} catch {
			// An unreadable session is not worth failing an eval over.
		}
	}
	return sessions;
}

export interface RecallEval {
	sessions: number;
	turns: number;
	injectedTurns: number;
	bytes: number[];
	/** File → number of user turns that surfaced it. */
	files: Map<string, number>;
	/** Turns with no memory matched, the desired common case. */
	emptyTurns: number;
}

export interface RecallEvalOptions {
	limits: MemoryLimits;
	now?: number;
}

export function evaluateRecall(
	sessions: readonly SessionFile[],
	memories: readonly MemoryFile[],
	options: RecallEvalOptions
): RecallEval {
	const now = options.now ?? Date.now();
	const bytes: number[] = [];
	const files = new Map<string, number>();
	let turns = 0;
	let injectedTurns = 0;
	let emptyTurns = 0;
	for (const session of sessions) {
		const surfaced = new Set<string>();
		for (const entry of session.entries) {
			if (entry.type !== "message" || entry.message?.role !== "user") continue;
			const text = textOf(entry.message.content).trim();
			if (text.length < 3) continue;
			turns++;
			const selection = selectRecall(
				memories,
				text,
				{
					maxFiles: options.limits.maxRecallFiles,
					maxBytes: options.limits.maxRecallBytes,
					maxBodyBytes: options.limits.maxRecallBodyBytes,
					maxBodyLines: options.limits.maxRecallBodyLines,
				},
				surfaced,
				now
			);
			if (selection.selected.length === 0) {
				emptyTurns++;
				continue;
			}
			injectedTurns++;
			bytes.push(selection.bytes);
			for (const memory of selection.selected) {
				surfaced.add(memory.file);
				files.set(memory.file, (files.get(memory.file) ?? 0) + 1);
			}
		}
	}
	return { sessions: sessions.length, turns, injectedTurns, bytes, files, emptyTurns };
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			const typed = block as { type?: unknown; text?: unknown };
			return typed.type === "text" && typeof typed.text === "string" ? typed.text : "";
		})
		.join("\n");
}

/** Nearest-rank percentile; 0 for an empty list. */
export function percentile(values: readonly number[], fraction: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
	return sorted[rank] ?? 0;
}

/** Four bytes per token is the usual rough conversion, and enough for a budget. */
export function approxTokens(bytes: number): number {
	return Math.round(bytes / 4);
}

export interface ExtractionEvalSample {
	session: string;
	proposed: number;
	accepted: number;
	rejected: Array<{ name: string; reason: string }>;
	writes: Array<{ name: string; type: string; description: string }>;
}

export interface ExtractionEval {
	sessions: number;
	proposed: number;
	accepted: number;
	rejectedReasons: Map<string, number>;
	samples: ExtractionEvalSample[];
}

export function emptyExtractionEval(): ExtractionEval {
	return { sessions: 0, proposed: 0, accepted: 0, rejectedReasons: new Map(), samples: [] };
}

export function addExtractionSample(
	evaluation: ExtractionEval,
	sample: ExtractionEvalSample
): void {
	evaluation.sessions++;
	evaluation.proposed += sample.proposed;
	evaluation.accepted += sample.accepted;
	for (const rejection of sample.rejected) {
		evaluation.rejectedReasons.set(
			rejection.reason,
			(evaluation.rejectedReasons.get(rejection.reason) ?? 0) + 1
		);
	}
	evaluation.samples.push(sample);
}

/** The conversation a session-level extraction would have seen. */
export function sessionSlice(
	session: SessionFile,
	options: { maxMessages: number; maxChars: number }
): ReturnType<typeof collectSlice> {
	return collectSlice(session.entries, undefined, options);
}

export interface ReportOptions {
	recall: RecallEval;
	extraction?: ExtractionEval;
	storeDir: string;
	memories: number;
	indexLines: number;
	now?: Date;
}

export function formatEvalReport(options: ReportOptions): string {
	const { recall } = options;
	const rate = recall.turns > 0 ? Math.round((recall.injectedTurns / recall.turns) * 100) : 0;
	const lines = [
		`# pi-memory eval — ${(options.now ?? new Date()).toISOString().slice(0, 19).replace("T", " ")}`,
		"",
		`Store: \`${options.storeDir}\` · ${options.memories} memories · index ${options.indexLines} lines`,
		`Sessions replayed: ${recall.sessions} · user turns: ${recall.turns}`,
		"",
		"## Recall",
		"",
		`- Recall fired on ${recall.injectedTurns}/${recall.turns} turns (${rate}%); ${recall.emptyTurns} turns matched nothing.`,
		`- Tokens injected (approx): median ${approxTokens(percentile(recall.bytes, 0.5))}, p95 ${approxTokens(
			percentile(recall.bytes, 0.95)
		)}, max ${approxTokens(Math.max(0, ...recall.bytes))}.`,
	];
	const top = [...recall.files.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
	if (top.length > 0) {
		lines.push("", "Most recalled:");
		for (const [file, count] of top) lines.push(`- ${file} — ${count} turns`);
	}
	if (options.extraction && options.extraction.sessions > 0) {
		const extraction = options.extraction;
		lines.push("", "## Extraction (dry run, nothing written)", "");
		lines.push(
			`- Sessions: ${extraction.sessions} · proposed ${extraction.proposed} · accepted ${extraction.accepted}.`
		);
		if (extraction.rejectedReasons.size > 0) {
			lines.push("- Rejections:");
			for (const [reason, count] of [...extraction.rejectedReasons.entries()].sort((a, b) => b[1] - a[1])) {
				lines.push(`  - ${count}× ${reason}`);
			}
		}
		for (const sample of extraction.samples) {
			if (sample.writes.length === 0) continue;
			lines.push("", `### ${sample.session}`);
			for (const write of sample.writes) {
				lines.push(`- [${write.type}] ${write.name} — ${write.description}`);
			}
		}
	}
	if (options.extraction && options.extraction.sessions > 0) {
		lines.push(
			"",
			"Spot-check the writes above: a proposed memory that restates the tree, AGENTS.md, or a",
			"commit is a false save even when the validator accepted it.",
			""
		);
	} else {
		lines.push("");
	}
	return lines.join("\n");
}

/** One-line summary for the command notification. */
export function evalSummary(recall: RecallEval): string {
	const rate = recall.turns > 0 ? Math.round((recall.injectedTurns / recall.turns) * 100) : 0;
	return `${recall.sessions} sessions · ${recall.turns} turns · recall fired ${rate}% · p95 ${approxTokens(
		percentile(recall.bytes, 0.95)
	)} tokens`;
}
