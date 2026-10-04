/**
 * Result formatting, ported from lumen's `cmd/stdio.go`. Results are rendered
 * as XML-tagged chunks grouped by file so the model reads compact, structured
 * context instead of whole files.
 */

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { SearchConfig } from "../config.ts";
import { EmbedError } from "../embed/types.ts";
import type { RankedItem } from "./rank.ts";

export interface SearchOutput {
	results: RankedItem[];
	reindexed: boolean;
	indexedFiles?: number;
	filteredHint?: string;
	seedWarning?: string;
	staleWarning?: string;
}

export interface IndexStatusInfo {
	projectPath: string;
	totalFiles: number;
	totalChunks: number;
	embeddingModel?: string;
	lastIndexedAt?: string;
	stale?: boolean;
	lastIndexError?: string;
	configError?: string;
}

/**
 * Turn an embedding/index failure into an actionable message. The model is told
 * to reach for semantic search first, so a bare "fetch failed" leaves it stuck;
 * name the likely cause and the exact command that fixes it.
 */
export function describeSearchError(error: unknown, config: SearchConfig): string {
	if (error instanceof EmbedError) {
		if (error.statusCode === 404) {
			return (
				`Embedding model "${config.model}" is not available in Ollama at ` +
				`${config.baseUrl}. Pull it with \`ollama pull ${config.model}\`, or ` +
				"choose another model with /semsearch model."
			);
		}
		return (
			`Ollama returned HTTP ${error.statusCode} for model "${config.model}" ` +
			`at ${config.baseUrl}: ${error.message}`
		);
	}
	const message = error instanceof Error ? error.message : String(error);
	if (/abort|cancel/i.test(message)) {
		return "Semantic search was cancelled.";
	}
	if (
		/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network|timed? ?out/i.test(
			message
		)
	) {
		return (
			`Cannot reach Ollama at ${config.baseUrl}. Start it with \`ollama serve\` ` +
			`and pull "${config.model}" (\`ollama pull ${config.model}\`), then retry. ` +
			"Until then, use grep, find, or read."
		);
	}
	if (/node:sqlite|DatabaseSync|sqlite-vec|loadExtension|vec0/i.test(message)) {
		return (
			`The local vector store could not be opened: ${message}. This ` +
			"requires a Node build with node:sqlite and a matching sqlite-vec binary."
		);
	}
	return `Semantic search failed: ${message}`;
}

const XML_ESCAPE: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
};

/** Skip reading files larger than this just to render a snippet. */
const MAX_SNIPPET_FILE_BYTES = 5 * 1024 * 1024;

function xmlEscape(value: string): string {
	return value.replace(/[&<>"]/g, (ch) => XML_ESCAPE[ch] ?? ch);
}

/**
 * Neutralise only the result wrapper's closing tags inside source content.
 * Escaping all of it would mangle code, but leaving these intact lets a file
 * containing `</result:chunk>` end the block early or smuggle text in.
 */
function sanitizeContent(content: string): string {
	return content.replace(/<\/(result:(?:chunk|file))>/gi, "&lt;/$1&gt;");
}

export function formatSearchResults(projectPath: string, out: SearchOutput): string {
	if (out.results.length === 0) {
		const parts = ["No results found."];
		if (out.reindexed) {
			parts.push(`(indexed ${out.indexedFiles ?? 0} files)`);
		}
		let text = parts.join(" ");
		if (out.seedWarning) {
			text += `\nWarning: ${out.seedWarning}`;
		}
		if (out.staleWarning) {
			text += `\nWarning: ${out.staleWarning}`;
		}
		if (out.filteredHint) {
			text += `\n${out.filteredHint}`;
		}
		return text;
	}

	let header = `Found ${out.results.length} results`;
	if (out.reindexed) {
		header += ` (indexed ${out.indexedFiles ?? 0} files)`;
	}
	if (out.seedWarning) {
		header += `\nWarning: ${out.seedWarning}`;
	}
	if (out.staleWarning) {
		header += `\nWarning: ${out.staleWarning}`;
	}
	header += ":\n";

	interface FileGroup {
		rel: string;
		results: RankedItem[];
		maxScore: number;
	}
	const groups = new Map<string, FileGroup>();
	const order: string[] = [];
	for (const result of out.results) {
		let rel: string;
		if (isAbsolute(result.filePath)) {
			try {
				rel = relative(projectPath, result.filePath);
			} catch {
				rel = result.filePath;
			}
		} else {
			rel = result.filePath;
		}
		let group = groups.get(rel);
		if (!group) {
			group = { rel, results: [], maxScore: 0 };
			groups.set(rel, group);
			order.push(rel);
		}
		group.results.push(result);
		group.maxScore = Math.max(group.maxScore, result.score);
	}

	order.sort((a, b) => (groups.get(b)?.maxScore ?? 0) - (groups.get(a)?.maxScore ?? 0));

	let body = "";
	for (const rel of order) {
		const group = groups.get(rel);
		if (!group) {
			continue;
		}
		body += `\n<result:file filename="${xmlEscape(group.rel)}">\n`;
		for (const result of [...group.results].sort((a, b) => b.score - a.score)) {
			body += `  <result:chunk line-start="${result.startLine}" line-end="${result.endLine}" symbol="${xmlEscape(
				result.symbol
			)}" kind="${xmlEscape(result.kind)}" score="${result.score.toFixed(2)}">\n`;
			if (result.content) {
				body += `${sanitizeContent(result.content)}\n`;
			}
			body += "  </result:chunk>\n";
		}
		body += "</result:file>";
	}
	return header + body;
}

export function formatIndexStatus(info: IndexStatusInfo): string {
	const lines = [`Index: ${info.projectPath}`];
	lines.push(
		`Files: ${info.totalFiles} | Indexed chunks: ${info.totalChunks} | Model: ${
			info.embeddingModel ?? "unknown"
		}`
	);
	lines.push(
		`Last indexed: ${info.lastIndexedAt ?? "never"} | Stale: ${info.stale ? "yes" : "no"}`
	);
	if (info.lastIndexError) {
		lines.push(`Last index error: ${info.lastIndexError}`);
	}
	if (info.configError) {
		lines.push(`Config error: ${info.configError}`);
	}
	return lines.join("\n");
}

export function readFileLines(projectPath: string, filePath: string): string[] {
	try {
		const path = isAbsolute(filePath) ? filePath : join(projectPath, filePath);
		// Reading a huge file to show a few snippet lines is wasted memory and
		// blocks the event loop; skip files beyond the indexing size cap.
		if (statSync(path).size > MAX_SNIPPET_FILE_BYTES) {
			return [];
		}
		return readFileSync(path, "utf8").split("\n");
	} catch {
		return [];
	}
}

export function truncateLines(text: string, maxLines: number): string {
	const lines = text.split("\n");
	return lines.length <= maxLines ? text : lines.slice(0, maxLines).join("\n");
}

export function normalizeLineRange(
	startLine: number,
	endLine: number,
	totalLines: number
): [number, number] {
	const start = Math.max(startLine - 1, 0);
	const end = Math.min(endLine, totalLines);
	return [start, end];
}

/** Populate `content` on each item by reading its source lines. */
export function fillSnippets(
	projectPath: string,
	items: RankedItem[],
	maxLines: number
): void {
	const byFile = new Map<string, number[]>();
	for (let i = 0; i < items.length; i += 1) {
		const item = items[i];
		if (!item) {
			continue;
		}
		const refs = byFile.get(item.filePath) ?? [];
		refs.push(i);
		byFile.set(item.filePath, refs);
	}
	for (const [filePath, refs] of byFile) {
		const lines = readFileLines(projectPath, filePath);
		if (lines.length === 0) {
			continue;
		}
		for (const index of refs) {
			const item = items[index];
			if (!item) {
				continue;
			}
			const [start, end] = normalizeLineRange(item.startLine, item.endLine, lines.length);
			if (start >= end) {
				continue;
			}
			let content = lines.slice(start, end).join("\n");
			if (maxLines > 0 && content.length > 0) {
				content = truncateLines(content, maxLines);
			}
			items[index] = { ...item, content };
		}
	}
}
