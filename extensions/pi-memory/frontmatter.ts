/**
 * Memory file format.
 *
 * ```markdown
 * ---
 * name: Use pnpm, not npm
 * description: Autumn's package manager preference for this repository
 * type: feedback
 * created: 2026-11-19T05:01:10.000Z
 * ---
 *
 * Use pnpm for installs, scripts, and new workspace members.
 *
 * **Why:** npm rewrites the lockfile and breaks the pinned workspace layout.
 * **How to apply:** Run `pnpm …`; if a doc says `npm`, fix the doc.
 * ```
 *
 * Parsing is deliberately forgiving: a hand-edited file with a missing field or
 * an unknown type should still be readable. Serialisation is strict and stable,
 * because the index and the model both depend on the same shape.
 */

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { oneLine, slugify } from "./text.ts";
import { MEMORY_TYPES, type MemoryCandidate, type MemoryType } from "./types.ts";

export interface ParsedMemoryText {
	data: Record<string, unknown>;
	body: string;
}

export function isMemoryType(value: unknown): value is MemoryType {
	return typeof value === "string" && (MEMORY_TYPES as readonly string[]).includes(value);
}

/**
 * Split `---` frontmatter from the body.
 *
 * Returns `undefined` when the file has no frontmatter, so callers can tell
 * "hand-written note" apart from "memory with bad metadata". An unterminated
 * opening fence is treated as no frontmatter rather than swallowing the file.
 */
export function splitFrontmatter(text: string): ParsedMemoryText | undefined {
	const clean = text.replace(/^\uFEFF/, "");
	if (!clean.startsWith("---\n") && !clean.startsWith("---\r\n")) {
		return undefined;
	}
	const normalized = clean.replace(/\r\n/g, "\n");
	const end = normalized.indexOf("\n---", 3);
	if (end < 0) return undefined;
	const header = normalized.slice(4, end);
	// Skip the rest of the closing fence line, then one blank separator line if
	// the author wrote one. `parseMemory` trims the rest.
	const body = normalized.slice(end + 4).replace(/^\n/, "").replace(/^\n/, "");
	let data: unknown;
	try {
		data = parseYaml(header) ?? {};
	} catch {
		return undefined;
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) {
		return undefined;
	}
	return { data: data as Record<string, unknown>, body };
}

const stringField = (data: Record<string, unknown>, key: string): string | undefined => {
	const value = data[key];
	if (typeof value === "string" && value.trim() !== "") return value.trim();
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return undefined;
};

/** Type encoded in a filename prefix, e.g. `feedback_pnpm.md`. */
export function typeFromFilename(file: string): MemoryType | undefined {
	const prefix = file.split("_")[0];
	return isMemoryType(prefix) ? prefix : undefined;
}

/** Title derived from a filename, used when frontmatter is missing. */
export function nameFromFilename(file: string): string {
	const base = file.replace(/\.md$/i, "");
	const withoutType = typeFromFilename(file) ? base.slice(base.indexOf("_") + 1) : base;
	const words = withoutType.replace(/[_-]+/g, " ").trim();
	return words.length > 0 ? words : "Memory";
}

export interface ParsedMemory {
	name: string;
	description: string;
	type: MemoryType;
	body: string;
}

/**
 * Coerce a memory file to usable fields.
 *
 * Missing name, description, or type are filled from the filename and body
 * rather than rejected: a partially hand-written file is still a memory. The
 * type falls back to `project` unless the filename prefix is authoritative.
 */
export function parseMemory(file: string, text: string): ParsedMemory | undefined {
	const split = splitFrontmatter(text);
	const data = split?.data ?? {};
	const body = (split?.body ?? text).trim();
	if (body === "") return undefined;
	const name = stringField(data, "name") ?? nameFromFilename(file);
	const description =
		stringField(data, "description") ??
		oneLine(
			body
				.split("\n")
				.map((line) => line.replace(/^\s*[-*+]\s+/, "").trim())
				.find((line) => line.length > 0) ?? name,
			160
		);
	const typeValue = data.type;
	const type = isMemoryType(typeValue)
		? typeValue
		: (typeFromFilename(file) ?? "project");
	return { name, description, type, body };
}

export interface SerializeMemoryInput {
	name: string;
	description: string;
	type: MemoryType;
	body: string;
	created?: string;
	updated?: string;
}

/** Frontmatter order is stable so diffs stay small and the index is readable. */
export function serializeMemory(input: SerializeMemoryInput): string {
	const data: Record<string, string> = {
		name: input.name,
		description: input.description,
		type: input.type,
	};
	if (input.created) data.created = input.created;
	if (input.updated) data.updated = input.updated;
	const header = stringifyYaml(data, { lineWidth: 0 }).trimEnd();
	return `---\n${header}\n---\n\n${input.body.trim()}\n`;
}

/** Body with the optional why/how sections appended exactly once. */
export function composeBody(candidate: MemoryCandidate): string {
	let body = candidate.body.trim();
	const why = candidate.why?.trim();
	const how = candidate.howToApply?.trim();
	if (why && !/\*\*Why:\*\*/i.test(body)) {
		body += `\n\n**Why:** ${why}`;
	}
	if (how && !/\*\*How to apply:\*\*/i.test(body)) {
		body += `\n\n**How to apply:** ${how}`;
	}
	return body.trim();
}

/** Suggested filename for a candidate. */
export function filenameFor(type: MemoryType, name: string): string {
	return `${type}_${slugify(name)}.md`;
}

/** Timestamp used in frontmatter; ISO with seconds keeps files tidy. */
export function isoNow(now: number = Date.now()): string {
	return new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z");
}
