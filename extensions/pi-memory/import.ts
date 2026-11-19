/**
 * One-way import from Claude Code's memory store.
 *
 * Claude's layout is close enough to ours that importing is mostly a copy:
 * the same `MEMORY.md` index shape, the same frontmatter fields, the same
 * one-file-per-memory rule. The differences are the directory slug and a
 * looser attitude to missing frontmatter.
 *
 * The source directory is only ever read. Import plans first and writes
 * second, so `--dry-run` can show exactly what would change.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { filenameFor, parseMemory } from "./frontmatter.ts";
import type { MemoryStore } from "./store.ts";
import { normalizeName, uniqueTokens, jaccard } from "./text.ts";
import type { IndexRender, MemoryCandidate, SaveResult } from "./types.ts";

export interface ImportEntry {
	/** Source file basename. */
	from: string;
	/** Planned destination basename. */
	to: string;
	candidate: MemoryCandidate;
}

export interface ImportSkip {
	file: string;
	reason: string;
}

export interface ImportPlan {
	source: string;
	entries: ImportEntry[];
	skipped: ImportSkip[];
}

export interface ImportResult {
	imported: number;
	updated: number;
	skipped: ImportSkip[];
	index: IndexRender;
}

function memoryFiles(dir: string): string[] {
	try {
		return readdirSync(dir)
			.filter((name) => name.toLowerCase().endsWith(".md"))
			.filter((name) => {
				try {
					return statSync(join(dir, name)).isFile();
				} catch {
					return false;
				}
			})
			.sort();
	} catch {
		return [];
	}
}

/** Name/description/body similarity against what the store already has. */
function duplicateReason(
	candidate: MemoryCandidate,
	existing: Array<{ name: string; description: string; body: string }>,
	threshold = 0.7
): string | undefined {
	const name = normalizeName(candidate.name);
	const description = uniqueTokens(candidate.description);
	const body = uniqueTokens(candidate.body);
	for (const memory of existing) {
		if (normalizeName(memory.name) === name) return "already present (same name)";
		if (
			description.size > 0 &&
			jaccard(uniqueTokens(memory.description), description) >= threshold
		) {
			return "already present (similar description)";
		}
		if (body.size >= 4 && jaccard(uniqueTokens(memory.body), body) >= 0.8) {
			return "already present (similar body)";
		}
	}
	return undefined;
}

/**
 * Read the source and decide what to copy. Never writes.
 *
 * Throws when the source directory does not exist so the command can say so;
 * an existing but empty store is a valid plan with zero entries.
 */
export function planImport(sourceDir: string, store: MemoryStore): ImportPlan {
	if (!existsSync(sourceDir)) {
		throw new Error(`no Claude Code memory store at ${sourceDir}`);
	}
	const existing = store.files().map(({ name, description, body }) => ({ name, description, body }));
	const entries: ImportEntry[] = [];
	const skipped: ImportSkip[] = [];
	for (const file of memoryFiles(sourceDir)) {
		if (file.toLowerCase() === "memory.md") {
			skipped.push({ file, reason: "the index, not a memory" });
			continue;
		}
		let text: string;
		try {
			text = readFileSync(join(sourceDir, file), "utf8");
		} catch {
			skipped.push({ file, reason: "unreadable" });
			continue;
		}
		const parsed = parseMemory(file, text);
		if (!parsed) {
			skipped.push({ file, reason: "empty or unreadable" });
			continue;
		}
		const candidate: MemoryCandidate = {
			name: parsed.name,
			description: parsed.description,
			type: parsed.type,
			body: parsed.body,
		};
		const reason = duplicateReason(candidate, existing);
		if (reason) {
			skipped.push({ file, reason });
			continue;
		}
		entries.push({
			from: file,
			to: filenameFor(candidate.type, candidate.name),
			candidate,
		});
		// Later files in the same batch must not re-import the same memory.
		existing.push(candidate);
	}
	return { source: sourceDir, entries, skipped };
}

/** Apply a plan. A same-named memory is updated rather than duplicated. */
export function applyImport(plan: ImportPlan, store: MemoryStore): ImportResult {
	let imported = 0;
	let updated = 0;
	const skipped = [...plan.skipped];
	const saved: SaveResult[] = [];
	for (const entry of plan.entries) {
		try {
			const result = store.save(entry.candidate);
			saved.push(result);
			if (result.created) imported++;
			else updated++;
		} catch (cause) {
			skipped.push({
				file: entry.from,
				reason: cause instanceof Error ? cause.message : String(cause),
			});
		}
	}
	const index = store.rewriteIndex();
	return { imported, updated, skipped, index };
}

/** Human-readable plan, used by `/memory import --dry-run`. */
export function formatImportPlan(plan: ImportPlan): string {
	const lines: string[] = [`Source: ${plan.source}`];
	if (plan.entries.length === 0) {
		lines.push("Nothing new to import.");
	} else {
		lines.push(`${plan.entries.length} to import:`);
		for (const entry of plan.entries) {
			lines.push(`  ${entry.from} → ${entry.to}`);
		}
	}
	if (plan.skipped.length > 0) {
		lines.push(`${plan.skipped.length} skipped:`);
		for (const skip of plan.skipped) {
			lines.push(`  ${skip.file}: ${skip.reason}`);
		}
	}
	return lines.join("\n");
}

/** One-line result for the command. */
export function formatImportResult(result: ImportResult): string {
	const parts = [`${result.imported} imported`];
	if (result.updated > 0) parts.push(`${result.updated} updated`);
	if (result.skipped.length > 0) parts.push(`${result.skipped.length} skipped`);
	return `${parts.join(" · ")} · index ${result.index.lines} lines`;
}
