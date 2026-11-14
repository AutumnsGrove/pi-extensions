/**
 * Lazily builds and caches the embedder, chunkers, stores, and indexers.
 * Shared by the pi tools and commands so a session builds each expensive object
 * once.
 *
 * One store is opened per *domain* (repository or top-level root), and one
 * indexer per *root* (the directory the session was started in). A session in
 * `repo/pkg` therefore reuses the store and every chunk the repo root indexed.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { buildChunkers, type ChunkerSet } from "./chunk/index.ts";
import {
	loadConfigSafe,
	type EmbeddingProfile,
	type SearchConfig,
} from "./config.ts";
import {
	resolveIndexRoot,
	writeDomainMarker,
	type ResolvedIndexRoot,
} from "./domains.ts";
import { createOllamaEmbedder } from "./embed/ollama.ts";
import type { Embedder } from "./embed/types.ts";
import { Indexer, type ProgressFunc } from "./index/indexer.ts";
import {
	runSearch,
	type SearchRequest,
	type SearchResponse,
} from "./search/service.ts";
import { adoptLegacyDatabase } from "./store/migrate.ts";
import {
	executePrune,
	planPrune,
	type PrunePlan,
	type PruneReport,
} from "./store/prune.ts";
import { Store } from "./store/sqlite.ts";

type Env = Record<string, string | undefined>;

export interface EnsureResult {
	store: Store;
	indexer: Indexer;
	/** Which domain and prefix this root resolved to. */
	resolved: ResolvedIndexRoot;
}

export interface SearchManager {
	config: SearchConfig;
	/** Present when config loading failed and defaults were used. */
	readonly configError?: string;
	ensure(projectDir: string): Promise<EnsureResult>;
	search(
		projectDir: string,
		request: SearchRequest,
		signal?: AbortSignal,
		onProgress?: ProgressFunc
	): Promise<SearchResponse>;
	/** Plan (and optionally run) removal of databases the current build ignores. */
	prune(apply?: boolean): Promise<{ plan: PrunePlan; report?: PruneReport }>;
	close(): Promise<void>;
}

export class SemanticSearchManager implements SearchManager {
	readonly config: SearchConfig;
	readonly configError?: string;
	private readonly env: Env;
	private chunkers?: Promise<ChunkerSet>;
	private embedderInstance?: Embedder;
	private readonly entries = new Map<string, EnsureResult>();
	private readonly stores = new Map<string, Store>();
	private readonly inflight = new Set<Promise<unknown>>();

	constructor(config?: SearchConfig, env: Env = process.env) {
		this.env = env;
		if (config) {
			this.config = config;
			return;
		}
		const { config: loaded, error } = loadConfigSafe(env);
		this.config = loaded;
		this.configError = error;
	}

	/** The parts of the config that decide which vectors are compatible. */
	profile(): EmbeddingProfile {
		return {
			model: this.config.model,
			dimensions: this.config.dimensions,
			vectorStorage: this.config.vectorStorage,
			maxChunkTokens: this.config.maxChunkTokens,
		};
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

	async ensure(projectDir: string): Promise<EnsureResult> {
		return this.track(this.ensureEntry(projectDir));
	}

	private async ensureEntry(projectDir: string): Promise<EnsureResult> {
		const chunkers = await this.chunkersPromise();
		const resolved = resolveIndexRoot(projectDir, this.profile(), this.env);
		const existing = this.entries.get(resolved.rootPath);
		if (
			existing &&
			existing.resolved.dbPath === resolved.dbPath &&
			existing.resolved.rootPrefix === resolved.rootPrefix
		) {
			return existing;
		}
		if (existing) {
			// A new outer domain appeared; this root now lives somewhere else.
			this.releaseEntry(existing);
		}

		const store = this.openStore(resolved);
		const indexer = new Indexer({
			store,
			embedder: this.embedder(),
			chunkers,
			maxChunkTokens: this.config.maxChunkTokens,
			projectDir: resolved.rootPath,
			domainDir: resolved.domainPath,
			rootPrefix: resolved.rootPrefix,
			lockPath: store.path === ":memory:" ? undefined : `${store.path}.lock`,
		});
		const entry: EnsureResult = { store, indexer, resolved };
		this.entries.set(resolved.rootPath, entry);
		return entry;
	}

	private openStore(resolved: ResolvedIndexRoot): Store {
		const existing = this.stores.get(resolved.dbPath);
		if (existing) {
			return existing;
		}
		mkdirSync(dirname(resolved.dbPath), { recursive: true });
		const adopted = adoptLegacyDatabase({
			dbPath: resolved.dbPath,
			domainPath: resolved.domainPath,
			profile: this.profile(),
			env: this.env,
		});
		const store = Store.open(resolved.dbPath, this.config.dimensions);
		this.stores.set(resolved.dbPath, store);
		if (adopted) {
			// The old root hash still describes this directory, so the first run
			// only walks the tree instead of re-embedding anything.
			store.adoptLegacyRoot(resolved.domainPath);
		}
		writeDomainMarker(resolved.domainPath, this.profile(), this.env);
		return store;
	}

	private releaseEntry(entry: EnsureResult): void {
		this.entries.delete(entry.resolved.rootPath);
		const dbPath = entry.store.path;
		for (const other of this.entries.values()) {
			if (other.store.path === dbPath) {
				return;
			}
		}
		entry.store.close();
		this.stores.delete(dbPath);
	}

	private closeStores(): void {
		for (const store of this.stores.values()) {
			store.close();
		}
		this.stores.clear();
		this.entries.clear();
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
		const { store, indexer, resolved } = await this.ensureEntry(projectDir);
		return runSearch({
			store,
			embedder: this.embedder(),
			indexer,
			projectDir: resolved.rootPath,
			rootPrefix: resolved.rootPrefix,
			request,
			signal,
			onProgress,
		});
	}

	/**
	 * Plan (and with `apply`, run) removal of databases this build will never
	 * open again. Open handles are closed first so a database can be moved or
	 * deleted; the next ensure() reopens whatever survives.
	 */
	async prune(apply = false): Promise<{ plan: PrunePlan; report?: PruneReport }> {
		await Promise.allSettled([...this.inflight]);
		for (const entry of this.entries.values()) {
			await entry.indexer.whenIdle();
		}
		const plan = planPrune(this.profile(), this.env);
		if (!apply) {
			return { plan };
		}
		this.closeStores();
		const report = executePrune(plan, this.profile(), this.env);
		return { plan, report };
	}

	/**
	 * Drain in-flight indexing and searches, then close every store. Closing a
	 * shared connection while a run was mid-embed used to fail with a raw
	 * "database is not open"; await the work instead.
	 */
	async close(): Promise<void> {
		await Promise.allSettled([...this.inflight]);
		for (const entry of this.entries.values()) {
			await entry.indexer.whenIdle();
		}
		this.closeStores();
	}
}
