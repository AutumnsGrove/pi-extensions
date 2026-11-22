/**
 * The verdict log.
 *
 * One JSONL line per decided state, with the compact inputs, the answers, the
 * model, and the latency. The point is replay: a candidate cascade or a changed
 * threshold can be checked against what actually happened instead of guessed
 * at. It holds the agent's last message, so it is a session artifact, not
 * something to publish.
 *
 * `PI_ATTENTION_LOG` overrides the path. Writes are best effort and never fail a
 * turn; a full disk is not worth a broken settle. Past `MAX_LOG_BYTES` the file
 * keeps its newest half.
 */

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { VerdictRecord } from "./types.ts";

export const MAX_LOG_BYTES = 1024 * 1024;
export const MAX_LOG_LINES = 200;

export function logPath(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.PI_ATTENTION_LOG?.trim();
	if (override) return override.replace(/^~(?=$|\/)/, homedir());
	return join(homedir(), ".pi", "agent", "attention.jsonl");
}

/** Append one record, rotating when the file has grown past the cap. */
export function appendVerdict(record: VerdictRecord, path = logPath()): void {
	try {
		mkdirSync(dirname(path), { recursive: true });
		try {
			if (statSync(path).size > MAX_LOG_BYTES) rotate(path);
		} catch {
			// No file yet: nothing to rotate.
		}
		appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
	} catch {
		// Logging is a diagnostic, never a failure path.
	}
}

/** Keep the newest half of the file. */
function rotate(path: string): void {
	const text = readFileSync(path, "utf8");
	const lines = text.trimEnd().split("\n");
	const kept = lines.slice(Math.floor(lines.length / 2));
	writeFileSync(path, `${kept.join("\n")}\n`, "utf8");
}

/** The last `count` records, oldest first. Malformed lines are skipped. */
export function readVerdicts(path = logPath(), count = MAX_LOG_LINES): VerdictRecord[] {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	const records: VerdictRecord[] = [];
	for (const line of text.trimEnd().split("\n")) {
		if (!line.trim()) continue;
		try {
			records.push(JSON.parse(line) as VerdictRecord);
		} catch {
			// A torn write from a killed process is not worth failing the command.
		}
	}
	return records.slice(-count);
}

/** One line per record for `/attention log`. */
export function describeVerdicts(records: VerdictRecord[], now = Date.now()): string[] {
	if (records.length === 0) return ["No verdicts logged yet."];
	return records.map((record) => {
		const when = new Date(record.at);
		const elapsed = Math.max(0, Math.round((now - record.at) / 1000));
		const ago = elapsed < 60 ? `${elapsed}s ago` : `${Math.round(elapsed / 60)}m ago`;
		const confidence = record.confidence !== undefined ? ` ${record.confidence.toFixed(2)}` : "";
		const model = record.model ? ` ${record.model}` : "";
		return `${when.toISOString().slice(11, 19)} ${ago} · ${record.state}${confidence} [${record.source}${model}] ${record.reason}`;
	});
}
