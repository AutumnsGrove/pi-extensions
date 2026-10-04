/**
 * Chunk post-processing, ported from lumen's `internal/index/split.go`:
 *
 *  - `splitOversizedChunks` splits a chunk whose estimated tokens exceed the
 *    budget at natural line boundaries, carrying a header and overlap into
 *    continuation sub-chunks.
 *  - `mergeUndersizedChunks` combines adjacent tiny `var`/`const`/`type`
 *    chunks so keyword-dense short chunks do not dominate search.
 *
 * Token count is estimated as `chars / 4`.
 */

import { type Chunk, type ChunkKind, makeChunk } from "../chunk/types.ts";

const OVERLAP_LINES = 10;
const HEADER_LINES = 5;
const MIN_MERGE_TOKENS = 50;
/** Maximum line gap between tiny declarations that may still be merged. */
const MAX_MERGE_GAP = 2;

export function splitOversizedChunks(
	chunks: readonly Chunk[],
	maxTokens: number
): Chunk[] {
	if (maxTokens <= 0) {
		return [...chunks];
	}
	const maxChars = maxTokens * 4;
	const result: Chunk[] = [];
	for (const chunk of chunks) {
		// Reserve room for the embedding prefix "// " + filePath + "\n".
		const overhead = 3 + chunk.filePath.length + 1;
		const budget = Math.max(1, maxChars - overhead);
		if (chunk.content.length <= budget) {
			result.push(chunk);
			continue;
		}
		result.push(...splitChunk(chunk, budget));
	}
	return result;
}

function splitChunk(chunk: Chunk, maxChars: number): Chunk[] {
	const lines = splitContentByLines(chunk.content);
	const parts = partitionLines(lines, maxChars);
	if (parts.length <= 1) {
		return [chunk];
	}
	return createSubChunks(chunk, parts, maxChars);
}

function splitContentByLines(content: string): string[] {
	const lines = content.split(/(?<=\n)/);
	if (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines;
}

export function partitionLines(lines: readonly string[], maxChars: number): string[][] {
	const parts: string[][] = [];
	let current: string[] = [];
	let currentLen = 0;
	for (const line of lines) {
		if (currentLen + line.length > maxChars && current.length > 0) {
			const splitAt = findSplitPoint(current);
			if (splitAt > 0 && splitAt < current.length) {
				parts.push(current.slice(0, splitAt));
				current = current.slice(splitAt);
				currentLen = linesLen(current);
			} else {
				parts.push(current);
				current = [];
				currentLen = 0;
			}
		}
		current.push(line);
		currentLen += line.length;
	}
	if (current.length > 0) {
		parts.push(current);
	}
	return parts;
}

/**
 * Scan backward for a natural split boundary (blank line, block-ending token,
 * or a dedent). Returns the index where the next partition begins, or 0.
 */
export function findSplitPoint(lines: readonly string[]): number {
	const lookback = 20;
	const start = Math.max(1, lines.length - lookback);
	for (let i = lines.length - 1; i >= start; i -= 1) {
		const trimmed = (lines[i] ?? "").trim();
		if (isSplitBoundary(trimmed)) {
			return i + 1;
		}
		const next = lines[i + 1];
		if (next !== undefined && trimmed !== "") {
			const thisIndent = countLeadingWhitespace(lines[i] ?? "");
			const nextIndent = countLeadingWhitespace(next);
			if (nextIndent > 0 && thisIndent < nextIndent) {
				return i;
			}
		}
	}
	return 0;
}

function isSplitBoundary(trimmed: string): boolean {
	return (
		trimmed === "" ||
		trimmed === "}" ||
		trimmed === "}," ||
		trimmed === "});" ||
		trimmed === "};" ||
		trimmed === "end"
	);
}

function countLeadingWhitespace(line: string): number {
	let count = 0;
	while (count < line.length) {
		const ch = line[count];
		if (ch !== " " && ch !== "\t") {
			break;
		}
		count += 1;
	}
	return count;
}

function linesLen(lines: readonly string[]): number {
	let total = 0;
	for (const line of lines) {
		total += line.length;
	}
	return total;
}

function createSubChunks(
	chunk: Chunk,
	parts: readonly string[][],
	maxChars: number
): Chunk[] {
	const result: Chunk[] = [];
	let lineOffset = 0;

	let header = parts[0] ?? [];
	if (header.length > HEADER_LINES) {
		header = header.slice(0, HEADER_LINES);
	}

	for (let i = 0; i < parts.length; i += 1) {
		const part = parts[i] ?? [];
		let effective: readonly string[] = part;
		let overlapCount = 0;
		if (i > 0) {
			const previous = parts[i - 1] ?? [];
			const n = Math.min(OVERLAP_LINES, previous.length);
			const overlap = previous.slice(previous.length - n);
			const extended = [...header, ...overlap, ...part];
			if (maxChars <= 0 || linesLen(extended) <= maxChars) {
				effective = extended;
				overlapCount = n;
			}
		}
		const content = effective.join("");
		const startLine = chunk.startLine + lineOffset - overlapCount;
		const endLine = chunk.startLine + lineOffset + part.length - 1;
		result.push(
			makeChunk(chunk.filePath, chunk.symbol, chunk.kind, startLine, endLine, content)
		);
		lineOffset += part.length;
	}
	return result;
}

export function mergeUndersizedChunks(chunks: readonly Chunk[]): Chunk[] {
	const minChars = MIN_MERGE_TOKENS * 4;
	const result: Chunk[] = [];
	let i = 0;
	while (i < chunks.length) {
		const chunk = chunks[i];
		if (!chunk) {
			i += 1;
			continue;
		}
		if (!isMergeable(chunk.kind) || chunk.content.length >= minChars) {
			result.push(chunk);
			i += 1;
			continue;
		}
		const group: Chunk[] = [chunk];
		while (i + group.length < chunks.length) {
			const next = chunks[i + group.length];
			const previous = group[group.length - 1];
			if (
				!next ||
				next.filePath !== chunk.filePath ||
				next.kind !== chunk.kind ||
				next.content.length >= minChars
			) {
				break;
			}
			// Only merge declarations that are adjacent in the source. Without
			// this, two tiny same-kind chunks hundreds of lines apart collapsed
			// into one spanning chunk whose embedded text omitted the code between
			// them but whose line range included it.
			if (previous && next.startLine > previous.endLine + MAX_MERGE_GAP) {
				break;
			}
			group.push(next);
		}
		if (group.length === 1) {
			result.push(chunk);
			i += 1;
			continue;
		}
		result.push(mergeChunkGroup(group));
		i += group.length;
	}
	return result;
}

function isMergeable(kind: ChunkKind): boolean {
	return kind === "var" || kind === "const" || kind === "type";
}

function mergeChunkGroup(group: readonly Chunk[]): Chunk {
	const content = group.map((chunk) => chunk.content).join("\n");
	const first = group[0];
	const last = group[group.length - 1];
	if (!first || !last) {
		throw new Error("cannot merge an empty chunk group");
	}
	const symbol = group.map((chunk) => chunk.symbol).join("+");
	return makeChunk(
		first.filePath,
		symbol,
		first.kind,
		first.startLine,
		last.endLine,
		content
	);
}
