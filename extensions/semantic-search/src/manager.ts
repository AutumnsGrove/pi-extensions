/**
 * Lazily builds and caches the embedder, chunkers, store, and indexer per
 * project. Shared by the pi tools and commands so a session builds each
 * expensive object once.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { buildChunkers, type ChunkerSet } from "./chunk/index.ts";
import {
	dbPathForProject,
	loadConfig,
	resolveProjectRoot,
	type SearchConfig,
} from "./config.ts";
import { createOllamaEmbedder } from "./embed/ollama.ts";
import type { Embedder } from "./embed/types.ts";
import { Indexer } from "./index/indexer.ts";
import {
	runSearch,
	type SearchRequest,
	type SearchResponse,
} from "./search/service.ts";
import { Store } from "./store/sqlite.ts";

export interface SearchManager {
	config: SearchConfig;
	ensure(projectDir: string): Promise<{ store: Store; indexer: Indexer }>;
	search(projectDir: string, request: SearchRequest): Promise<SearchResponse>;
	close(): void;
}

export class SemanticSearchManager implements SearchManager {
	readonly config: SearchConfig;
	private chunkers?: Promise<ChunkerSet>;
	private embedderInstance?: Embedder;
	private readonly entries = new Map<string, { store: Store; indexer: Indexer }>();

	constructor(config: SearchConfig = loadConfig()) {
		this.config = config;
	}

	private embedder(): Embedder {
		if (!this.embedderInstance) {
			this.embedderInstance = createOllamaEmbedder({
				model: this.config.model,
				dimensions: this.config.dimensions,
				contextLength: this.config.contextLength,
				baseUrl: this.config.baseUrl,
			});
		}
		return this.embedderInstance;
	}

	private chunkersPromise(): Promise<ChunkerSet> {
		this.chunkers ??= buildChunkers(this.config.maxChunkTokens);
		return this.chunkers;
	}

	async ensure(projectDir: string): Promise<{ store: Store; indexer: Indexer }> {
		const chunkers = await this.chunkersPromise();
		const root = resolveProjectRoot(projectDir);
		let entry = this.entries.get(root);
		if (!entry) {
			const dbPath = dbPathForProject({
				projectPath: root,
				model: this.config.model,
				dimensions: this.config.dimensions,
				vectorStorage: this.config.vectorStorage,
				maxChunkTokens: this.config.maxChunkTokens,
			});
			mkdirSync(dirname(dbPath), { recursive: true });
			const store = Store.open(dbPath, this.config.dimensions);
			const indexer = new Indexer({
				store,
				embedder: this.embedder(),
				chunkers,
				maxChunkTokens: this.config.maxChunkTokens,
				projectDir: root,
			});
			entry = { store, indexer };
			this.entries.set(root, entry);
		}
		return entry;
	}

	async search(projectDir: string, request: SearchRequest): Promise<SearchResponse> {
		const { store, indexer } = await this.ensure(projectDir);
		return runSearch({
			store,
			embedder: this.embedder(),
			indexer,
			projectDir: indexer.projectDir,
			request,
		});
	}

	close(): void {
		for (const entry of this.entries.values()) {
			entry.store.close();
		}
		this.entries.clear();
	}
}
