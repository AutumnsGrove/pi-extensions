/**
 * Small JSON helpers shared by the extension's on-disk stores.
 *
 * `models.json` allows `//` comments and trailing commas, so reads tolerate
 * them. Writes are plain JSON (comments and formatting are not preserved).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Strip `//` line comments and trailing commas, leaving string literals untouched. */
export function stripJsonComments(input: string): string {
	return input
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ""))
		.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail: string | undefined) =>
			tail ?? (match[0] === '"' ? match : "")
		);
}

/** Remove a UTF-8 BOM if present. */
export function stripBom(input: string): string {
	return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
}

/**
 * Read and parse a JSON/JSONC file. Returns undefined when the file is absent.
 * Throws a readable error when the file exists but cannot be parsed.
 */
export function readJsonFile<T>(path: string): T | undefined {
	if (!existsSync(path)) {
		return undefined;
	}
	const raw = stripJsonComments(stripBom(readFileSync(path, "utf8")));
	if (!raw.trim()) {
		return undefined;
	}
	try {
		return JSON.parse(raw) as T;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse ${path}: ${message}`);
	}
}

/** Atomically write a JSON file with a trailing newline, creating parent dirs. */
export function writeJsonFile(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(tmp, path);
}
