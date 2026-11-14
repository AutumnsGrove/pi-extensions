/**
 * Adopting version-1 databases.
 *
 * Version 1 keyed one database per invocation root and stored root-relative
 * paths. That is still correct for the *domain root* of a new-style database
 * (its paths are domain-relative by definition), so the first time a domain is
 * opened the old file is moved into place instead of being discarded. Model
 * vectors cost hours to rebuild; deleting them on upgrade would be rude.
 *
 * Child-root databases cannot be adopted (their paths are missing the domain
 * prefix) and are removed by {@link pruneIndexDatabases} once the domain
 * database covers them.
 */

import { createRequire } from "node:module";
import { existsSync, readdirSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	legacyDbPathForRoot,
	resolveProjectRoot,
	type EmbeddingProfile,
} from "../config.ts";

const require = createRequire(import.meta.url);
interface DatabaseSyncInstance {
	prepare(sql: string): {
		get(...args: unknown[]): unknown;
		all(...args: unknown[]): unknown[];
	};
	close(): void;
}
type DatabaseSyncConstructor = new (
	path: string,
	options?: { readOnly?: boolean }
) => DatabaseSyncInstance;
const { DatabaseSync: DatabaseSyncCtor } = require("node:sqlite") as {
	DatabaseSync: DatabaseSyncConstructor;
};

export interface LegacyMeta {
	projectPath?: string;
	rootHash?: string;
	embeddingModel?: string;
	totalFiles?: number;
	lastIndexedAt?: string;
	vecDimensions?: number;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Read a database's `project_meta` without creating schema, migrating it, or
 * touching WAL state. Returns undefined when the file is not a semantic-search
 * database at all (or cannot be opened).
 */
export function readLegacyMeta(dbPath: string): LegacyMeta | undefined {
	if (!existsSync(dbPath)) {
		return undefined;
	}
	let db: DatabaseSyncInstance | undefined;
	try {
		db = new DatabaseSyncCtor(dbPath, { readOnly: true });
		const rows = db
			.prepare("SELECT key, value FROM project_meta")
			.all() as Array<Record<string, unknown>>;
		const meta: Record<string, string> = {};
		for (const row of rows) {
			const key = stringValue(row.key);
			const value = typeof row.value === "string" ? row.value : "";
			if (key) {
				meta[key] = value;
			}
		}
		const totalFiles = Number.parseInt(meta.total_files ?? "", 10);
		const vecDimensions = Number.parseInt(meta.vec_dimensions ?? "", 10);
		return {
			projectPath: stringValue(meta.project_path),
			rootHash: stringValue(meta.root_hash),
			embeddingModel: stringValue(meta.embedding_model),
			totalFiles: Number.isFinite(totalFiles) ? totalFiles : undefined,
			lastIndexedAt: stringValue(meta.last_indexed_at),
			vecDimensions: Number.isFinite(vecDimensions) ? vecDimensions : undefined,
		};
	} catch {
		return undefined;
	} finally {
		try {
			db?.close();
		} catch {
			// Already closed.
		}
	}
}

/**
 * Move the version-1 database for `domainPath` to `dbPath` when it matches the
 * current embedding profile and was built for that exact directory. Returns
 * true when a database was adopted; the caller then imports its root metadata.
 */
export function adoptLegacyDatabase(options: {
	dbPath: string;
	domainPath: string;
	profile: EmbeddingProfile;
	env?: Record<string, string | undefined>;
}): boolean {
	const { dbPath, profile } = options;
	if (existsSync(dbPath)) {
		return false;
	}
	const domainPath = resolveProjectRoot(options.domainPath);
	const legacy = legacyDbPathForRoot(domainPath, profile, options.env);
	if (legacy === dbPath || !existsSync(legacy)) {
		return false;
	}
	const meta = readLegacyMeta(legacy);
	if (!meta) {
		return false;
	}
	// Only adopt a database that describes exactly this directory: its paths
	// are relative to that root, which is what makes them domain-relative.
	if (meta.projectPath && resolveProjectRoot(meta.projectPath) !== domainPath) {
		return false;
	}
	if (meta.vecDimensions !== undefined && meta.vecDimensions !== profile.dimensions) {
		return false;
	}
	// A crashed run can leave a lock file in an otherwise empty target
	// directory, and rename() refuses to replace a non-empty directory.
	const targetDir = dirname(dbPath);
	if (existsSync(targetDir)) {
		for (const entry of readdirSync(targetDir)) {
			if (entry.endsWith(".lock")) {
				try {
					unlinkSync(join(targetDir, entry));
				} catch {
					// Another process is using it; the rename will fail cleanly.
				}
			}
		}
	}
	try {
		renameSync(dirname(legacy), targetDir);
		return true;
	} catch {
		return false;
	}
}

/** Remove a database directory once it has been superseded. */
export function removeDatabaseDir(dbPath: string): void {
	try {
		rmSync(dirname(dbPath), { recursive: true, force: true });
	} catch {
		// Someone else got there first.
	}
}
