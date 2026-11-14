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
	profileSignature,
	resolveProjectRoot,
	type EmbeddingProfile,
} from "../config.ts";
import {
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
					SELECT 1 FROM files WHERE path = ? OR path LIKE ? || '/%'
				) AS present`
			)
			.all(innerPrefix, innerPrefix) as Array<Record<string, unknown>>;
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
	const markers = listDomainMarkers(env);
	const actions: PruneAction[] = [];
	const databases = listIndexDatabases(env);

	const markerByDb = new Map<string, { path: string; marker: DomainMarker }>();
	for (const entry of markers) {
		markerByDb.set(entry.marker.dbPath, entry);
	}

	const live: Array<{ path: string; marker: DomainMarker; bytes: number }> = [];
	const adoptionCandidates: Array<{
		entry: DatabaseEntry;
		domainPath: string;
	}> = [];

	for (const entry of databases) {
		const known = markerByDb.get(entry.dbPath);
		if (known) {
			if (known.marker.profile !== signature) {
				// Another model's database; the user may switch back to it.
				continue;
			}
			if (known.marker.indexVersion === INDEX_VERSION) {
				live.push({ path: known.path, marker: known.marker, bytes: entry.bytes });
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
		if (meta.vecDimensions !== undefined && meta.vecDimensions !== profile.dimensions) {
			// Another model's database; the user may switch back to it.
			continue;
		}
		const rootPath = resolveProjectRoot(meta.projectPath);
		const domain = naturalDomain(rootPath);
		if (domain !== rootPath) {
			// A child root's old database: its rows belong to the domain database,
			// which either exists already or is rebuilt on the next run.
			actions.push({
				kind: "delete",
				dbPath: entry.dbPath,
				bytes: entry.bytes,
				reason: `${rootPath} lives inside its domain ${domain}`,
				domainPath: domain,
			});
			continue;
		}
		adoptionCandidates.push({ entry, domainPath: rootPath });
	}

	const liveDomains = live.map((entry) => entry.marker.domainPath);

	// Never adopt a database whose directory is gone, and keep at most one
	// database per domain (the largest, since the list is size-sorted).
	const seenDomains = new Set<string>();
	const adoptable: typeof adoptionCandidates = [];
	for (const candidate of adoptionCandidates) {
		if (!existsSync(candidate.domainPath)) {
			actions.push({
				kind: "delete",
				dbPath: candidate.entry.dbPath,
				bytes: candidate.entry.bytes,
				reason: `${candidate.domainPath} no longer exists`,
			});
			continue;
		}
		if (seenDomains.has(candidate.domainPath)) {
			actions.push({
				kind: "delete",
				dbPath: candidate.entry.dbPath,
				bytes: candidate.entry.bytes,
				reason: `duplicate database for ${candidate.domainPath}`,
			});
			continue;
		}
		seenDomains.add(candidate.domainPath);
		adoptable.push(candidate);
	}

	// Keep only the outermost adoptable domain: an inner one is covered by it.
	for (const candidate of adoptable) {
		const coveredByAdoption = adoptable.some(
			(other) =>
				other !== candidate && isPathInside(candidate.domainPath, other.domainPath)
		);
		const coveredByLive = liveDomains.some(
			(domain) =>
				domain !== candidate.domainPath &&
				isPathInside(candidate.domainPath, domain) &&
				databaseCovers(dbPathForDomain(domain, profile, env), domain, candidate.domainPath)
		);
		if (coveredByAdoption || coveredByLive) {
			actions.push({
				kind: "delete",
				dbPath: candidate.entry.dbPath,
				bytes: candidate.entry.bytes,
				reason: `covered by a domain database above ${candidate.domainPath}`,
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
	}

	// Nested live domains: keep the outermost one when it provably covers the
	// inner one, otherwise leave both alone.
	const sorted = [...live].sort(
		(a, b) => a.marker.domainPath.length - b.marker.domainPath.length
	);
	const keptDomains: DomainMarker[] = [];
	for (const entry of sorted) {
		const outer = keptDomains.find((candidate) =>
			isPathInside(entry.marker.domainPath, candidate.domainPath)
		);
		const outerDb = outer ? dbPathForDomain(outer.domainPath, profile, env) : undefined;
		if (
			outer &&
			outerDb &&
			databaseCovers(outerDb, outer.domainPath, entry.marker.domainPath)
		) {
			actions.push({
				kind: "delete",
				dbPath: entry.marker.dbPath,
				bytes: entry.bytes,
				reason: `covered by the domain database for ${outer.domainPath}`,
				domainPath: outer.domainPath,
			});
			continue;
		}
		keptDomains.push(entry.marker);
	}

	const freedBytes = actions
		.filter((action) => action.kind === "delete")
		.reduce((sum, action) => sum + action.bytes, 0);
	const migrated = actions.filter((action) => action.kind !== "delete").length;
	return {
		actions,
		freedBytes,
		// Databases that survive as live domains after the prune runs.
		kept: keptDomains.length + migrated,
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
			removeDatabaseDir(action.dbPath);
			deleted += 1;
			freedBytes += action.bytes;
			continue;
		}
		if (action.kind === "adopt" && action.domainPath) {
			const dbPath = dbPathForDomain(action.domainPath, profile, env);
			if (!adoptLegacyDatabase({ dbPath, domainPath: action.domainPath, profile, env })) {
				// The move failed (or a racing process won); leave the old file.
				continue;
			}
			writeDomainMarker(action.domainPath, profile, env);
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
