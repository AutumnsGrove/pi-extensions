/**
 * Merkle tree for change detection, ported from lumen's
 * `internal/merkle/merkle.go`. File reads are hashed with a small concurrency
 * limit; the root hash is a SHA-256 over the sorted `path:hash` pairs.
 */

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SkipFunc } from "./ignore.ts";

export interface Tree {
	rootHash: string;
	/** Relative POSIX path -> content SHA-256. */
	files: Map<string, string>;
}

export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const HASH_WORKERS = 8;

async function collectFilePaths(rootDir: string, skip: SkipFunc): Promise<string[]> {
	const out: string[] = [];

	async function walk(dirRel: string): Promise<void> {
		let entries;
		try {
			entries = await readdir(dirRel === "" ? rootDir : join(rootDir, dirRel), {
				withFileTypes: true,
			});
		} catch {
			// Permission denied or vanished directory: skip it.
			return;
		}
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			const rel = dirRel === "" ? entry.name : `${dirRel}/${entry.name}`;
			if (entry.isSymbolicLink()) {
				continue;
			}
			if (entry.isDirectory()) {
				if (!skip(rel, true)) {
					await walk(rel);
				}
				continue;
			}
			if (!entry.isFile() || skip(rel, false)) {
				continue;
			}
			try {
				const info = await stat(join(rootDir, rel));
				if (info.size > MAX_FILE_SIZE) {
					continue;
				}
			} catch {
				continue;
			}
			out.push(rel);
		}
	}

	await walk("");
	return out;
}

async function hashWithLimit(
	rootDir: string,
	relPaths: readonly string[],
	files: Map<string, string>
): Promise<void> {
	let next = 0;
	const workers = Array.from(
		{ length: Math.min(HASH_WORKERS, relPaths.length) },
		async () => {
			for (;;) {
				const index = next;
				next += 1;
				if (index >= relPaths.length) {
					return;
				}
				const rel = relPaths[index];
				if (rel === undefined) {
					continue;
				}
				try {
					const data = await readFile(join(rootDir, rel));
					files.set(rel, createHash("sha256").update(data).digest("hex"));
				} catch {
					// Unreadable file: ignore it, like lumen does for EACCES.
				}
			}
		}
	);
	await Promise.all(workers);
}

export async function buildTree(rootDir: string, skip: SkipFunc): Promise<Tree> {
	const relPaths = await collectFilePaths(rootDir, skip);
	const files = new Map<string, string>();
	await hashWithLimit(rootDir, relPaths, files);
	return { rootHash: buildDirHash(files), files };
}

export function buildDirHash(files: ReadonlyMap<string, string>): string {
	const paths = [...files.keys()].sort();
	const hash = createHash("sha256");
	for (const path of paths) {
		hash.update(`${path}:${files.get(path) ?? ""}\n`);
	}
	return hash.digest("hex");
}

export interface DiffResult {
	added: string[];
	removed: string[];
	modified: string[];
}

export function diffTrees(oldTree: Tree, curTree: Tree): DiffResult {
	const added: string[] = [];
	const modified: string[] = [];
	const removed: string[] = [];
	for (const [path, curHash] of curTree.files) {
		const oldHash = oldTree.files.get(path);
		if (oldHash === undefined) {
			added.push(path);
		} else if (oldHash !== curHash) {
			modified.push(path);
		}
	}
	for (const path of oldTree.files.keys()) {
		if (!curTree.files.has(path)) {
			removed.push(path);
		}
	}
	added.sort();
	removed.sort();
	modified.sort();
	return { added, removed, modified };
}
