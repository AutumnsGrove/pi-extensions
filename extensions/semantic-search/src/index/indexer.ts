/**
 * Index orchestration, ported from lumen's `internal/index/index.go`: Merkle
 * diff -> chunk changed files -> split/merge -> embed in batches -> store ->
 * metadata.
 *
 * A run owns one *root* (the directory the session was started in) inside a
 * *domain* (the repository, or the top-level root indexed first). Paths are
 * stored domain-relative, so indexing a parent and then a child reuses every
 * chunk instead of embedding it twice; the run only diffs, deletes, and records
 * the slice belonging to its own root.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { SUPPORTED_EXTENSIONS, type ChunkerSet } from "../chunk/index.ts";
import type { Chunk } from "../chunk/types.ts";
import { joinPrefix, normalizePrefix, stripPrefix } from "../domains.ts";
import type { Embedder } from "../embed/types.ts";
import type { RootRecord, Store } from "../store/sqlite.ts";
import { makeSkip, type SkipFunc } from "./ignore.ts";
import { withFileLock } from "./lock.ts";
import { buildTree, diffFileMaps, type Tree } from "./merkle.ts";
import { mergeUndersizedChunks, splitOversizedChunks } from "./split.ts";

const CHUNK_BATCH_SIZE = 256;
const SUPPORTED_EXT_SET = new Set(SUPPORTED_EXTENSIONS);

/**
 * In-process serialization of index runs per database. Search, session startup,
 * and `/semsearch reindex` can all reach `ensureFresh`/`index` at once, and
 * interleaved runs against one store collide on the vec0 primary key. Keying by
 * the store identity also serializes two roots sharing one domain database.
 * Cross-process runs are serialized by {@link withFileLock}.
 */
const storeLocks = new Map<string, Promise<unknown>>();

async function withStoreLock<T>(identity: string, fn: () => Promise<T>): Promise<T> {
	const previous = storeLocks.get(identity) ?? Promise.resolve();
	const run = previous.then(fn, fn);
	// Keep the chain alive without ever leaking a rejected promise.
	const settled = run.then(
		() => undefined,
		() => undefined
	);
	storeLocks.set(identity, settled);
	try {
		return await run;
	} finally {
		if (storeLocks.get(identity) === settled) {
			storeLocks.delete(identity);
		}
	}
}

export type ProgressFunc = (current: number, total: number, message: string) => void;

export interface IndexStats {
	totalFiles: number;
	indexedFiles: number;
	chunksCreated: number;
	filesAdded: number;
	filesModified: number;
	filesRemoved: number;
	filesSkipped: number;
	filesChanged: number;
	reason: string;
}

export interface IndexerOptions {
	store: Store;
	embedder: Embedder;
	chunkers: ChunkerSet;
	maxChunkTokens: number;
	/** Directory being indexed. */
	projectDir: string;
	/** Domain root that owns the database. Defaults to `projectDir`. */
	domainDir?: string;
	/** POSIX path of `projectDir` inside `domainDir`. Defaults to "". */
	rootPrefix?: string;
	skip?: SkipFunc;
	/** Lock file next to the database for cross-process runs. */
	lockPath?: string;
	lockTimeoutMs?: number;
}

export interface EnsureFreshResult {
	reindexed: boolean;
	stats: IndexStats;
}

export interface IndexerStatus {
	totalFiles: number;
	totalChunks: number;
	embeddingModel?: string;
	lastIndexedAt?: string;
	lastIndexError?: string;
}

/** NUL byte in the first 8 KB is the same heuristic lumen uses. */
export function isBinaryContent(data: Buffer): boolean {
	const limit = Math.min(data.length, 8000);
	for (let i = 0; i < limit; i += 1) {
		if (data[i] === 0) {
			return true;
		}
	}
	return false;
}

function emptyStats(): IndexStats {
	return {
		totalFiles: 0,
		indexedFiles: 0,
		chunksCreated: 0,
		filesAdded: 0,
		filesModified: 0,
		filesRemoved: 0,
		filesSkipped: 0,
		filesChanged: 0,
		reason: "",
	};
}

export class Indexer {
	private readonly store: Store;
	private readonly embedder: Embedder;
	private readonly chunkers: ChunkerSet;
	private readonly maxChunkTokens: number;
	/** Root being indexed; also the key of its row in the `roots` table. */
	readonly rootDir: string;
	/** Domain that owns the database. */
	readonly domainDir: string;
	/** Domain-relative prefix owned by this root ("" for the domain root). */
	readonly rootPrefix: string;
	private readonly skip: SkipFunc;
	private readonly lockPath?: string;
	private readonly lockTimeoutMs?: number;

	constructor(options: IndexerOptions) {
		this.store = options.store;
		this.embedder = options.embedder;
		this.chunkers = options.chunkers;
		this.maxChunkTokens = options.maxChunkTokens;
		this.rootDir = options.projectDir;
		this.domainDir = options.domainDir ?? options.projectDir;
		this.rootPrefix = normalizePrefix(options.rootPrefix ?? "");
		this.skip = options.skip ?? makeSkip(this.domainDir, SUPPORTED_EXTENSIONS);
		this.lockPath = options.lockPath;
		this.lockTimeoutMs = options.lockTimeoutMs;
	}

	/** Backwards-compatible alias for {@link rootDir}. */
	get projectDir(): string {
		return this.rootDir;
	}

	/** Domain-relative path of a path relative to this root. */
	domainPath(relPath: string): string {
		return joinPrefix(this.rootPrefix, relPath);
	}

	private run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		return withStoreLock(this.store.identity, () =>
			withFileLock(this.lockPath, fn, {
				timeoutMs: this.lockTimeoutMs,
				signal,
			})
		);
	}

	/** Build the tree and re-index only when this root's hash changed. */
	async ensureFresh(
		progress?: ProgressFunc,
		signal?: AbortSignal
	): Promise<EnsureFreshResult> {
		return this.run(async () => {
			const tree = await buildTree(this.rootDir, this.skip, this.rootPrefix);
			const stored = this.store.getRoot(this.rootDir);
			if (this.claimsFresh(tree, stored)) {
				return { reindexed: false, stats: emptyStats() };
			}
			const stats = await this.indexWithTree(
				tree,
				stored?.rootHash ?? "",
				false,
				progress,
				signal
			);
			return { reindexed: true, stats };
		}, signal);
	}

	/** Index unconditionally; `force` reprocesses every file. */
	async index(
		force: boolean,
		progress?: ProgressFunc,
		signal?: AbortSignal
	): Promise<IndexStats> {
		return this.run(async () => {
			const tree = await buildTree(this.rootDir, this.skip, this.rootPrefix);
			const stored = this.store.getRoot(this.rootDir);
			return this.indexWithTree(
				tree,
				stored?.rootHash ?? "",
				force,
				progress,
				signal
			);
		}, signal);
	}

	private async indexWithTree(
		tree: Tree,
		oldRootHash: string,
		force: boolean,
		progress?: ProgressFunc,
		signal?: AbortSignal
	): Promise<IndexStats> {
		const stats = emptyStats();
		try {
			stats.totalFiles = tree.files.size;
			// The store holds every root of the domain; only this root's slice of
			// it may be diffed, rewritten, or removed by this run.
			const stored = this.store.getFileHashes(this.rootPrefix);
			const oldHashes = new Map<string, string>();
			for (const [path, hash] of stored) {
				const rel = stripPrefix(this.rootPrefix, path);
				if (rel !== "") {
					oldHashes.set(rel, hash);
				}
			}

			// Drop records for extensions we no longer index.
			for (const [rel] of oldHashes) {
				if (!SUPPORTED_EXT_SET.has(extname(rel))) {
					this.store.deleteFileChunks(this.domainPath(rel));
					oldHashes.delete(rel);
				}
			}

			let filesToIndex: string[];
			let filesToRemove: string[];
			if (force) {
				filesToIndex = [...tree.files.keys()];
				filesToRemove = [...oldHashes.keys()].filter((p) => !tree.files.has(p));
				stats.filesAdded = filesToIndex.length;
				stats.filesRemoved = filesToRemove.length;
				stats.reason = "force reindex requested";
			} else {
				const diff = diffFileMaps(oldHashes, tree.files);
				filesToIndex = [...diff.added, ...diff.modified];
				filesToRemove = diff.removed;
				stats.filesAdded = diff.added.length;
				stats.filesModified = diff.modified.length;
				stats.filesRemoved = diff.removed.length;
				stats.reason =
					oldRootHash === ""
						? "fresh index (no previous root hash)"
						: "root hash changed";
			}
			stats.filesChanged = filesToIndex.length + filesToRemove.length;

			for (const rel of filesToRemove) {
				this.store.deleteFileChunks(this.domainPath(rel));
			}

			let batch: Chunk[] = [];
			let pendingFiles: Array<{ path: string; hash: string }> = [];
			let totalChunks = 0;

			const flush = async (fileIndex: number): Promise<void> => {
				if (batch.length === 0) {
					return;
				}
				const texts = batch.map(
					(chunk) => `// ${chunk.filePath}\n${chunk.content}`
				);
				const vectors = await this.embedder.embed(texts, signal);
				for (const vector of vectors) {
					if (vector.length !== this.store.dimensions) {
						throw new Error(
							`embedding dimension mismatch: model "${this.embedder.modelName}" ` +
								`returned ${vector.length} values but the index expects ` +
								`${this.store.dimensions}. Re-select the model with /semsearch model.`
						);
					}
				}
				this.store.insertChunks(batch, vectors);
				totalChunks += batch.length;
				batch = [];
				if (progress) {
					progress(
						fileIndex,
						filesToIndex.length,
						`Embedded ${totalChunks} chunks so far`
					);
				}
			};

			for (let index = 0; index < filesToIndex.length; index += 1) {
				if (signal?.aborted) {
					throw new Error("indexing aborted");
				}
				const relPath = filesToIndex[index];
				if (relPath === undefined) {
					continue;
				}
				if (progress) {
					progress(
						index,
						filesToIndex.length,
						`Processing file ${index + 1}/${filesToIndex.length}: ${relPath}`
					);
				}
				let data: Buffer;
				try {
					data = await readFile(join(this.rootDir, relPath));
				} catch {
					// Permission denied or vanished: skip.
					stats.filesSkipped += 1;
					continue;
				}
				if (isBinaryContent(data)) {
					stats.filesSkipped += 1;
					continue;
				}

				// Chunk paths are domain-relative, so the same file gets the same
				// chunk ids (and vectors) no matter which root indexed it last.
				const domainPath = this.domainPath(relPath);
				this.store.deleteFileChunks(domainPath);
				// Sentinel hash keeps the chunk FK valid until the batch commits.
				this.store.upsertFile(domainPath, "");

				let chunks = this.chunkers.chunk(domainPath, data.toString("utf8"));
				// Chunkers emit rule-major (grouped by pattern), not source order.
				// Sort so splitting and merging see the file top to bottom.
				chunks.sort(
					(a, b) => a.startLine - b.startLine || a.endLine - b.endLine
				);
				chunks = splitOversizedChunks(chunks, this.maxChunkTokens);
				chunks = mergeUndersizedChunks(chunks);
				// Merging can produce chunks over the limit; keep each within budget.
				chunks = splitOversizedChunks(chunks, this.maxChunkTokens);

				batch.push(...chunks);
				pendingFiles.push({ path: domainPath, hash: tree.files.get(relPath) ?? "" });

				if (batch.length >= CHUNK_BATCH_SIZE) {
					await flush(index + 1);
					for (const pending of pendingFiles) {
						this.store.upsertFile(pending.path, pending.hash);
					}
					pendingFiles = [];
				}
			}

			await flush(filesToIndex.length);
			for (const pending of pendingFiles) {
				this.store.upsertFile(pending.path, pending.hash);
			}
			if (filesToIndex.length > 0) {
				this.store.analyze();
			}

			stats.indexedFiles = filesToIndex.length - stats.filesSkipped;
			stats.chunksCreated = totalChunks;
			this.saveMeta(tree, true);
			// A root whose directory disappeared no longer covers anything; its
			// rows go too unless another root still owns them. A root on an
			// unmounted volume keeps its row: the parent is missing as well.
			this.store.pruneMissingRoots(
				this.rootDir,
				(path) => existsSync(path) || !existsSync(dirname(path))
			);
			this.store.collectGarbage();
			if (progress && filesToIndex.length > 0) {
				progress(
					filesToIndex.length,
					filesToIndex.length,
					`Indexing complete: ${filesToIndex.length} files, ${totalChunks} chunks`
				);
			}
			return stats;
		} catch (error) {
			this.saveMeta(tree, false, error);
			throw error;
		}
	}

	private saveMeta(tree: Tree, success: boolean, error?: unknown): void {
		// Only a completed run may advance the root hash. Otherwise ensureFresh
		// would treat the tree as indexed and never retry the files whose batches
		// aborted, silently leaving gaps while reporting the index as fresh.
		const previous = this.store.getRoot(this.rootDir);
		const record: RootRecord = {
			rootPath: this.rootDir,
			rootPrefix: this.rootPrefix,
			rootHash: success ? tree.rootHash : "",
			lastIndexedAt: success
				? new Date().toISOString()
				: previous?.lastIndexedAt,
			lastIndexError: success
				? ""
				: error instanceof Error
					? error.message
					: String(error ?? ""),
			embeddingModel: this.embedder.modelName,
			totalFiles: tree.files.size,
		};
		this.store.upsertRoot(record);
	}

	/**
	 * Whether the stored index for this root is complete and matches the tree. A
	 * recorded error means a previous run aborted, so treat it as stale even if
	 * the root hash and file table look consistent (older versions advanced the
	 * hash on failure, leaving silent gaps that this re-indexes away).
	 */
	private claimsFresh(tree: Tree, stored: RootRecord | undefined): boolean {
		return (
			stored !== undefined &&
			stored.rootHash === tree.rootHash &&
			!this.store.hasSentinelFiles(this.rootPrefix) &&
			!stored.lastIndexError
		);
	}

	async isFresh(): Promise<boolean> {
		const tree = await buildTree(this.rootDir, this.skip, this.rootPrefix);
		return this.claimsFresh(tree, this.store.getRoot(this.rootDir));
	}

	/** Resolve once no index run for this database is queued or running. */
	async whenIdle(): Promise<void> {
		await (storeLocks.get(this.store.identity) ?? Promise.resolve());
	}

	lastIndexedAt(): Date | undefined {
		const raw = this.store.getRoot(this.rootDir)?.lastIndexedAt;
		if (!raw) {
			return undefined;
		}
		const parsed = Date.parse(raw);
		return Number.isFinite(parsed) ? new Date(parsed) : undefined;
	}

	/** Status for this root (not the whole domain). */
	status(): IndexerStatus {
		const root = this.store.getRoot(this.rootDir);
		const { totalFiles, totalChunks } = this.store.stats(this.rootPrefix);
		return {
			totalFiles,
			totalChunks,
			embeddingModel: root?.embeddingModel,
			lastIndexedAt: root?.lastIndexedAt,
			lastIndexError: root?.lastIndexError,
		};
	}
}
