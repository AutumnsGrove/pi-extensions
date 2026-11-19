/**
 * `memory_search`: keyword first, semantic when asked.
 *
 * Keyword search is the default because it needs nothing running and never
 * surprises: a term is in the file or it is not. Semantic search reuses the
 * same Ollama embedding model as `semantic-search` when it is installed, but
 * keeps its own small cache in the memory store — memory files are few, so a
 * vector database would be more machinery than the problem needs.
 */

import { capText, oneLine, tokenize } from "./text.ts";
import type { MemoryFile } from "./types.ts";

export type SearchMode = "keyword" | "semantic" | "auto";

export interface SearchHit {
	memory: MemoryFile;
	score: number;
	snippet: string;
	source: "keyword" | "semantic";
}

export interface SearchResult {
	hits: SearchHit[];
	/** Semantic attempts that failed, for a one-line note in the tool result. */
	note?: string;
}

const MAX_SNIPPET = 180;

/** The line of the body that best matches the query, trimmed for display. */
export function snippetFor(memory: MemoryFile, query: string): string {
	const terms = new Set(tokenize(query));
	if (terms.size === 0) return oneLine(memory.description, MAX_SNIPPET);
	let best: { line: string; hits: number } | undefined;
	for (const raw of memory.body.split("\n")) {
		const line = raw.replace(/^[-*+]\s+/, "").trim();
		if (line === "") continue;
		let hits = 0;
		for (const token of tokenize(line)) {
			if (terms.has(token)) hits++;
		}
		if (!best || hits > best.hits) best = { line, hits };
		if (hits === terms.size) break;
	}
	const line = best && best.hits > 0 ? best.line : memory.description;
	return oneLine(line, MAX_SNIPPET);
}

/**
 * Rank by where the term appears. A name hit is worth far more than a body
 * mention, because a memory's name is its claim; the body is the explanation.
 */
export function keywordSearch(
	files: readonly MemoryFile[],
	query: string,
	limit: number
): SearchHit[] {
	const terms = new Set(tokenize(query));
	if (terms.size === 0) return [];
	const hits: SearchHit[] = [];
	for (const memory of files) {
		const name = new Set(tokenize(memory.name));
		const description = new Set(tokenize(memory.description));
		const body = new Set(tokenize(memory.body.slice(0, 8_192)));
		let nameHits = 0;
		let descriptionHits = 0;
		let bodyHits = 0;
		for (const term of terms) {
			if (name.has(term)) nameHits++;
			if (description.has(term)) descriptionHits++;
			if (body.has(term)) bodyHits++;
		}
		if (nameHits + descriptionHits + bodyHits === 0) continue;
		const score = nameHits * 6 + descriptionHits * 3 + Math.min(bodyHits, 6);
		hits.push({ memory, score, snippet: snippetFor(memory, query), source: "keyword" });
	}
	return hits
		.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			if (b.memory.mtimeMs !== a.memory.mtimeMs) return b.memory.mtimeMs - a.memory.mtimeMs;
			return a.memory.file.localeCompare(b.memory.file);
		})
		.slice(0, Math.max(0, limit));
}

export function cosine(a: readonly number[], b: readonly number[]): number {
	if (a.length === 0 || a.length !== b.length) return 0;
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		const x = a[i]!;
		const y = b[i]!;
		dot += x * y;
		na += x * x;
		nb += y * y;
	}
	if (na === 0 || nb === 0) return 0;
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Cache key: a change to the file or the embedding profile invalidates it. */
export function vectorKey(profile: string, memory: MemoryFile): string {
	return [
		profile,
		memory.file,
		String(memory.mtimeMs),
		String(memory.bytes),
	].join("\u0000");
}

export type VectorCache = Record<string, number[]>;

/** Text sent to the embedder. Name and description lead so they dominate. */
export function embeddingText(memory: MemoryFile): string {
	return capText(`${memory.name}\n${memory.description}\n${memory.body}`, 6_000, 200).text;
}

export interface SemanticSearchOptions {
	query: string;
	limit: number;
	/** Embedding profile, e.g. `model:dimensions`. */
	profile: string;
	/** Cosine floor. */
	minScore: number;
	embed: (texts: readonly string[]) => Promise<number[][]>;
	cache: VectorCache;
	/** Re-embed every file, ignoring the cache. */
	force?: boolean;
}

/**
 * Embed the store and rank by cosine similarity.
 *
 * The query is embedded every time; file vectors are cached by content
 * identity. A provider failure propagates so the caller can fall back to
 * keyword results instead of pretending the store is empty.
 */
export async function semanticSearch(
	files: readonly MemoryFile[],
	options: SemanticSearchOptions
): Promise<{ hits: SearchHit[]; cache: VectorCache; embedded: number }> {
	const cache: VectorCache = options.force ? {} : { ...options.cache };
	const missing: Array<{ memory: MemoryFile; key: string }> = [];
	for (const memory of files) {
		const key = vectorKey(options.profile, memory);
		if (!cache[key]) missing.push({ memory, key });
	}
	let embedded = 0;
	if (missing.length > 0) {
		const vectors = await options.embed(missing.map(({ memory }) => embeddingText(memory)));
		if (vectors.length !== missing.length) {
			throw new Error(
				`embedder returned ${vectors.length} vectors for ${missing.length} memories`
			);
		}
		for (let i = 0; i < missing.length; i++) {
			const entry = missing[i]!;
			const vector = vectors[i]!;
			cache[entry.key] = vector;
			embedded++;
		}
	}
	const [queryVector] = await options.embed([options.query]);
	if (!queryVector) throw new Error("embedder returned no vector for the query");
	const hits: SearchHit[] = [];
	for (const memory of files) {
		const vector = cache[vectorKey(options.profile, memory)];
		if (!vector) continue;
		const score = cosine(queryVector, vector);
		if (score < options.minScore) continue;
		hits.push({
			memory,
			score,
			snippet: snippetFor(memory, options.query),
			source: "semantic",
		});
	}
	hits.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score;
		return a.memory.file.localeCompare(b.memory.file);
	});
	return { hits: hits.slice(0, Math.max(0, options.limit)), cache, embedded };
}

/** Keyword first, then semantic hits not already present. */
export function mergeSearchHits(
	keyword: readonly SearchHit[],
	semantic: readonly SearchHit[],
	limit: number
): SearchHit[] {
	const seen = new Set(keyword.map((hit) => hit.memory.file));
	const merged = [...keyword];
	for (const hit of semantic) {
		if (merged.length >= limit) break;
		if (seen.has(hit.memory.file)) continue;
		seen.add(hit.memory.file);
		merged.push(hit);
	}
	return merged.slice(0, Math.max(0, limit));
}

/** Tool-facing text for search results. */
export function formatSearchResults(result: SearchResult): string {
	if (result.hits.length === 0) {
		return result.note ? `No memories matched. ${result.note}` : "No memories matched.";
	}
	const lines = result.hits.map((hit, index) => {
		const score = hit.source === "semantic" ? hit.score.toFixed(2) : String(hit.score);
		return `${index + 1}. [${hit.memory.type}] ${hit.memory.name} (${hit.memory.file}) · ${hit.source} ${score}\n   ${hit.snippet}`;
	});
	const note = result.note ? `\n${result.note}` : "";
	return `${lines.join("\n")}${note}`;
}
