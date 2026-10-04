/**
 * Chunker dispatch: extension -> chunker, and the canonical supported-extension
 * list used by the file filter.
 *
 * All tree-sitter grammars are loaded once, lazily, on first build.
 */

import { type Chunk, type Chunker } from "./types.ts";
import { createTreeSitterChunker } from "./treesitter.ts";
import {
	BASH_QUERIES,
	GO_QUERIES,
	JS_QUERIES,
	PYTHON_QUERIES,
	TS_QUERIES,
} from "./languages.ts";
import { createStructuredChunker } from "./structured.ts";
import { createSvelteChunker } from "./svelte.ts";

/** File extensions indexed by the default chunker set. */
export const SUPPORTED_EXTENSIONS: readonly string[] = [
	".go",
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".svelte",
	".sh",
	".bash",
	".zsh",
	".json",
	".yaml",
	".yml",
];

export interface ChunkerSet extends Chunker {
	readonly byExtension: ReadonlyMap<string, Chunker>;
}

function extname(filePath: string): string {
	const base = filePath.slice(filePath.lastIndexOf("/") + 1);
	const dot = base.lastIndexOf(".");
	return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/**
 * Build the default chunker set. `maxTokens` bounds structured chunks; the
 * indexing pipeline splits any oversized tree-sitter chunk afterwards.
 */
export async function buildChunkers(maxTokens: number): Promise<ChunkerSet> {
	const [go, ts, tsx, js, python, bash] = await Promise.all([
		createTreeSitterChunker({ language: "go", queries: GO_QUERIES }),
		createTreeSitterChunker({ language: "typescript", queries: TS_QUERIES }),
		createTreeSitterChunker({ language: "tsx", queries: TS_QUERIES }),
		createTreeSitterChunker({ language: "javascript", queries: JS_QUERIES }),
		createTreeSitterChunker({ language: "python", queries: PYTHON_QUERIES }),
		createTreeSitterChunker({ language: "bash", queries: BASH_QUERIES }),
	]);
	const structured = createStructuredChunker(maxTokens);
	const svelte = createSvelteChunker(ts);

	const byExtension = new Map<string, Chunker>([
		[".go", go],
		[".ts", ts],
		[".tsx", tsx],
		[".js", js],
		[".jsx", js],
		[".mjs", js],
		[".cjs", js],
		[".py", python],
		[".svelte", svelte],
		[".sh", bash],
		[".bash", bash],
		[".zsh", bash],
		[".json", structured],
		[".yaml", structured],
		[".yml", structured],
	]);

	return {
		byExtension,
		chunk(filePath: string, content: string): Chunk[] {
			const chunker = byExtension.get(extname(filePath));
			return chunker ? chunker.chunk(filePath, content) : [];
		},
	};
}
