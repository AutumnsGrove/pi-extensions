/**
 * Vector store on `node:sqlite` + `sqlite-vec`.
 *
 * Ported from lumen's `internal/store` (single-collection flavour): a `files`
 * table for content hashes, a `chunks` table for metadata, and a `vec_chunks`
 * virtual table for cosine KNN. The shared/worktree collection model is not
 * ported — one database per project profile.
 */

import { createRequire } from "node:module";
// `node:sqlite` is newer than Vite's builtin list, so load it through
// createRequire; the type-only import keeps full typing.
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type { Chunk } from "../chunk/types.ts";

const require = createRequire(import.meta.url);
const sqliteVec = require("sqlite-vec") as { getLoadablePath(): string };
type DatabaseSyncConstructor = new (
	path: string,
	options?: { allowExtension?: boolean }
) => DatabaseSync;
const { DatabaseSync: DatabaseSyncCtor } = require("node:sqlite") as {
	DatabaseSync: DatabaseSyncConstructor;
};

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

export class Store {
	readonly dimensions: number;
	private readonly db: DatabaseSync;

	constructor(db: DatabaseSync, dimensions: number) {
		this.db = db;
		this.dimensions = dimensions;
	}

	/** Open (or create) a store at `path`; `:memory:` for tests. */
	static open(path: string, dimensions: number): Store {
		const db = new DatabaseSyncCtor(path, { allowExtension: true });
		db.exec("PRAGMA journal_mode = WAL");
		db.exec("PRAGMA synchronous = NORMAL");
		db.exec("PRAGMA foreign_keys = ON");
		db.enableLoadExtension(true);
		db.loadExtension(sqliteVec.getLoadablePath());
		const store = new Store(db, dimensions);
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

	search(
		queryVec: readonly number[],
		limit: number,
		maxDistance: number | undefined,
		pathPrefix = ""
	): SearchResult[] {
		const blob = serializeFloat32(queryVec);
		const knn = pathPrefix ? Math.min(limit * 3, 300) : limit;
		const where = ["v.embedding MATCH ?", "v.k = ?"];
		const args: Array<string | number | Uint8Array> = [blob, knn];
		if (maxDistance !== undefined) {
			where.push("v.distance <= ?");
			args.push(maxDistance);
		}
		if (pathPrefix) {
			where.push("(c.file_path = ? OR c.file_path LIKE ? || '/%')");
			args.push(pathPrefix, pathPrefix);
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

	getFileHashes(): Map<string, string> {
		const rows = this.db
			.prepare("SELECT path, hash FROM files")
			.all() as Record<string, unknown>[];
		const hashes = new Map<string, string>();
		for (const row of rows) {
			hashes.set(rowString(row, "path"), rowString(row, "hash"));
		}
		return hashes;
	}

	stats(): StoreStats {
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

	topSymbols(limit: number): string[] {
		const rows = this.db
			.prepare(
				"SELECT symbol FROM chunks GROUP BY symbol ORDER BY count(*) DESC LIMIT ?"
			)
			.all(limit) as Record<string, unknown>[];
		return rows.map((row) => rowString(row, "symbol"));
	}

	hasSentinelFiles(): boolean {
		const row = this.db
			.prepare("SELECT EXISTS(SELECT 1 FROM files WHERE hash = '') AS present")
			.get() as Record<string, unknown>;
		return rowNumber(row, "present") === 1;
	}

	analyze(): void {
		this.db.exec("ANALYZE");
	}

	close(): void {
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
