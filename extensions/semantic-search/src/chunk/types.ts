/**
 * Core chunk types shared by every chunker.
 *
 * Mirrors lumen's `internal/chunker/chunker.go`, with two extra kinds used by
 * the structured (JSON/YAML) chunker.
 */

import { createHash } from "node:crypto";

export type ChunkKind =
	| "function"
	| "method"
	| "type"
	| "interface"
	| "const"
	| "var"
	| "package"
	| "section"
	| "document";

export interface Chunk {
	/** Deterministic: sha256(filePath + ":" + content)[:16]. */
	id: string;
	/** Path relative to the project root. */
	filePath: string;
	/** "FuncName" or "TypeName.MethodName". */
	symbol: string;
	kind: ChunkKind;
	/** 1-based. */
	startLine: number;
	/** 1-based, inclusive. */
	endLine: number;
	/** Raw source text, used for embedding. */
	content: string;
}

export interface Chunker {
	chunk(filePath: string, content: string): Chunk[];
}

export interface AsyncChunkerProvider {
	(): Promise<Chunker>;
}

export function makeChunk(
	filePath: string,
	symbol: string,
	kind: ChunkKind,
	startLine: number,
	endLine: number,
	content: string
): Chunk {
	// Hash path + content so chunks stay unique even in minified files where
	// several symbols share one line.
	const id = createHash("sha256")
		.update(filePath)
		.update(":")
		.update(content)
		.digest("hex")
		.slice(0, 16);
	return { id, filePath, symbol, kind, startLine, endLine, content };
}
