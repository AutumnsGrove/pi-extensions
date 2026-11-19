/**
 * Core types for pi-memory.
 *
 * A memory is a small Markdown file with frontmatter. `MEMORY.md` is an index
 * of pointers, never a body. The four types are a closed taxonomy on purpose:
 * an open one would collect activity logs.
 */

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

/** A candidate write, from a tool call or from the extractor's JSON. */
export interface MemoryCandidate {
	name: string;
	description: string;
	type: MemoryType;
	/** The rule or fact. */
	body: string;
	/** Why it matters. Expected for feedback and project memories. */
	why?: string;
	/** When and how to apply it. Expected for feedback and project memories. */
	howToApply?: string;
}

export interface MemoryFile {
	/** Basename inside the store, e.g. `feedback_pnpm.md`. */
	file: string;
	name: string;
	description: string;
	type: MemoryType;
	body: string;
	/** Epoch milliseconds, from the filesystem. */
	mtimeMs: number;
	bytes: number;
}

/** The frontmatter-only view used for recall scoring and extraction dedupe. */
export interface MemoryManifestEntry {
	file: string;
	name: string;
	description: string;
	type: MemoryType;
	/** Trimmed body, when the caller has it. Used for near-duplicate detection. */
	body?: string;
}

export interface IndexRender {
	text: string;
	lines: number;
	bytes: number;
	truncated: boolean;
	total: number;
}

export interface SaveResult {
	file: string;
	created: boolean;
	index: IndexRender;
}

export interface MemoryLimits {
	maxIndexLines: number;
	maxIndexBytes: number;
	maxNameChars: number;
	maxDescriptionChars: number;
	maxBodyChars: number;
	maxRecallFiles: number;
	maxRecallBytes: number;
	maxRecallBodyBytes: number;
	maxRecallBodyLines: number;
}

export const DEFAULT_LIMITS: MemoryLimits = {
	maxIndexLines: 200,
	maxIndexBytes: 25_600,
	maxNameChars: 80,
	maxDescriptionChars: 200,
	maxBodyChars: 4_000,
	maxRecallFiles: 5,
	maxRecallBytes: 4_096,
	maxRecallBodyBytes: 4_096,
	maxRecallBodyLines: 200,
};
