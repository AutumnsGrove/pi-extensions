/**
 * Borrow `semantic-search`'s embedding stack when it is installed.
 *
 * Same Ollama model, same config file, same host as `semantic_search`, so a
 * machine already set up for code search needs no second setup. The import is
 * dynamic and guarded: pi-memory still works with keyword search alone when
 * the other extension (or Ollama) is absent.
 */

type Env = Record<string, string | undefined>;

export interface MemoryEmbedder {
	model: string;
	dimensions: number;
	minScore: number;
	embed(texts: readonly string[]): Promise<number[][]>;
}

export interface EmbedderResult {
	embedder?: MemoryEmbedder;
	error?: string;
}

export async function loadEmbedder(env: Env = process.env): Promise<EmbedderResult> {
	try {
		const [{ loadConfigSafe }, { createOllamaEmbedder }, registry] = await Promise.all([
			import("../semantic-search/src/config.ts"),
			import("../semantic-search/src/embed/ollama.ts"),
			import("../semantic-search/src/embed/registry.ts"),
		]);
		const { config, error } = loadConfigSafe(env);
		const minScore =
			registry.modelSpec(config.model)?.minScore ??
			registry.dimensionAwareMinScore(config.dimensions);
		const ollama = createOllamaEmbedder({
			model: config.model,
			dimensions: config.dimensions,
			contextLength: config.contextLength,
			baseUrl: config.baseUrl,
		});
		return {
			embedder: {
				model: config.model,
				dimensions: config.dimensions,
				minScore,
				embed: (texts) => ollama.embed(texts),
			},
			error,
		};
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		return { error: `semantic search unavailable (${message})` };
	}
}
