/**
 * Vector store on `node:sqlite` + `sqlite-vec`.
 *
 * Ported from lumen's `internal/store` (single-collection flavour), extended
 * with domains: one database holds every indexed root of one domain, paths are
 * domain-relative, and a `roots` table records which slice of the tree each
 * indexed root owns together with its Merkle root.
 */

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
// `node:sqlite` is newer than Vite's builtin list, so load it through
// createRequire; the type-only import keeps full typing.
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { Chunk } from "../chunk/types.ts";
import { isPathUnder, normalizePrefix } from "../domains.ts";

const require = createRequire(import.meta.url);
const sqliteVec = require("sqlite-vec") as { getLoadablePath(): string };
type DatabaseSyncConstructor = new (
	path: string,
	options?: { allowExtension?: boolean }
) => DatabaseSync;
const { DatabaseSync: DatabaseSyncCtor } = require("node:sqlite") as {
	DatabaseSync: DatabaseSyncConstructor;
};

/** sqlite-vec's interior k limit for a KNN query. */
export const MAX_KNN = 4096;
/**
 * When a query is restricted to a subtree, the KNN scan has to look far past
 * `limit` rows and then discard the ones outside the subtree. Without the
 * over-fetch a search in a small package of a large domain returned nothing.
 */
const PREFIX_OVERFETCH = 32;
const PREFIX_MIN_KNN = 256;

export interface SearchResult {
	filePath: string;
	symbol: string;
	kind: string;
	startLine: number;
	endLine: number;
	/** Cosine distance (1 - cosine similarity). Lower is closer. */
	distance: number;
}

export interface StoreStats {
	totalFiles: number;
	totalChunks: number;
}

/** One indexed root's slice of the domain database. */
export interface RootRecord {
	/** Absolute realpath of the indexed root. */
	rootPath: string;
	/** Domain-relative prefix owned by this root; "" for the domain root. */
	rootPrefix: string;
	/** Merkle root of the root's subtree; "" until a run completes. */
	rootHash: string;
	lastIndexedAt?: string;
	/** Empty when the last run completed. */
	lastIndexError: string;
	embeddingModel?: string;
	totalFiles: number;
}

const ROOT_COLUMNS =
	"root_path, root_prefix, root_hash, last_indexed_at, last_index_error, embedding_model, total_files";

export function serializeFloat32(vector: readonly number[]): Uint8Array {
	const floats = new Float32Array(vector.length);
	for (let i = 0; i < vector.length; i += 1) {
		floats[i] = vector[i] ?? 0;
	}
	return new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength);
}

function rowNumber(row: Record<string, unknown>, key: string): number {
	const value = row[key];
	return typeof value === "number" ? value : Number(value ?? 0);
}

function rowString(row: Record<string, unknown>, key: string): string {
	const value = row[key];
	return typeof value === "string" ? value : String(value ?? "");
}

function rowOptionalString(
	row: Record<string, unknown>,
	key: string
): string | undefined {
	const value = row[key];
	return typeof value === "string" && value !== "" ? value : undefined;
}

function rootFromRow(row: Record<string, unknown>): RootRecord {
	return {
		rootPath: rowString(row, "root_path"),
		rootPrefix: normalizePrefix(rowString(row, "root_prefix")),
		rootHash: rowString(row, "root_hash"),
		lastIndexedAt: rowOptionalString(row, "last_indexed_at"),
		lastIndexError: rowString(row, "last_index_error"),
		embeddingModel: rowOptionalString(row, "embedding_model"),
		totalFiles: rowNumber(row, "total_files"),
	};
}

export class Store {
	readonly dimensions: number;
	/** Path of the database file, or ":memory:". */
	readonly path: string;
	/** Unique identity for in-process locking; one per open Store. */
	readonly identity: string;
	private readonly db: DatabaseSync;
	private closed = false;

	constructor(db: DatabaseSync, dimensions: number, path = ":memory:") {
		this.db = db;
		this.dimensions = dimensions;
		this.path = path;
		this.identity = path === ":memory:" ? randomUUID() : path;
	}

	/** Open (or create) a store at `path`; `:memory:` for tests. */
	static open(path: string, dimensions: number): Store {
		const db = new DatabaseSyncCtor(path, { allowExtension: true });
		db.exec("PRAGMA journal_mode = WAL");
		db.exec("PRAGMA synchronous = NORMAL");
		// Two pi processes may share a domain database; wait rather than throw
		// SQLITE_BUSY. The indexer's lock file keeps whole runs serialized.
		db.exec("PRAGMA busy_timeout = 5000");
		db.exec("PRAGMA foreign_keys = ON");
		db.enableLoadExtension(true);
		db.loadExtension(sqliteVec.getLoadablePath());
		const store = new Store(db, dimensions, path);
		store.createSchema();
		store.ensureVecDimensions();
		return store;
	}

	private createSchema(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS files (
				path TEXT PRIMARY KEY,
				hash TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS project_meta (
				key   TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS chunks (
				id         TEXT PRIMARY KEY,
				file_path  TEXT NOT NULL,
				symbol     TEXT NOT NULL,
				kind       TEXT NOT NULL,
				start_line INTEGER NOT NULL,
				end_line   INTEGER NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_chunks_file_path ON chunks(file_path);
			CREATE TABLE IF NOT EXISTS roots (
				root_path         TEXT PRIMARY KEY,
				root_prefix       TEXT NOT NULL DEFAULT '',
				root_hash         TEXT NOT NULL DEFAULT '',
				last_indexed_at   TEXT,
				last_index_error  TEXT,
				embedding_model   TEXT,
				total_files       INTEGER NOT NULL DEFAULT 0
			);
		`);
	}

	private ensureVecDimensions(): void {
		const exists = this.db
			.prepare(
				"SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'vec_chunks'"
			)
			.get() as Record<string, unknown>;
		if (rowNumber(exists, "n") === 0) {
			this.createVecTable();
			return;
		}
		const stored = this.getMeta("vec_dimensions");
		if (stored !== undefined && Number.parseInt(stored, 10) === this.dimensions) {
			return;
		}
		// Dimensions changed: drop the vector table and the chunks that point
		// into it, then recreate. Virtual tables cannot be altered in place.
		this.db.exec("DROP TABLE IF EXISTS vec_chunks");
		this.db.exec("DELETE FROM chunks");
		this.db.exec("DELETE FROM files");
		this.db.exec("DELETE FROM roots");
		this.db.exec("DELETE FROM project_meta WHERE key = 'vec_dimensions'");
		this.createVecTable();
	}

	private createVecTable(): void {
		this.db.exec(
			`CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
				id TEXT PRIMARY KEY,
				embedding float[${this.dimensions}] distance_metric=cosine
			)`
		);
		this.setMeta("vec_dimensions", String(this.dimensions));
	}

	setMeta(key: string, value: string): void {
		this.db
			.prepare(
				`INSERT INTO project_meta (key, value) VALUES (?, ?)
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value`
			)
			.run(key, value);
	}

	getMeta(key: string): string | undefined {
		const row = this.db
			.prepare("SELECT value FROM project_meta WHERE key = ?")
			.get(key) as Record<string, unknown> | undefined;
		return row ? rowString(row, "value") : undefined;
	}

	/* -------------------------------------------------------------- */
	/* Roots                                                           */
	/* -------------------------------------------------------------- */

	upsertRoot(record: RootRecord): void {
		this.db
			.prepare(
				`INSERT INTO roots (${ROOT_COLUMNS})
				 VALUES (?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(root_path) DO UPDATE SET
					root_prefix = excluded.root_prefix,
					root_hash = excluded.root_hash,
					last_indexed_at = excluded.last_indexed_at,
					last_index_error = excluded.last_index_error,
					embedding_model = excluded.embedding_model,
					total_files = excluded.total_files`
			)
			.run(
				record.rootPath,
				normalizePrefix(record.rootPrefix),
				record.rootHash,
				record.lastIndexedAt ?? null,
				record.lastIndexError ?? null,
				record.embeddingModel ?? null,
				record.totalFiles
			);
	}

	getRoot(rootPath: string): RootRecord | undefined {
		const row = this.db
			.prepare(`SELECT ${ROOT_COLUMNS} FROM roots WHERE root_path = ?`)
			.get(rootPath) as Record<string, unknown> | undefined;
		return row ? rootFromRow(row) : undefined;
	}

	listRoots(): RootRecord[] {
		const rows = this.db
			.prepare(`SELECT ${ROOT_COLUMNS} FROM roots ORDER BY root_path`)
			.all() as Record<string, unknown>[];
		return rows.map(rootFromRow);
	}

	deleteRoot(rootPath: string): void {
		this.db.prepare("DELETE FROM roots WHERE root_path = ?").run(rootPath);
	}

	/**
	 * Import the root metadata a version-1 database recorded for its directory
	 * (or a version-2 database imported from one). Only valid when the database
	 * was built for `rootPath` itself, which is what makes its root-relative
	 * paths domain-relative.
	 */
	adoptLegacyRoot(rootPath: string): boolean {
		if (this.getRoot(rootPath)) {
			return true;
		}
		const projectPath = this.getMeta("project_path");
		if (projectPath && projectPath !== rootPath) {
			return false;
		}
		const rootHash = this.getMeta("root_hash");
		if (!rootHash) {
			return false;
		}
		const totalFiles = Number.parseInt(this.getMeta("total_files") ?? "", 10);
		this.upsertRoot({
			rootPath,
			rootPrefix: "",
			rootHash,
			lastIndexedAt: this.getMeta("last_indexed_at"),
			lastIndexError: "",
			embeddingModel: this.getMeta("embedding_model"),
			totalFiles: Number.isFinite(totalFiles) ? totalFiles : 0,
		});
		return true;
	}

	/** Drop roots whose directory no longer exists, except `keep`. */
	pruneMissingRoots(keep: string, exists: (path: string) => boolean): string[] {
		const removed: string[] = [];
		for (const root of this.listRoots()) {
			if (root.rootPath === keep || exists(root.rootPath)) {
				continue;
			}
			this.deleteRoot(root.rootPath);
			removed.push(root.rootPath);
		}
		return removed;
	}

	/**
	 * Delete files (and their chunks) that no root covers any more. Run after a
	 * successful index: removing a root, or indexing a tree that dropped a
	 * subtree, leaves rows nothing references.
	 */
	collectGarbage(): number {
		const prefixes = this.listRoots().map((root) => root.rootPrefix);
		const paths = this.db
			.prepare("SELECT path FROM files")
			.all() as Record<string, unknown>[];
		let removed = 0;
		for (const row of paths) {
			const path = rowString(row, "path");
			if (prefixes.some((prefix) => isPathUnder(path, prefix))) {
				continue;
			}
			this.deleteFileChunks(path);
			removed += 1;
		}
		return removed;
	}

	/* -------------------------------------------------------------- */
	/* Files and chunks                                                */
	/* -------------------------------------------------------------- */

	upsertFile(path: string, hash: string): void {
		this.db
			.prepare(
				`INSERT INTO files (path, hash) VALUES (?, ?)
				 ON CONFLICT(path) DO UPDATE SET hash = excluded.hash`
			)
			.run(path, hash);
	}

	deleteFileChunks(filePath: string): void {
		this.transaction(() => {
			this.db
				.prepare(
					"DELETE FROM vec_chunks WHERE id IN (SELECT id FROM chunks WHERE file_path = ?)"
				)
				.run(filePath);
			this.db.prepare("DELETE FROM chunks WHERE file_path = ?").run(filePath);
			this.db.prepare("DELETE FROM files WHERE path = ?").run(filePath);
		});
	}

	/** Delete every file and chunk under a domain-relative prefix. */
	deletePrefix(prefix: string): number {
		const clean = normalizePrefix(prefix);
		const paths = this.getFileHashes(clean).keys();
		let removed = 0;
		this.transaction(() => {
			for (const path of paths) {
				this.db
					.prepare(
						"DELETE FROM vec_chunks WHERE id IN (SELECT id FROM chunks WHERE file_path = ?)"
					)
					.run(path);
				this.db.prepare("DELETE FROM chunks WHERE file_path = ?").run(path);
				this.db.prepare("DELETE FROM files WHERE path = ?").run(path);
				removed += 1;
			}
		});
		return removed;
	}

	/**
	 * Insert chunks and vectors. Callers must delete a file's existing chunks
	 * first; vec0 has no upsert, so duplicate ids within the batch are dropped
	 * and each vector is replaced explicitly. The delete-then-insert also makes
	 * writes idempotent if a previous partial or racing run left the id behind.
	 */
	insertChunks(chunks: readonly Chunk[], vectors: readonly number[][]): void {
		if (chunks.length !== vectors.length) {
			throw new Error(
				`chunks and vectors length mismatch: ${chunks.length} vs ${vectors.length}`
			);
		}
		const seen = new Set<string>();
		this.transaction(() => {
			const chunkStmt: StatementSync = this.db.prepare(
				`INSERT OR REPLACE INTO chunks (id, file_path, symbol, kind, start_line, end_line)
				 VALUES (?, ?, ?, ?, ?, ?)`
			);
			const vecStmt: StatementSync = this.db.prepare(
				"INSERT INTO vec_chunks (id, embedding) VALUES (?, ?)"
			);
			const vecDeleteStmt: StatementSync = this.db.prepare(
				"DELETE FROM vec_chunks WHERE id = ?"
			);
			for (let i = 0; i < chunks.length; i += 1) {
				const chunk = chunks[i];
				const vector = vectors[i];
				if (!chunk || !vector || seen.has(chunk.id)) {
					continue;
				}
				seen.add(chunk.id);
				chunkStmt.run(
					chunk.id,
					chunk.filePath,
					chunk.symbol,
					chunk.kind,
					chunk.startLine,
					chunk.endLine
				);
				vecDeleteStmt.run(chunk.id);
				vecStmt.run(chunk.id, serializeFloat32(vector));
			}
		});
	}

	/**
	 * KNN search, optionally restricted to a domain-relative prefix (a root's
	 * slice, and inside it a requested subtree).
	 */
	search(
		queryVec: readonly number[],
		limit: number,
		maxDistance: number | undefined,
		pathPrefix = ""
	): SearchResult[] {
		const blob = serializeFloat32(queryVec);
		const prefix = normalizePrefix(pathPrefix);
		const knn = prefix
			? Math.min(Math.max(limit * PREFIX_OVERFETCH, PREFIX_MIN_KNN), MAX_KNN)
			: limit;
		const where = ["v.embedding MATCH ?", "v.k = ?"];
		const args: Array<string | number | Uint8Array> = [blob, knn];
		if (maxDistance !== undefined) {
			where.push("v.distance <= ?");
			args.push(maxDistance);
		}
		if (prefix) {
			where.push("(c.file_path = ? OR c.file_path LIKE ? || '/%')");
			args.push(prefix, prefix);
		}
		args.push(limit);
		const rows = this.db
			.prepare(
				`SELECT c.file_path, c.symbol, c.kind, c.start_line, c.end_line, v.distance
				 FROM vec_chunks v
				 JOIN chunks c ON v.id = c.id
				 WHERE ${where.join(" AND ")}
				 ORDER BY v.distance
				 LIMIT ?`
			)
			.all(...args) as Record<string, unknown>[];
		return rows.map((row) => ({
			filePath: rowString(row, "file_path"),
			symbol: rowString(row, "symbol"),
			kind: rowString(row, "kind"),
			startLine: rowNumber(row, "start_line"),
			endLine: rowNumber(row, "end_line"),
			distance: rowNumber(row, "distance"),
		}));
	}

	/** Stored file hashes, optionally only those under a prefix. */
	getFileHashes(prefix = ""): Map<string, string> {
		const rows = this.db
			.prepare("SELECT path, hash FROM files")
			.all() as Record<string, unknown>[];
		const hashes = new Map<string, string>();
		for (const row of rows) {
			const path = rowString(row, "path");
			if (!isPathUnder(path, prefix)) {
				continue;
			}
			hashes.set(path, rowString(row, "hash"));
		}
		return hashes;
	}

	stats(prefix = ""): StoreStats {
		const clean = normalizePrefix(prefix);
		if (clean === "") {
			const row = this.db
				.prepare(
					"SELECT (SELECT count(*) FROM files) AS files, (SELECT count(*) FROM chunks) AS chunks"
				)
				.get() as Record<string, unknown>;
			return {
				totalFiles: rowNumber(row, "files"),
				totalChunks: rowNumber(row, "chunks"),
			};
		}
		const args = [clean, clean];
		void args;
		const row = this.db
			.prepare(
				`SELECT
					(SELECT count(*) FROM files WHERE path = ? OR path LIKE ? || '/%') AS files,
					(SELECT count(*) FROM chunks WHERE file_path = ? OR file_path LIKE ? || '/%') AS chunks`
			)
			.get(clean, clean, clean, clean) as Record<string, unknown>;
		return {
			totalFiles: rowNumber(row, "files"),
			totalChunks: rowNumber(row, "chunks"),
		};
	}

	topSymbols(limit: number, prefix = ""): string[] {
		const clean = normalizePrefix(prefix);
		const rows = clean
			? (this.db
					.prepare(
						`SELECT symbol FROM chunks WHERE file_path = ? OR file_path LIKE ? || '/%'
						 GROUP BY symbol ORDER BY count(*) DESC LIMIT ?`
					)
					.all(clean, clean, limit) as Record<string, unknown>[])
			: (this.db
					.prepare(
						"SELECT symbol FROM chunks GROUP BY symbol ORDER BY count(*) DESC LIMIT ?"
					)
					.all(limit) as Record<string, unknown>[]);
		return rows.map((row) => rowString(row, "symbol"));
	}

	hasSentinelFiles(prefix = ""): boolean {
		const clean = normalizePrefix(prefix);
		const row = clean
			? (this.db
					.prepare(
						`SELECT EXISTS(
							SELECT 1 FROM files
							WHERE hash = '' AND (path = ? OR path LIKE ? || '/%')
						) AS present`
					)
					.get(clean, clean) as Record<string, unknown>)
			: (this.db
					.prepare("SELECT EXISTS(SELECT 1 FROM files WHERE hash = '') AS present")
					.get() as Record<string, unknown>);
		return rowNumber(row, "present") === 1;
	}

	analyze(): void {
		this.db.exec("ANALYZE");
	}

	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.db.close();
	}

	private transaction<T>(fn: () => T): T {
		this.db.exec("BEGIN");
		try {
			const result = fn();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
}
