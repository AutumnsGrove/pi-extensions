/**
 * LM Studio embedder. Ported from lumen's `internal/embedder/lmstudio.go`.
 *
 * Talks to the OpenAI-compatible `POST /v1/embeddings` endpoint. The OpenAI
 * spec permits out-of-order responses, so results are sorted by `index`.
 */

import {
	EMBED_BATCH_SIZE,
	EmbedError,
	type Embedder,
	chunkBatch,
	withRetry,
} from "./types.ts";

export interface LMStudioOptions {
	model: string;
	dimensions: number;
	baseUrl?: string;
	batchSize?: number;
	maxRetries?: number;
	baseDelayMs?: number;
	fetchImpl?: typeof fetch;
}

export const DEFAULT_LM_STUDIO_HOST = "http://localhost:1234";

interface EmbeddingItem {
	embedding: number[];
	index: number;
}

export function createLMStudioEmbedder(options: LMStudioOptions): Embedder {
	const baseUrl = (options.baseUrl ?? DEFAULT_LM_STUDIO_HOST).replace(/\/+$/, "");
	const batchSize = options.batchSize ?? EMBED_BATCH_SIZE;
	const fetchImpl = options.fetchImpl ?? fetch;

	async function embedBatch(
		texts: readonly string[],
		signal?: AbortSignal
	): Promise<number[][]> {
		const body = { model: options.model, input: texts };
		return withRetry(
			async () => {
				const response = await fetchImpl(`${baseUrl}/v1/embeddings`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
					signal,
				});
				const text = await response.text();
				if (response.status >= 500 || !response.ok) {
					throw new EmbedError(response.status, text);
				}
				const parsed = JSON.parse(text) as { data?: EmbeddingItem[] };
				const items = [...(parsed.data ?? [])].sort(
					(a, b) => a.index - b.index
				);
				if (items.length !== texts.length) {
					throw new Error(
						`lmstudio returned ${items.length} embeddings for ${texts.length} inputs`
					);
				}
				return items.map((item) => item.embedding);
			},
			{ maxRetries: options.maxRetries, signal, baseDelayMs: options.baseDelayMs }
		);
	}

	return {
		modelName: options.model,
		dimensions: options.dimensions,
		async embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
			if (texts.length === 0) {
				return [];
			}
			const out: number[][] = [];
			for (const batch of chunkBatch(texts, batchSize)) {
				out.push(...(await embedBatch(batch, signal)));
			}
			return out;
		},
	};
}
