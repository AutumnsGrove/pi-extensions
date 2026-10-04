/**
 * Embedding model registry, ported from lumen's `internal/models/models.go`.
 *
 * Dimensions and context length are configured per model; `minScore` is the
 * default noise floor for cosine similarity, and higher-dimensional spaces need
 * a lower floor (concentration of measure).
 */

export interface ModelSpec {
	dims: number;
	ctxLength: number;
	/** "ollama", "lmstudio", or undefined for both. */
	backend?: string;
	/** Default minimum cosine similarity for search. */
	minScore: number;
}

export const DEFAULT_OLLAMA_MODEL = "ordis/jina-embeddings-v2-base-code";
export const DEFAULT_LMSTUDIO_MODEL = "nomic-ai/nomic-embed-code-GGUF";
export const DEFAULT_MODEL = DEFAULT_OLLAMA_MODEL;

/** LM Studio exposes some models under different names than their repo id. */
export const MODEL_ALIASES: Record<string, string> = {
	"text-embedding-nomic-embed-code": "nomic-ai/nomic-embed-code-GGUF",
};

export const DEFAULT_MIN_SCORE = 0.2;

export const KNOWN_MODELS: Record<string, ModelSpec> = {
	"ordis/jina-embeddings-v2-base-code": {
		dims: 768,
		ctxLength: 8192,
		backend: "ollama",
		minScore: 0.35,
	},
	"nomic-embed-text": { dims: 768, ctxLength: 8192, backend: "ollama", minScore: 0.3 },
	"nomic-ai/nomic-embed-code-GGUF": {
		dims: 3584,
		ctxLength: 8192,
		backend: "lmstudio",
		minScore: 0.15,
	},
	"qwen3-embedding:8b": { dims: 4096, ctxLength: 40960, backend: "ollama", minScore: 0.3 },
	"qwen3-embedding:4b": { dims: 2560, ctxLength: 40960, backend: "ollama", minScore: 0.3 },
	"qwen3-embedding:0.6b": { dims: 1024, ctxLength: 32768, backend: "ollama", minScore: 0.3 },
	"all-minilm": { dims: 384, ctxLength: 512, backend: "ollama", minScore: 0.2 },
	"manutic/nomic-embed-code:7b": {
		dims: 3584,
		ctxLength: 32768,
		backend: "ollama",
		minScore: 0.15,
	},
};

export function canonicalModel(model: string): string {
	return MODEL_ALIASES[model] ?? model;
}

export function modelSpec(model: string): ModelSpec | undefined {
	return KNOWN_MODELS[canonicalModel(model)];
}

export function modelDimensions(model: string): number | undefined {
	return modelSpec(model)?.dims;
}

export function dimensionAwareMinScore(dims: number): number {
	if (dims > 3072) {
		return 0.15;
	}
	if (dims > 1024) {
		return 0.2;
	}
	if (dims > 512) {
		return 0.25;
	}
	return 0.2;
}

/** Resolve the default noise floor for a model + dimensionality. */
export function defaultMinScore(model: string, dimensions: number): number {
	const spec = modelSpec(model);
	if (spec && spec.minScore > 0) {
		return spec.minScore;
	}
	if (dimensions > 0) {
		return dimensionAwareMinScore(dimensions);
	}
	return DEFAULT_MIN_SCORE;
}
