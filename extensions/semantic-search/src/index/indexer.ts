/**
 * Index orchestration, ported from lumen's `internal/index/index.go` (the
 * single-collection path): Merkle diff -> chunk changed files -> split/merge ->
 * embed in batches -> store -> metadata.
 *
 * The shared/worktree collection model, donor seeding, and cross-process
 * locking are not ported.
 */

import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { SUPPORTED_EXTENSIONS, type ChunkerSet } from "../chunk/index.ts";
import type { Chunk } from "../chunk/types.ts";
import type { Embedder } from "../embed/types.ts";
import type { Store } from "../store/sqlite.ts";
import { makeSkip, type SkipFunc } from "./ignore.ts";
import { buildTree, diffTrees, type Tree } from "./merkle.ts";
import { mergeUndersizedChunks, splitOversizedChunks } from "./split.ts";

export const META_ROOT_HASH = "root_hash";
export const META_EMBEDDING_MODEL = "embedding_model";
export const META_PROJECT_PATH = "project_path";
export const META_TOTAL_FILES = "total_files";
export const META_LAST_INDEXED_AT = "last_indexed_at";
export const META_LAST_INDEX_ERROR = "last_index_error";

const CHUNK_BATCH_SIZE = 256;
const SUPPORTED_EXT_SET = new Set(SUPPORTED_EXTENSIONS);

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
	projectDir: string;
	skip?: SkipFunc;
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
	readonly projectDir: string;
	private readonly skip: SkipFunc;

	constructor(options: IndexerOptions) {
		this.store = options.store;
		this.embedder = options.embedder;
		this.chunkers = options.chunkers;
		this.maxChunkTokens = options.maxChunkTokens;
		this.projectDir = options.projectDir;
		this.skip = options.skip ?? makeSkip(options.projectDir, SUPPORTED_EXTENSIONS);
	}

	/** Build the tree and re-index only when the root hash changed. */
	async ensureFresh(progress?: ProgressFunc): Promise<EnsureFreshResult> {
		const tree = await buildTree(this.projectDir, this.skip);
		const storedHash = this.store.getMeta(META_ROOT_HASH) ?? "";
		if (storedHash === tree.rootHash && !this.store.hasSentinelFiles()) {
			return { reindexed: false, stats: emptyStats() };
		}
		const stats = await this.indexWithTree(tree, storedHash, false, progress);
		return { reindexed: true, stats };
	}

	/** Index unconditionally; `force` reprocesses every file. */
	async index(force: boolean, progress?: ProgressFunc): Promise<IndexStats> {
		const tree = await buildTree(this.projectDir, this.skip);
		const storedHash = this.store.getMeta(META_ROOT_HASH) ?? "";
		return this.indexWithTree(tree, storedHash, force, progress);
	}

	private async indexWithTree(
		tree: Tree,
		oldRootHash: string,
		force: boolean,
		progress?: ProgressFunc
	): Promise<IndexStats> {
		const stats = emptyStats();
		try {
			stats.totalFiles = tree.files.size;
			const oldHashes = this.store.getFileHashes();

			// Drop records for extensions we no longer index.
			for (const path of [...oldHashes.keys()]) {
				if (!SUPPORTED_EXT_SET.has(extname(path))) {
					this.store.deleteFileChunks(path);
					oldHashes.delete(path);
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
				const diff = diffTrees({ rootHash: "", files: oldHashes }, tree);
				filesToIndex = [...diff.added, ...diff.modified];
				filesToRemove = diff.removed;
				stats.filesAdded = diff.added.length;
				stats.filesModified = diff.modified.length;
				stats.filesRemoved = diff.removed.length;
				stats.reason =
					oldRootHash === "" ? "fresh index (no previous root hash)" : "root hash changed";
			}
			stats.filesChanged = filesToIndex.length + filesToRemove.length;

			for (const path of filesToRemove) {
				this.store.deleteFileChunks(path);
			}

			let batch: Chunk[] = [];
			let pendingFiles: Array<{ relPath: string; hash: string }> = [];
			let totalChunks = 0;

			const flush = async (fileIndex: number): Promise<void> => {
				if (batch.length === 0) {
					return;
				}
				const texts = batch.map(
					(chunk) => `// ${chunk.filePath}\n${chunk.content}`
				);
				const vectors = await this.embedder.embed(texts);
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
					data = await readFile(join(this.projectDir, relPath));
				} catch {
					// Permission denied or vanished: skip.
					continue;
				}
				if (isBinaryContent(data)) {
					continue;
				}

				this.store.deleteFileChunks(relPath);
				// Sentinel hash keeps the chunk FK valid until the batch commits.
				this.store.upsertFile(relPath, "");

				let chunks = this.chunkers.chunk(relPath, data.toString("utf8"));
				chunks = splitOversizedChunks(chunks, this.maxChunkTokens);
				chunks = mergeUndersizedChunks(chunks);
				// Merging can produce chunks over the limit; keep each within budget.
				chunks = splitOversizedChunks(chunks, this.maxChunkTokens);

				batch.push(...chunks);
				pendingFiles.push({ relPath, hash: tree.files.get(relPath) ?? "" });

				if (batch.length >= CHUNK_BATCH_SIZE) {
					await flush(index + 1);
					for (const pending of pendingFiles) {
						this.store.upsertFile(pending.relPath, pending.hash);
					}
					pendingFiles = [];
				}
			}

			await flush(filesToIndex.length);
			for (const pending of pendingFiles) {
				this.store.upsertFile(pending.relPath, pending.hash);
			}
			if (filesToIndex.length > 0) {
				this.store.analyze();
			}

			stats.indexedFiles = filesToIndex.length - stats.filesSkipped;
			stats.chunksCreated = totalChunks;
			this.saveMeta(tree, true);
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
		this.store.setMeta(META_ROOT_HASH, tree.rootHash);
		this.store.setMeta(META_EMBEDDING_MODEL, this.embedder.modelName);
		this.store.setMeta(META_PROJECT_PATH, this.projectDir);
		this.store.setMeta(META_TOTAL_FILES, String(tree.files.size));
		this.store.setMeta(
			META_LAST_INDEX_ERROR,
			success ? "" : error instanceof Error ? error.message : String(error ?? "")
		);
		if (success) {
			this.store.setMeta(META_LAST_INDEXED_AT, new Date().toISOString());
		}
	}

	async isFresh(): Promise<boolean> {
		const tree = await buildTree(this.projectDir, this.skip);
		const storedHash = this.store.getMeta(META_ROOT_HASH) ?? "";
		return storedHash === tree.rootHash && !this.store.hasSentinelFiles();
	}

	lastIndexedAt(): Date | undefined {
		const raw = this.store.getMeta(META_LAST_INDEXED_AT);
		if (!raw) {
			return undefined;
		}
		const parsed = Date.parse(raw);
		return Number.isFinite(parsed) ? new Date(parsed) : undefined;
	}

	status(): IndexerStatus {
		const { totalFiles, totalChunks } = this.store.stats();
		return {
			totalFiles,
			totalChunks,
			embeddingModel: this.store.getMeta(META_EMBEDDING_MODEL),
			lastIndexedAt: this.store.getMeta(META_LAST_INDEXED_AT),
			lastIndexError: this.store.getMeta(META_LAST_INDEX_ERROR),
		};
	}
}
