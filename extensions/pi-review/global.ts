/**
 * Machine-wide App cache for pi-review.
 *
 * Secrets cannot be read back, so a second repository cannot borrow the first
 * repo's App key through GitHub. This cache keeps the *non-secret* App identity
 * (id, slug) and the path to the private-key file the user already has, so
 * onboarding another repository does not ask for them again.
 *
 * The key itself lives in a `0600` file under the pi agent directory when the
 * wizard creates the App; the cache file is `0600` too.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface CachedApp {
	appId: number;
	slug: string;
	/** Path to the PEM the user (or the wizard) saved. */
	keyPath: string;
}

/** Keyed by lowercased owner login. */
export type AppCache = Record<string, CachedApp>;

export interface CachePaths {
	cachePath?: string;
	keyDir?: string;
}

export function defaultCachePath(): string {
	return join(getAgentDir(), "pi-review.json");
}

export function defaultKeyDir(): string {
	return join(getAgentDir(), "pi-review");
}

function validEntry(value: unknown): value is CachedApp {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.appId === "number" &&
		Number.isInteger(record.appId) &&
		typeof record.slug === "string" &&
		record.slug.length > 0 &&
		typeof record.keyPath === "string" &&
		record.keyPath.length > 0
	);
}

export async function loadAppCache(paths: CachePaths = {}): Promise<AppCache> {
	try {
		const raw = await readFile(paths.cachePath ?? defaultCachePath(), "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== "object" || parsed === null) return {};
		const cache: AppCache = {};
		for (const [owner, entry] of Object.entries(parsed as Record<string, unknown>)) {
			if (validEntry(entry)) {
				cache[owner.toLowerCase()] = {
					appId: entry.appId,
					slug: entry.slug,
					keyPath: entry.keyPath,
				};
			}
		}
		return cache;
	} catch {
		return {};
	}
}

export function cachedAppFor(cache: AppCache, owner: string): CachedApp | undefined {
	return cache[owner.toLowerCase()];
}

export async function saveCachedApp(
	owner: string,
	entry: CachedApp,
	paths: CachePaths = {}
): Promise<void> {
	const path = paths.cachePath ?? defaultCachePath();
	const cache = await loadAppCache(paths);
	cache[owner.toLowerCase()] = entry;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
	try {
		await chmod(path, 0o600);
	} catch {
		// Filesystems without POSIX modes (rare on the platforms pi supports).
	}
}

/** Save the PEM for reuse across repositories; returns its path. */
export async function saveAppKey(owner: string, pem: string, paths: CachePaths = {}): Promise<string> {
	const dir = paths.keyDir ?? defaultKeyDir();
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, `${owner.toLowerCase()}.pem`);
	await writeFile(path, pem, { mode: 0o600 });
	try {
		await chmod(path, 0o600);
	} catch {
		// As above.
	}
	return path;
}
