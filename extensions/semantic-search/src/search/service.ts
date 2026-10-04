/**
 * Search orchestration: refresh the index, embed the query, run KNN, rank,
 * merge, and format. Adapted from lumen's `semantic_search` MCP handler.
 */

import { defaultMinScore } from "../embed/registry.ts";
import type { Embedder } from "../embed/types.ts";
import type { Indexer, ProgressFunc } from "../index/indexer.ts";
import type { Store } from "../store/sqlite.ts";
import {
	fillSnippets,
	formatSearchResults,
	type SearchOutput,
} from "./format.ts";
import { boostedScore, mergeOverlappingResults, type RankedItem } from "./rank.ts";

export interface SearchRequest {
	query: string;
	limit?: number;
	minScore?: number;
	summary?: boolean;
	maxLines?: number;
	/** Restrict results to a subtree (relative path). */
	pathPrefix?: string;
}

export interface SearchResponse {
	output: SearchOutput;
	text: string;
}

/** Convert a user-facing min_score into the cosine-distance ceiling. */
export function computeMaxDistance(
	minScore: number | undefined,
	model: string,
	dimensions: number
): number {
	if (minScore === undefined) {
		return 1 - defaultMinScore(model, dimensions);
	}
	if (minScore > -1) {
		return 1 - minScore;
	}
	return 0;
}

export async function runSearch(options: {
	store: Store;
	embedder: Embedder;
	indexer: Indexer;
	projectDir: string;
	request: SearchRequest;
	onProgress?: ProgressFunc;
	ensureFresh?: boolean;
}): Promise<SearchResponse> {
	const request = options.request;
	const limit = request.limit && request.limit > 0 ? request.limit : 8;
	const pathPrefix = request.pathPrefix ?? "";

	let reindexed = false;
	let indexedFiles = 0;
	if (options.ensureFresh !== false) {
		const fresh = await options.indexer.ensureFresh(options.onProgress);
		reindexed = fresh.reindexed;
		indexedFiles = fresh.stats.indexedFiles;
	}

	const [queryVec] = await options.embedder.embed([request.query]);
	if (!queryVec) {
		throw new Error("embedder returned no vector for the query");
	}

	const maxDistance = computeMaxDistance(
		request.minScore,
		options.embedder.modelName,
		options.embedder.dimensions
	);

	// Over-fetch so merging overlapping chunks does not shrink below the limit.
	const raw = options.store.search(queryVec, limit * 2, maxDistance, pathPrefix);

	let filteredHint: string | undefined;
	if (raw.length === 0 && maxDistance > 0) {
		const unfiltered = options.store.search(queryVec, 1, 0, pathPrefix);
		const best = unfiltered[0];
		if (best) {
			const bestScore = 1 - best.distance;
			const floor = 1 - maxDistance;
			filteredHint = `Results exist but were below the ${floor.toFixed(
				2
			)} noise floor (best match scored ${bestScore.toFixed(
				2
			)}). Retry with min_score=-1 or a lower min_score.`;
		}
	}

	let items: RankedItem[] = raw.map((result) => ({
		filePath: result.filePath,
		symbol: result.symbol,
		kind: result.kind,
		startLine: result.startLine,
		endLine: result.endLine,
		score: boostedScore(1 - result.distance, result.kind, result.filePath),
	}));
	items = mergeOverlappingResults(items);
	items.sort((a, b) => b.score - a.score);
	if (items.length > limit) {
		items = items.slice(0, limit);
	}
	if (!request.summary) {
		fillSnippets(options.projectDir, items, request.maxLines ?? 0);
	}

	const output: SearchOutput = { results: items, reindexed, indexedFiles, filteredHint };
	return { output, text: formatSearchResults(options.projectDir, output) };
}
