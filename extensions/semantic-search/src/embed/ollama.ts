/**
 * Ollama embedder. Ported from lumen's `internal/embedder/ollama.go`.
 *
 * Talks to `POST /api/embed` (batch) and retries transient failures.
 */

import {
	EMBED_BATCH_SIZE,
	EmbedError,
	type Embedder,
	chunkBatch,
	withRetry,
} from "./types.ts";

export interface OllamaOptions {
	model: string;
	dimensions: number;
	contextLength?: number;
	baseUrl?: string;
	batchSize?: number;
	maxRetries?: number;
	baseDelayMs?: number;
	fetchImpl?: typeof fetch;
}

export const DEFAULT_OLLAMA_HOST = "http://localhost:11434";

export function createOllamaEmbedder(options: OllamaOptions): Embedder {
	const baseUrl = (options.baseUrl ?? DEFAULT_OLLAMA_HOST).replace(/\/+$/, "");
	const batchSize = options.batchSize ?? EMBED_BATCH_SIZE;
	const fetchImpl = options.fetchImpl ?? fetch;

	async function embedBatch(
		texts: readonly string[],
		signal?: AbortSignal
	): Promise<number[][]> {
		const body: Record<string, unknown> = {
			model: options.model,
			input: texts,
		};
		if (options.contextLength && options.contextLength > 0) {
			body.options = { num_ctx: options.contextLength };
		}
		return withRetry(
			async () => {
				const response = await fetchImpl(`${baseUrl}/api/embed`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
					signal,
				});
				const text = await response.text();
				if (response.status >= 500 || !response.ok) {
					throw new EmbedError(response.status, text);
				}
				const parsed = JSON.parse(text) as { embeddings?: number[][] };
				const vectors = parsed.embeddings ?? [];
				if (vectors.length !== texts.length) {
					throw new Error(
						`ollama returned ${vectors.length} embeddings for ${texts.length} inputs`
					);
				}
				return vectors;
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
