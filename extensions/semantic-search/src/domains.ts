/**
 * Index domains: which database a root belongs to, and which slice of it the
 * root owns.
 *
 * A domain is either
 *  - a Git repository (`git rev-parse --show-toplevel`), so every subdirectory,
 *    package, and worktree-root maps to the same database, or
 *  - the top-level root that was indexed first outside a repository, so
 *    `~/Documents/Projects` and every repository under it share one database.
 *
 * Resolution prefers the deepest already-indexed ancestor. That keeps the
 * "open pi in a subdirectory" case on the parent's database (no duplicate
 * rows) without needing a global registry: each indexed domain leaves a small
 * marker file under the data directory.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	INDEX_VERSION,
	dataDir,
	dbPathForDomain,
	profileSignature,
	resolveProjectRoot,
	type EmbeddingProfile,
} from "./config.ts";

type Env = Record<string, string | undefined>;

export interface DomainMarker {
	domainPath: string;
	/** {@link profileSignature} of the profile the marker was written for. */
	profile: string;
	dbPath: string;
	indexVersion: number;
	updatedAt: string;
}

export interface ResolvedIndexRoot {
	/** Absolute realpath of the directory being indexed and searched. */
	rootPath: string;
	/** Absolute realpath of the domain root; keys the database. */
	domainPath: string;
	/** POSIX path of `rootPath` inside `domainPath`; "" for the domain root. */
	rootPrefix: string;
	/** Database file shared by every root in the domain. */
	dbPath: string;
}

/* ------------------------------------------------------------------ */
/* Path helpers                                                        */
/* ------------------------------------------------------------------ */

export function toPosixPath(path: string): string {
	return path.split(/[/\\]/).join("/");
}

/** Normalise a relative prefix: no leading/trailing slashes, "" for none. */
export function normalizePrefix(prefix: string): string {
	return toPosixPath(prefix)
		.replace(/^\.\/+/, "")
		.replace(/^\/+|\/+$/g, "");
}

/** Join two relative prefixes without ever producing a leading slash. */
export function joinPrefix(first: string, second: string): string {
	const left = normalizePrefix(first);
	const right = normalizePrefix(second);
	if (left === "") {
		return right;
	}
	return right === "" ? left : `${left}/${right}`;
}

/** Whether `path` is `prefix` itself or lives underneath it ("" = everything). */
export function isPathUnder(path: string, prefix: string): boolean {
	const clean = normalizePrefix(prefix);
	if (clean === "") {
		return true;
	}
	return path === clean || path.startsWith(`${clean}/`);
}

/** Remove a prefix from a domain-relative path; returns "" when it does not match. */
export function stripPrefix(prefix: string, path: string): string {
	const clean = normalizePrefix(prefix);
	if (clean === "") {
		return path;
	}
	if (path === clean) {
		return "";
	}
	return path.startsWith(`${clean}/`) ? path.slice(clean.length + 1) : "";
}

/** POSIX path of `path` inside `base`; "" when they are the same directory. */
export function relativePrefix(base: string, path: string): string {
	const rel = relative(base, path);
	if (rel === "" || rel === ".") {
		return "";
	}
	if (rel === ".." || rel.startsWith(`..${sep}`)) {
		return "";
	}
	return normalizePrefix(rel);
}

/** Whether absolute `path` is `base` or lives underneath it. */
export function isPathInside(path: string, base: string): boolean {
	const rel = relative(resolve(base), resolve(path));
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Absolute candidate directories from `path` upwards, deepest first. */
export function ancestorPaths(path: string): string[] {
	const out: string[] = [];
	let current = resolve(path);
	for (;;) {
		out.push(current);
		const parent = dirname(current);
		if (parent === current) {
			return out;
		}
		current = parent;
	}
}

function safeRealpath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/* ------------------------------------------------------------------ */
/* Git identity                                                        */
/* ------------------------------------------------------------------ */

/**
 * Repository root containing `dir`, or undefined outside a repository.
 *
 * `--show-toplevel` returns the *worktree* root, so linked worktrees keep
 * distinct databases instead of writing each other's rows.
 */
export function gitToplevel(dir: string): string | undefined {
	try {
		const result = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			timeout: 2000,
			stdio: ["ignore", "pipe", "ignore"],
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
		});
		const line = result.stdout?.split("\n")[0]?.trim();
		if (result.status === 0 && line) {
			return safeRealpath(line);
		}
		if (result.error === undefined && result.status !== null) {
			// git ran and said "not a repository"; trust it.
			return undefined;
		}
	} catch {
		// git missing or unusable; fall through to the filesystem check.
	}
	// No usable git binary: approximate the toplevel by finding the nearest
	// `.git` entry. Wrong for `core.worktree` setups, right for the common case.
	for (const candidate of ancestorPaths(dir)) {
		if (existsSync(join(candidate, ".git"))) {
			return candidate;
		}
	}
	return undefined;
}

/** Domain a root belongs to when nothing above it is indexed yet. */
export function naturalDomain(rootPath: string): string {
	return gitToplevel(rootPath) ?? rootPath;
}

/* ------------------------------------------------------------------ */
/* Domain markers                                                      */
/* ------------------------------------------------------------------ */

export function domainsDir(env: Env = process.env): string {
	return join(dataDir(env), "domains");
}

function markerFileName(domainPath: string, profile: string): string {
	const hash = createHash("sha256")
		.update(`${resolveProjectRoot(domainPath)}\u0000${profile}`)
		.digest("hex")
		.slice(0, 16);
	return `${hash}.json`;
}

export function domainMarkerPath(
	domainPath: string,
	key: EmbeddingProfile,
	env: Env = process.env
): string {
	return join(domainsDir(env), markerFileName(domainPath, profileSignature(key)));
}

const markerCache = new Map<string, { at: number; markers: DomainMarker[] }>();
const MARKER_CACHE_MS = 5000;

/** Forget the cached marker list; the next lookup re-reads the directory. */
export function invalidateDomainCache(): void {
	markerCache.clear();
}

function parseMarker(value: unknown): DomainMarker | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const raw = value as Record<string, unknown>;
	if (typeof raw.domainPath !== "string" || raw.domainPath === "") {
		return undefined;
	}
	if (typeof raw.profile !== "string" || typeof raw.dbPath !== "string") {
		return undefined;
	}
	const indexVersion =
		typeof raw.indexVersion === "number" ? raw.indexVersion : Number(raw.indexVersion);
	return {
		domainPath: raw.domainPath,
		profile: raw.profile,
		dbPath: raw.dbPath,
		indexVersion: Number.isFinite(indexVersion) ? indexVersion : 0,
		updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
	};
}

/** Every domain marker on disk, with the file it came from. */
export function listDomainMarkers(
	env: Env = process.env
): Array<{ path: string; marker: DomainMarker }> {
	const dir = domainsDir(env);
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	const out: Array<{ path: string; marker: DomainMarker }> = [];
	for (const entry of entries) {
		if (!entry.endsWith(".json")) {
			continue;
		}
		const path = join(dir, entry);
		try {
			const marker = parseMarker(JSON.parse(readFileSync(path, "utf8")));
			if (marker) {
				out.push({ path, marker });
			}
		} catch {
			// A torn or hand-edited marker only costs a redundant re-index.
		}
	}
	return out;
}

/** Every domain marker on disk (any profile, any index version). */
export function readDomainMarkers(env: Env = process.env): DomainMarker[] {
	const dir = domainsDir(env);
	const cached = markerCache.get(dir);
	if (cached && Date.now() - cached.at < MARKER_CACHE_MS) {
		return cached.markers;
	}
	const markers = listDomainMarkers(env).map((entry) => entry.marker);
	markerCache.set(dir, { at: Date.now(), markers });
	return markers;
}

/** Record that `domainPath` owns a database for this profile. */
export function writeDomainMarker(
	domainPath: string,
	key: EmbeddingProfile,
	env: Env = process.env
): DomainMarker {
	const marker: DomainMarker = {
		domainPath: resolveProjectRoot(domainPath),
		profile: profileSignature(key),
		dbPath: dbPathForDomain(domainPath, key, env),
		indexVersion: INDEX_VERSION,
		updatedAt: new Date().toISOString(),
	};
	const path = domainMarkerPath(marker.domainPath, key, env);
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
	renameSync(temp, path);
	invalidateDomainCache();
	return marker;
}

export function removeDomainMarker(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// Already gone.
	}
	invalidateDomainCache();
}

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

/**
 * Which database `projectPath` reads and writes, and which slice of it the root
 * owns. The deepest already-indexed ancestor wins; otherwise the repository
 * root, otherwise the path itself.
 */
export function resolveIndexRoot(
	projectPath: string,
	key: EmbeddingProfile,
	env: Env = process.env
): ResolvedIndexRoot {
	const rootPath = resolveProjectRoot(projectPath);
	// A domain is a property of the directory, not of the embedding profile or
	// index version: switching models must not fragment an existing domain.
	// Only markers whose directory still exists can claim it.
	const known = new Set(
		readDomainMarkers(env)
			.map((marker) => marker.domainPath)
			.filter((path) => existsSync(path))
	);

	let domainPath: string | undefined;
	for (const candidate of ancestorPaths(rootPath)) {
		if (known.has(candidate)) {
			domainPath = candidate;
			break;
		}
	}
	domainPath ??= naturalDomain(rootPath);

	return {
		rootPath,
		domainPath,
		rootPrefix: relativePrefix(domainPath, rootPath),
		dbPath: dbPathForDomain(domainPath, key, env),
	};
}

/** Path of the database a domain *would* use for a profile. */
export function domainDbPath(
	domainPath: string,
	key: EmbeddingProfile,
	env: Env = process.env
): string {
	return dbPathForDomain(domainPath, key, env);
}
