/**
 * Index database housekeeping: adopt what is still useful, delete the rest.
 *
 * After the move to shared domains, a machine can hold three kinds of database
 * that the current build will never open again:
 *   - version-1 databases keyed by invocation root (no domain marker),
 *   - databases for a root that now lives inside another indexed root,
 *   - databases whose domain no longer exists.
 *
 * Prune never guesses: it reads each database's recorded `project_path` and
 * domain roots, keeps the outermost domain, and only deletes a nested database
 * when the outer one provably holds a root covering it.
 */

import { createRequire } from "node:module";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	INDEX_VERSION,
	dataDir,
	dbPathForDomain,
	legacyDbPathForRoot,
	profileSignature,
	resolveProjectRoot,
	type EmbeddingProfile,
} from "../config.ts";
import {
	escapeLikePattern,
	invalidateDomainCache,
	isPathInside,
	listDomainMarkers,
	naturalDomain,
	relativePrefix,
	removeDomainMarker,
	writeDomainMarker,
	type DomainMarker,
} from "../domains.ts";
import { adoptLegacyDatabase, readLegacyMeta, removeDatabaseDir } from "./migrate.ts";
import { Store } from "./sqlite.ts";

type Env = Record<string, string | undefined>;

const require = createRequire(import.meta.url);
type ReadOnlyDatabase = {
	prepare(sql: string): { all(...args: unknown[]): unknown[] };
	close(): void;
};
const { DatabaseSync: DatabaseSyncCtor } = require("node:sqlite") as {
	DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => ReadOnlyDatabase;
};

export interface DatabaseEntry {
	dbPath: string;
	/** Bytes on disk, including WAL and SHM files. */
	bytes: number;
}

export type PruneKind = "delete" | "adopt" | "remap";

export interface PruneAction {
	kind: PruneKind;
	dbPath: string;
	bytes: number;
	/** Human-readable reason, shown by `/semsearch prune`. */
	reason: string;
	/** For `adopt`/`remap`: the domain the database now serves. */
	domainPath?: string;
}

export interface PrunePlan {
	actions: PruneAction[];
	freedBytes: number;
	kept: number;
}

export interface PruneReport {
	deleted: number;
	adopted: number;
	freedBytes: number;
}

/** Every `index.db` under the data directory. */
export function listIndexDatabases(env: Env = process.env): DatabaseEntry[] {
	const root = dataDir(env);
	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch {
		return [];
	}
	const out: DatabaseEntry[] = [];
	for (const entry of entries) {
		const dbPath = join(root, entry, "index.db");
		if (!existsSync(dbPath)) {
			continue;
		}
		let bytes = 0;
		for (const suffix of ["", "-wal", "-shm"]) {
			try {
				bytes += statSync(`${dbPath}${suffix}`).size;
			} catch {
				// Missing sidecar.
			}
		}
		out.push({ dbPath, bytes });
	}
	return out.sort((a, b) => b.bytes - a.bytes);
}

/**
 * Whether an outer database actually holds rows for `innerDomain`. Root rows
 * alone are not enough: a `.gitignore` in the domain can exclude a nested
 * repository from the parent's walk even though the parent covers the tree.
 */
function databaseCovers(
	dbPath: string,
	outerDomain: string,
	innerDomain: string
): boolean {
	if (!existsSync(dbPath)) {
		return false;
	}
	const innerPrefix = relativePrefix(outerDomain, innerDomain);
	let db: ReadOnlyDatabase | undefined;
	try {
		db = new DatabaseSyncCtor(dbPath, { readOnly: true });
		const row = db
			.prepare(
				`SELECT EXISTS(
					SELECT 1 FROM files
					 WHERE path = ? OR path LIKE ? || '/%' ESCAPE '\\'
				) AS present`
			)
			.all(innerPrefix, escapeLikePattern(innerPrefix)) as Array<
				Record<string, unknown>
			>;
		return row.some((entry) => Number(entry.present ?? 0) === 1);
	} catch {
		return false;
	} finally {
		try {
			db?.close();
		} catch {
			// Already closed.
		}
	}
}

/**
 * Decide what to do with every database on disk for one embedding profile.
 * Reads the filesystem, writes nothing.
 */
export function planPrune(
	profile: EmbeddingProfile,
	env: Env = process.env
): PrunePlan {
	const signature = profileSignature(profile);
	const actions: PruneAction[] = [];
	const databases = listIndexDatabases(env);

	const markerByDb = new Map<string, { path: string; marker: DomainMarker }>();
	for (const entry of listDomainMarkers(env)) {
		markerByDb.set(entry.marker.dbPath, entry);
	}

	const live: Array<{ marker: DomainMarker; bytes: number }> = [];
	/** Stale-format databases whose domain survives in a fresh file. */
	let remapped = 0;
	const adoptionCandidates: Array<{ entry: DatabaseEntry; domainPath: string }> = [];
	/** Version-1 databases for a root inside a domain (repo subdirectory). */
	const legacyChildren: Array<{
		entry: DatabaseEntry;
		rootPath: string;
		domain: string;
	}> = [];

	for (const entry of databases) {
		const known = markerByDb.get(entry.dbPath);
		if (known) {
			if (known.marker.profile !== signature) {
				// Another model's database; the user may switch back to it.
				continue;
			}
			if (known.marker.indexVersion === INDEX_VERSION) {
				live.push({ marker: known.marker, bytes: entry.bytes });
				continue;
			}
			// Stale marker for this profile: the domain survives, the file does
			// not. Rewrite the marker and delete the old database below.
			actions.push({
				kind: "remap",
				dbPath: entry.dbPath,
				bytes: entry.bytes,
				reason: `database format v${known.marker.indexVersion} (current: v${INDEX_VERSION})`,
				domainPath: known.marker.domainPath,
			});
			remapped += 1;
			continue;
		}

		const meta = readLegacyMeta(entry.dbPath);
		if (!meta?.projectPath) {
			actions.push({
				kind: "delete",
				dbPath: entry.dbPath,
				bytes: entry.bytes,
				reason: "not a semantic-search database",
			});
			continue;
		}
		const rootPath = resolveProjectRoot(meta.projectPath);
		// Identity, not similarity: only the exact version-1 path this profile
		// would have written is ours to move or delete. Another model that
		// happens to share the dimensionality lives at a different path and
		// must be left alone.
		if (entry.dbPath !== legacyDbPathForRoot(rootPath, profile, env)) {
			continue;
		}
		if (meta.vecDimensions !== undefined && meta.vecDimensions !== profile.dimensions) {
			continue;
		}
		const domain = naturalDomain(rootPath);
		if (domain !== rootPath) {
			legacyChildren.push({ entry, rootPath, domain });
			continue;
		}
		adoptionCandidates.push({ entry, domainPath: rootPath });
	}

	// Nested live domains: keep the outermost one when it provably covers the
	// inner one, otherwise leave both alone.
	const sortedLive = [...live].sort(
		(a, b) => a.marker.domainPath.length - b.marker.domainPath.length
	);
	const keptLive: typeof live = [];
	for (const entry of sortedLive) {
		const outer = keptLive.find((candidate) =>
			isPathInside(entry.marker.domainPath, candidate.marker.domainPath)
		);
		if (
			outer &&
			databaseCovers(outer.marker.dbPath, outer.marker.domainPath, entry.marker.domainPath)
		) {
			actions.push({
				kind: "delete",
				dbPath: entry.marker.dbPath,
				bytes: entry.bytes,
				reason: `covered by the domain database for ${outer.marker.domainPath}`,
				domainPath: outer.marker.domainPath,
			});
			continue;
		}
		keptLive.push(entry);
	}

	// Version-1 domains: never adopt one whose directory is gone, and keep only
	// the outermost (an inner one is covered by it).
	const existing = adoptionCandidates.filter((candidate) => {
		if (existsSync(candidate.domainPath)) {
			return true;
		}
		actions.push({
			kind: "delete",
			dbPath: candidate.entry.dbPath,
			bytes: candidate.entry.bytes,
			reason: `${candidate.domainPath} no longer exists`,
		});
		return false;
	});
	const keepers: Array<{ dbPath: string; domainPath: string }> = keptLive.map((entry) => ({
		dbPath: entry.marker.dbPath,
		domainPath: entry.marker.domainPath,
	}));
	// Ancestors first, so a survivor can already be tested as a keeper.
	const sortedCandidates = [...existing].sort(
		(a, b) => a.domainPath.length - b.domainPath.length
	);
	for (const candidate of sortedCandidates) {
		// This profile already has a current database for the same domain: the
		// version-1 file is superseded, not adopting it.
		if (keepers.some((keeper) => keeper.domainPath === candidate.domainPath)) {
			actions.push({
				kind: "delete",
				dbPath: candidate.entry.dbPath,
				bytes: candidate.entry.bytes,
				reason: `superseded by the current database for ${candidate.domainPath}`,
				domainPath: candidate.domainPath,
			});
			continue;
		}
		// A surviving domain above it only wins when it provably holds rows under
		// this root. Otherwise this database is the only copy of those vectors, so
		// it is adopted as its own domain instead of deleted.
		const cover = keepers.find(
			(keeper) =>
				keeper.domainPath !== candidate.domainPath &&
				isPathInside(candidate.domainPath, keeper.domainPath) &&
				databaseCovers(keeper.dbPath, keeper.domainPath, candidate.domainPath)
		);
		if (cover) {
			actions.push({
				kind: "delete",
				dbPath: candidate.entry.dbPath,
				bytes: candidate.entry.bytes,
				reason: `${candidate.domainPath} is covered by ${cover.domainPath}`,
				domainPath: cover.domainPath,
			});
			continue;
		}
		actions.push({
			kind: "adopt",
			dbPath: candidate.entry.dbPath,
			bytes: candidate.entry.bytes,
			reason: `version-1 database for ${candidate.domainPath}`,
			domainPath: candidate.domainPath,
		});
		keepers.push({
			dbPath: candidate.entry.dbPath,
			domainPath: candidate.domainPath,
		});
	}

	// Child roots: delete only when a surviving domain database provably holds
	// the subtree. Otherwise adopt the child as its own domain — its paths are
	// already relative to that root, so nothing is re-embedded.
	for (const child of legacyChildren) {
		const cover = keepers.find(
			(keeper) =>
				keeper.domainPath !== child.rootPath &&
				isPathInside(child.rootPath, keeper.domainPath) &&
				databaseCovers(keeper.dbPath, keeper.domainPath, child.rootPath)
		);
		if (cover) {
			actions.push({
				kind: "delete",
				dbPath: child.entry.dbPath,
				bytes: child.entry.bytes,
				reason: `${child.rootPath} is covered by ${cover.domainPath}`,
				domainPath: cover.domainPath,
			});
			continue;
		}
		// Nothing above it holds these rows: keep them as their own domain.
		actions.push({
			kind: "adopt",
			dbPath: child.entry.dbPath,
			bytes: child.entry.bytes,
			reason: `version-1 database for ${child.rootPath} (${child.domain} does not cover it)`,
			domainPath: child.rootPath,
		});
		keepers.push({ dbPath: child.entry.dbPath, domainPath: child.rootPath });
	}

	const freedBytes = actions
		.filter((action) => action.kind === "delete")
		.reduce((sum, action) => sum + action.bytes, 0);
	return {
		actions,
		freedBytes,
		// Databases that survive as live domains after the prune runs.
		kept: keepers.length + remapped,
	};
}

/** Execute a plan produced by {@link planPrune}. */
export function executePrune(
	plan: PrunePlan,
	profile: EmbeddingProfile,
	env: Env = process.env
): PruneReport {
	let deleted = 0;
	let adopted = 0;
	let freedBytes = 0;
	for (const action of plan.actions) {
		if (action.kind === "delete") {
			// Drop the marker first: a database without a marker is an orphan the
			// next prune deletes, while a marker without a database would make
			// resolveIndexRoot() recreate a fresh nested index and re-embed.
			for (const entry of listDomainMarkers(env)) {
				if (entry.marker.dbPath === action.dbPath) {
					removeDomainMarker(entry.path);
				}
			}
			removeDatabaseDir(action.dbPath);
			deleted += 1;
			freedBytes += action.bytes;
			continue;
		}
		if (action.kind === "adopt" && action.domainPath) {
			const dbPath = dbPathForDomain(action.domainPath, profile, env);
			if (!adoptLegacyDatabase({ dbPath, domainPath: action.domainPath, profile, env })) {
				if (existsSync(dbPath)) {
					// A current database already exists for this domain; the old file
					// is superseded rather than adopted.
					removeDatabaseDir(action.dbPath);
					deleted += 1;
					freedBytes += action.bytes;
				}
				continue;
			}
			writeDomainMarker(action.domainPath, profile, env);
			// Leave the moved database usable immediately: create the current
			// schema and import the old root row, so a later run from a child root
			// cannot see an empty domain and collect the adopted rows.
			const store = Store.open(dbPath, profile.dimensions);
			store.adoptLegacyRoot(resolveProjectRoot(action.domainPath));
			store.close();
			adopted += 1;
			// Drop the marker that pointed at the now-moved file, if any.
			for (const entry of listDomainMarkers(env)) {
				if (
					entry.marker.dbPath === action.dbPath &&
					entry.marker.domainPath === action.domainPath
				) {
					removeDomainMarker(entry.path);
				}
			}
			continue;
		}
		if (action.kind === "remap" && action.domainPath) {
			const marker = writeDomainMarker(action.domainPath, profile, env);
			// Delete the old file only after the marker points somewhere else.
			if (marker.dbPath !== action.dbPath) {
				removeDatabaseDir(action.dbPath);
				deleted += 1;
				freedBytes += action.bytes;
			}
		}
	}
	invalidateDomainCache();
	return { deleted, adopted, freedBytes };
}
