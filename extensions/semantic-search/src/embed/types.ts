/**
 * Embedder interface and shared helpers.
 *
 * Ported from lumen's `internal/embedder/embedder.go`. Batching and retry
 * behaviour lives in the concrete backends.
 */

export interface Embedder {
	readonly modelName: string;
	readonly dimensions: number;
	/** Embed texts, preserving input order. */
	embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]>;
}

/** HTTP error returned by an embedding backend. */
export class EmbedError extends Error {
	readonly statusCode: number;

	constructor(statusCode: number, message: string) {
		super(`embed error (HTTP ${statusCode}): ${message}`);
		this.name = "EmbedError";
		this.statusCode = statusCode;
	}
}

/**
 * A response that is structurally wrong (bad JSON, wrong embedding count).
 * Retrying cannot fix it, so it is never treated as transient.
 */
export class EmbedDecodeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EmbedDecodeError";
	}
}

export const EMBED_BATCH_SIZE = 32;
export const EMBED_MAX_RETRIES = 3;

export function chunkBatch<T>(items: readonly T[], size = EMBED_BATCH_SIZE): T[][] {
	if (!Number.isInteger(size) || size < 1) {
		throw new Error(`invalid embed batch size: ${size}`);
	}
	const batches: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		batches.push(items.slice(i, i + size));
	}
	return batches;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
	new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("aborted"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(new Error("aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});

/**
 * Retry an async operation with exponential backoff (100ms, 200ms, 400ms…).
 * Transient failures are network errors and 5xx responses. 4xx is not retried.
 */
export async function withRetry<T>(
	operation: () => Promise<T>,
	options: {
		maxRetries?: number;
		signal?: AbortSignal;
		baseDelayMs?: number;
	} = {}
): Promise<T> {
	const maxRetries = options.maxRetries ?? EMBED_MAX_RETRIES;
	const baseDelay = options.baseDelayMs ?? 100;
	let lastError: unknown;
	for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
		if (options.signal?.aborted) {
			throw new Error("aborted");
		}
		try {
			return await operation();
		} catch (error) {
			lastError = error;
			const retryable = isRetryable(error);
			if (!retryable || attempt === maxRetries) {
				throw error;
			}
			await sleep(baseDelay * 2 ** attempt, options.signal);
		}
	}
	throw lastError;
}

export function isRetryable(error: unknown): boolean {
	if (error instanceof EmbedError) {
		return error.statusCode >= 500;
	}
	// A structurally-invalid response is deterministic; retrying is pointless.
	if (error instanceof EmbedDecodeError) {
		return false;
	}
	// Network / abort errors surface as TypeError or similar; retry them.
	return true;
}
