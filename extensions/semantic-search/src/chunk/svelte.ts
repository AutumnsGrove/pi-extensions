/**
 * Svelte chunker.
 *
 * `@vscode/tree-sitter-wasm` has no Svelte grammar, so — like lumen's two-phase
 * approach, minus the outer grammar — we locate `<script>` blocks with a small
 * scanner and re-parse their contents with the TypeScript chunker. Line numbers
 * are shifted back to be file-relative.
 *
 * Template markup is intentionally not chunked; only script-block symbols.
 */

import { type Chunk, type Chunker } from "./types.ts";

const SCRIPT_RE = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;

function countNewlines(text: string): number {
	let count = 0;
	for (let i = 0; i < text.length; i += 1) {
		if (text[i] === "\n") {
			count += 1;
		}
	}
	return count;
}

export function createSvelteChunker(tsChunker: Chunker): Chunker {
	return {
		chunk(filePath: string, content: string): Chunk[] {
			const chunks: Chunk[] = [];
			let match: RegExpExecArray | null;
			SCRIPT_RE.lastIndex = 0;
			while ((match = SCRIPT_RE.exec(content)) !== null) {
				const full = match[0];
				const inner = match[1] ?? "";
				const openTagEnd = full.indexOf(">");
				if (openTagEnd === -1) {
					continue;
				}
				const innerStart = match.index + openTagEnd + 1;
				const lineOffset = countNewlines(content.slice(0, innerStart));
				for (const innerChunk of tsChunker.chunk(filePath, inner)) {
					chunks.push({
						...innerChunk,
						startLine: innerChunk.startLine + lineOffset,
						endLine: innerChunk.endLine + lineOffset,
					});
				}
			}
			return chunks;
		},
	};
}
