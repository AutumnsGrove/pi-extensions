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
	loadConfigSafe,
	resolveProjectRoot,
	type SearchConfig,
} from "./config.ts";
import { createOllamaEmbedder } from "./embed/ollama.ts";
import type { Embedder } from "./embed/types.ts";
import { Indexer, type ProgressFunc } from "./index/indexer.ts";
import {
	runSearch,
	type SearchRequest,
	type SearchResponse,
} from "./search/service.ts";
import { Store } from "./store/sqlite.ts";

export interface SearchManager {
	config: SearchConfig;
	/** Present when config loading failed and defaults were used. */
	readonly configError?: string;
	ensure(projectDir: string): Promise<{ store: Store; indexer: Indexer }>;
	search(
		projectDir: string,
		request: SearchRequest,
		signal?: AbortSignal,
		onProgress?: ProgressFunc
	): Promise<SearchResponse>;
	close(): Promise<void>;
}

export class SemanticSearchManager implements SearchManager {
	readonly config: SearchConfig;
	readonly configError?: string;
	private chunkers?: Promise<ChunkerSet>;
	private embedderInstance?: Embedder;
	private readonly entries = new Map<string, { store: Store; indexer: Indexer }>();
	private readonly inflight = new Set<Promise<unknown>>();

	constructor(config?: SearchConfig) {
		if (config) {
			this.config = config;
			return;
		}
		const { config: loaded, error } = loadConfigSafe();
		this.config = loaded;
		this.configError = error;
	}

	/** Track a promise so {@link close} can drain in-flight work before closing. */
	private track<T>(promise: Promise<T>): Promise<T> {
		this.inflight.add(promise);
		void promise.then(
			() => this.inflight.delete(promise),
			() => this.inflight.delete(promise)
		);
		return promise;
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
		return this.track(this.ensureEntry(projectDir));
	}

	private async ensureEntry(
		projectDir: string
	): Promise<{ store: Store; indexer: Indexer }> {
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

	async search(
		projectDir: string,
		request: SearchRequest,
		signal?: AbortSignal,
		onProgress?: ProgressFunc
	): Promise<SearchResponse> {
		return this.track(this.runQuery(projectDir, request, signal, onProgress));
	}

	private async runQuery(
		projectDir: string,
		request: SearchRequest,
		signal?: AbortSignal,
		onProgress?: ProgressFunc
	): Promise<SearchResponse> {
		const { store, indexer } = await this.ensureEntry(projectDir);
		return runSearch({
			store,
			embedder: this.embedder(),
			indexer,
			projectDir: indexer.projectDir,
			request,
			signal,
			onProgress,
		});
	}

	/**
	 * Drain in-flight indexing and searches, then close every store. Closing a
	 * shared connection while a run was mid-embed used to fail with a raw
	 * "database is not open"; await the work instead.
	 */
	async close(): Promise<void> {
		await Promise.allSettled([...this.inflight]);
		const entries = [...this.entries.values()];
		await Promise.all(entries.map((entry) => entry.indexer.whenIdle()));
		for (const entry of entries) {
			entry.store.close();
		}
		this.entries.clear();
	}
}
