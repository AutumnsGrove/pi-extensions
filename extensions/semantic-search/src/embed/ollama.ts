/**
 * Ollama embedder. Ported from lumen's `internal/embedder/ollama.go`.
 *
 * Talks to `POST /api/embed` (batch) and retries transient failures.
 */

import {
	EMBED_BATCH_SIZE,
	EmbedDecodeError,
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
	/** Per-request timeout; 0 disables the timeout. */
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}

export const DEFAULT_OLLAMA_HOST = "http://localhost:11434";

/**
 * Per-request ceiling. Without one, a hung Ollama or a slow model load blocks
 * the tool call (and background indexing) forever with no way to recover.
 */
export const DEFAULT_EMBED_TIMEOUT_MS = 120_000;

export function createOllamaEmbedder(options: OllamaOptions): Embedder {
	const baseUrl = (options.baseUrl ?? DEFAULT_OLLAMA_HOST).replace(/\/+$/, "");
	const batchSize = options.batchSize ?? EMBED_BATCH_SIZE;
	const timeoutMs = options.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS;
	const fetchImpl = options.fetchImpl ?? fetch;

	/**
	 * Combine the caller's abort signal with a fresh timeout signal. A timeout
	 * is transient and may be retried; a caller abort propagates so retries stop.
	 */
	function requestSignal(signal?: AbortSignal): AbortSignal | undefined {
		if (timeoutMs <= 0) {
			return signal;
		}
		const timeout = AbortSignal.timeout(timeoutMs);
		return signal ? AbortSignal.any([signal, timeout]) : timeout;
	}

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
					signal: requestSignal(signal),
				});
				const text = await response.text();
				if (!response.ok) {
					throw new EmbedError(response.status, text);
				}
				let parsed: { embeddings?: unknown };
				try {
					parsed = JSON.parse(text) as { embeddings?: unknown };
				} catch {
					throw new EmbedDecodeError(
						`ollama returned invalid JSON: ${text.slice(0, 200)}`
					);
				}
				const vectors = parsed.embeddings;
				if (!Array.isArray(vectors) || vectors.length !== texts.length) {
					throw new EmbedDecodeError(
						`ollama returned ${Array.isArray(vectors) ? vectors.length : "no"} ` +
							`embeddings for ${texts.length} inputs`
					);
				}
				if (!vectors.every((vector) => Array.isArray(vector))) {
					throw new EmbedDecodeError("ollama returned a non-array embedding");
				}
				return vectors as number[][];
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
