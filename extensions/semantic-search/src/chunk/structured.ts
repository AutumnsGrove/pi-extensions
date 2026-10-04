/**
 * Structured chunker for JSON and YAML.
 *
 * Ported in spirit from lumen's `internal/chunker/structured.go`: small files
 * become one `document` chunk; larger files are split at top-level keys. The
 * `# path: <symbol>` prefix mirrors lumen so the key path is embedded in the
 * text. Line ranges are real, so snippets read back correctly.
 *
 * Unlike lumen we split at the top level only; the oversized-chunk splitter in
 * the indexing pipeline is the backstop for a single huge value.
 */

import { type Chunk, type Chunker, makeChunk } from "./types.ts";

interface Entry {
	symbol: string;
	startOffset: number;
	endOffset: number;
}

/** Build a line-number lookup for converting offsets to 1-based lines. */
function lineIndex(content: string): (offset: number) => number {
	const starts = [0];
	for (let i = 0; i < content.length; i += 1) {
		if (content[i] === "\n") {
			starts.push(i + 1);
		}
	}
	return (offset: number): number => {
		let low = 0;
		let high = starts.length - 1;
		while (low < high) {
			const mid = (low + high + 1) >> 1;
			if ((starts[mid] ?? 0) <= offset) {
				low = mid;
			} else {
				high = mid - 1;
			}
		}
		return low + 1;
	};
}

function documentChunk(filePath: string, text: string): Chunk {
	const lines = text.length === 0 ? 1 : text.split("\n").length;
	return makeChunk(filePath, "root", "document", 1, lines, text);
}

function chunksFromEntries(
	filePath: string,
	content: string,
	entries: Entry[]
): Chunk[] {
	const lineAt = lineIndex(content);
	const chunks: Chunk[] = [];
	for (const entry of entries) {
		const raw = content.slice(entry.startOffset, entry.endOffset);
		const text = raw.replace(/\s+$/, "");
		if (text.length === 0) {
			continue;
		}
		const startLine = lineAt(entry.startOffset);
		const endLine = lineAt(Math.max(entry.startOffset, entry.endOffset - 1));
		const body = `# path: ${entry.symbol}\n${text}`;
		chunks.push(makeChunk(filePath, entry.symbol, "section", startLine, endLine, body));
	}
	return chunks;
}

/** Top-level JSON members: `"key": value` or array elements. */
function jsonEntries(content: string): Entry[] {
	const entries: Entry[] = [];
	let depth = 0;
	let inString = false;
	let escaped = false;
	let rangeStart = -1;
	let arrayIndex = 0;

	const push = (end: number): void => {
		if (rangeStart < 0 || end <= rangeStart) {
			return;
		}
		const slice = content.slice(rangeStart, end);
		const keyMatch = slice.match(/^\s*"((?:[^"\\]|\\.)*)"/);
		const symbol = keyMatch?.[1] ?? `[${arrayIndex}]`;
		entries.push({
			symbol,
			startOffset: content.indexOf(slice.trimStart(), rangeStart),
			endOffset: end,
		});
		if (!keyMatch) {
			arrayIndex += 1;
		}
	};

	for (let i = 0; i < content.length; i += 1) {
		const ch = content[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (ch === "\\") {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{" || ch === "[") {
			depth += 1;
			if (depth === 1) {
				rangeStart = i + 1;
			}
			continue;
		}
		if (ch === "}" || ch === "]") {
			depth -= 1;
			if (depth === 0) {
				push(i);
				rangeStart = -1;
			}
			continue;
		}
		if (ch === "," && depth === 1) {
			push(i);
			rangeStart = i + 1;
		}
	}
	return entries;
}

/** Top-level YAML keys (column 0) and sequence items. */
function yamlEntries(content: string): Entry[] {
	const lines = content.split("\n");
	const offsets: number[] = [];
	let running = 0;
	for (const line of lines) {
		offsets.push(running);
		running += line.length + 1;
	}
	const starts: number[] = [];
	const symbols: string[] = [];
	let sequenceIndex = 0;
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		if (line.trim() === "" || line.startsWith("#")) {
			continue;
		}
		// Check sequence items first: "- key: value" is a list item, not a
		// top-level key. The key regex below would otherwise capture "- key".
		if (/^-\s/.test(line) || line === "-") {
			starts.push(i);
			symbols.push(`[${sequenceIndex}]`);
			sequenceIndex += 1;
			continue;
		}
		const key = line.match(/^([^\s#][^:]*?):(\s|$)/);
		if (key?.[1]) {
			starts.push(i);
			symbols.push(key[1].trim());
			sequenceIndex = 0;
		}
	}
	const entries: Entry[] = [];
	for (let i = 0; i < starts.length; i += 1) {
		const lineStart = starts[i] ?? 0;
		const nextLine = starts[i + 1];
		const startOffset = offsets[lineStart] ?? 0;
		const endOffset =
			nextLine === undefined
				? content.length
				: (offsets[nextLine] ?? content.length) - 1;
		entries.push({ symbol: symbols[i] ?? "root", startOffset, endOffset });
	}
	return entries;
}

/** Create a structured chunker with a token budget (chars = tokens * 4). */
export function createStructuredChunker(maxTokens: number): Chunker {
	const maxChars = Math.max(1, maxTokens) * 4;
	return {
		chunk(filePath: string, content: string): Chunk[] {
			const trimmed = content.trim();
			if (trimmed.length === 0) {
				return [];
			}
			if (trimmed.length <= maxChars) {
				return [documentChunk(filePath, trimmed)];
			}
			const isJson = /\.json$/i.test(filePath);
			const entries = isJson ? jsonEntries(content) : yamlEntries(content);
			if (entries.length === 0) {
				return [documentChunk(filePath, trimmed)];
			}
			return chunksFromEntries(filePath, content, entries);
		},
	};
}
