/**
 * The memory store: one directory of Markdown files plus a tiny index.
 *
 * The index (`MEMORY.md`) is a list of links and hooks. It is the only part
 * that is always in context. Bodies stay on disk until recall or an explicit
 * `memory_read`.
 *
 * Writes are atomic, files are mode 0600, and every save re-renders the index
 * under the configured caps. A save that cannot be rendered under the caps
 * still succeeds; the index is truncated, and `/memory dream` is the way back.
 */

import {
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	composeBody,
	filenameFor,
	isMemoryType,
	isoNow,
	parseMemory,
	serializeMemory,
	splitFrontmatter,
} from "./frontmatter.ts";
import { scanMemoryFields, secretRefusal } from "./secret.ts";
import { byteLength, capText, normalizeName, oneLine, truncateBytes } from "./text.ts";
import {
	DEFAULT_LIMITS,
	type IndexRender,
	type MemoryCandidate,
	type MemoryFile,
	type MemoryLimits,
	type MemoryManifestEntry,
	type MemoryType,
	type SaveResult,
} from "./types.ts";

export const INDEX_FILE = "MEMORY.md";
const STATE_FILE = "state.json";
const LOCK_FILE = "lock.json";
const MAX_READ_BYTES = 256 * 1024;

export class MemoryWriteError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MemoryWriteError";
	}
}

const TYPE_ORDER: Record<MemoryType, number> = {
	user: 0,
	feedback: 1,
	project: 2,
	reference: 3,
};

/** One session's extraction bookkeeping, persisted across restarts. */
export interface SessionCursor {
	/** Last processed branch entry id. */
	cursor?: string;
	/** Settled runs since the last extraction attempt. */
	turns: number;
	lastSeenAt: number;
}

export interface StoreState {
	version: 1;
	sessions: Record<string, SessionCursor>;
	lastDreamAt?: string;
	lastDreamSessions?: number;
	lastExtractAt?: string;
	lastExtractCost?: number;
	lastExtractCount?: number;
	totalExtractCost?: number;
	extractRuns?: number;
	lastError?: string;
}

export function emptyState(): StoreState {
	return { version: 1, sessions: {} };
}

function sanitizeState(value: unknown): StoreState {
	if (!value || typeof value !== "object" || Array.isArray(value)) return emptyState();
	const raw = value as Record<string, unknown>;
	const sessions: Record<string, SessionCursor> = {};
	const rawSessions = raw.sessions;
	if (rawSessions && typeof rawSessions === "object" && !Array.isArray(rawSessions)) {
		for (const [id, entry] of Object.entries(rawSessions as Record<string, unknown>)) {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
			const cursor = entry as Record<string, unknown>;
			sessions[id] = {
				cursor: typeof cursor.cursor === "string" ? cursor.cursor : undefined,
				turns:
					typeof cursor.turns === "number" && Number.isFinite(cursor.turns)
						? Math.max(0, Math.trunc(cursor.turns))
						: 0,
				lastSeenAt:
					typeof cursor.lastSeenAt === "number" && Number.isFinite(cursor.lastSeenAt)
						? cursor.lastSeenAt
						: 0,
			};
		}
	}
	const number = (key: string): number | undefined =>
		typeof raw[key] === "number" && Number.isFinite(raw[key]) ? (raw[key] as number) : undefined;
	const text = (key: string): string | undefined =>
		typeof raw[key] === "string" ? (raw[key] as string) : undefined;
	return {
		version: 1,
		sessions,
		lastDreamAt: text("lastDreamAt"),
		lastDreamSessions: number("lastDreamSessions"),
		lastExtractAt: text("lastExtractAt"),
		lastExtractCost: number("lastExtractCost"),
		lastExtractCount: number("lastExtractCount"),
		totalExtractCost: number("totalExtractCost"),
		extractRuns: number("extractRuns"),
		lastError: text("lastError"),
	};
}

/** Write a file atomically, owner-only, with a `.tmp` sibling in the same directory. */
export function writeAtomic(path: string, text: string): void {
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
	try {
		renameSync(tmp, path);
	} catch {
		// Windows refuses to rename over an existing file. Fall back to an
		// in-place write and remove the temporary copy.
		writeFileSync(path, text, { encoding: "utf8", mode: 0o600 });
		try {
			rmSync(tmp, { force: true });
		} catch {
			// ignore
		}
	}
}

export interface SaveOptions {
	/** Basename to update instead of creating a new file. */
	replace?: string;
	/** Clock override for tests. */
	now?: number;
}

export class MemoryStore {
	readonly dir: string;
	readonly limits: MemoryLimits;

	constructor(dir: string, limits: MemoryLimits = DEFAULT_LIMITS) {
		this.dir = dir;
		this.limits = limits;
	}

	ensure(): void {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
	}

	get indexPath(): string {
		return join(this.dir, INDEX_FILE);
	}

	get statePath(): string {
		return join(this.dir, STATE_FILE);
	}

	get lockPath(): string {
		return join(this.dir, LOCK_FILE);
	}

	/** Every readable memory, sorted by type then name. */
	files(): MemoryFile[] {
		let names: string[];
		try {
			names = readdirSync(this.dir);
		} catch {
			return [];
		}
		const files: MemoryFile[] = [];
		for (const name of names) {
			if (!name.toLowerCase().endsWith(".md")) continue;
			if (name.toLowerCase() === INDEX_FILE.toLowerCase()) continue;
			const path = join(this.dir, name);
			try {
				const stat = statSync(path);
				if (!stat.isFile() || stat.size > MAX_READ_BYTES) continue;
				const text = readFileSync(path, "utf8");
				const parsed = parseMemory(name, text);
				if (!parsed) continue;
				files.push({
					file: name,
					...parsed,
					mtimeMs: stat.mtimeMs,
					bytes: stat.size,
				});
			} catch {
				// One unreadable file must not hide the rest of the store.
			}
		}
		return sortFiles(files);
	}

	/** Resolve a filename or a human name to a memory. */
	find(id: string, files: MemoryFile[] = this.files()): MemoryFile | undefined {
		const needle = id.trim();
		if (needle === "") return undefined;
		const lower = needle.toLowerCase();
		return (
			files.find((file) => file.file.toLowerCase() === lower) ??
			files.find((file) => file.file.toLowerCase() === `${lower}.md`) ??
			files.find((file) => normalizeName(file.name) === normalizeName(needle)) ??
			files.find((file) => file.file.toLowerCase().includes(lower))
		);
	}

	manifest(files: MemoryFile[] = this.files()): MemoryManifestEntry[] {
		return files.map(({ file, name, description, type, body }) => ({
			file,
			name,
			description,
			type,
			body,
		}));
	}

	/**
	 * Save a candidate, updating a same-named memory in place.
	 *
	 * The update-by-name rule is what makes a repeated correction cheap: the
	 * model does not have to know the existing filename, and the store does not
	 * grow by one near-duplicate every time the same preference is restated.
	 */
	save(candidate: MemoryCandidate, options: SaveOptions = {}): SaveResult {
		this.ensure();
		if (!isMemoryType(candidate.type)) {
			throw new MemoryWriteError(`Unknown memory type "${String(candidate.type)}".`);
		}
		const files = this.files();
		// A same-named memory is the same memory, whatever type the caller now
		// claims. Matching on name alone lets a type change be refused loudly
		// instead of silently creating a second file with the same title.
		const existing = options.replace
			? files.find((file) => file.file === options.replace)
			: files.find((file) => normalizeName(file.name) === normalizeName(candidate.name));
		if (options.replace && !existing) {
			throw new MemoryWriteError(`No memory file named "${options.replace}".`);
		}
		if (existing && existing.type !== candidate.type) {
			// Type is part of the filename and the taxonomy; changing it would
			// silently move the file. Keep the memory where it is.
			throw new MemoryWriteError(
				`"${existing.name}" is a ${existing.type} memory; save it as ${existing.type} or forget it first.`
			);
		}

		const composed = composeBody({ ...candidate, type: candidate.type });
		const name = oneLine(candidate.name, this.limits.maxNameChars);
		const description = oneLine(
			candidate.description.trim() ||
				composed.split("\n").find((line) => line.trim() !== "") ||
				name,
			this.limits.maxDescriptionChars
		);
		if (name.length < 2) {
			throw new MemoryWriteError("A memory needs a name of at least two characters.");
		}
		if (composed.trim() === "") {
			throw new MemoryWriteError("A memory needs a body.");
		}
		const capped = capText(composed, this.limits.maxBodyChars, 400);
		const body = capped.text;
		if (byteLength(body) > this.limits.maxBodyChars) {
			throw new MemoryWriteError(
				`Memory body is over ${this.limits.maxBodyChars} bytes; split it into a smaller rule.`
			);
		}
		const hit = scanMemoryFields({ name, description, body });
		if (hit) {
			throw new MemoryWriteError(secretRefusal(hit));
		}

		const now = options.now ?? Date.now();
		const created =
			(existing &&
				splitFrontmatter(readFileSync(join(this.dir, existing.file), "utf8"))?.data
					.created) ||
			isoNow(now);
		const file = existing?.file ?? this.uniqueFilename(candidate.type, name, files);
		const text = serializeMemory({
			name,
			description,
			type: candidate.type,
			body,
			created: typeof created === "string" ? created : isoNow(now),
			updated: existing ? isoNow(now) : undefined,
		});
		writeAtomic(join(this.dir, file), text);
		const index = this.rewriteIndex();
		return { file, created: !existing, index };
	}

	private uniqueFilename(type: MemoryType, name: string, files: MemoryFile[]): string {
		const base = filenameFor(type, name);
		const taken = new Set(files.map((file) => file.file.toLowerCase()));
		if (!taken.has(base.toLowerCase())) return base;
		const stem = base.replace(/\.md$/, "");
		for (let n = 2; n < 1_000; n++) {
			const next = `${stem}_${n}.md`;
			if (!taken.has(next.toLowerCase())) return next;
		}
		return `${stem}_${Date.now()}.md`;
	}

	/** Remove a memory. Returns the removed file, or undefined when absent. */
	forget(id: string): { file: string; index: IndexRender } | undefined {
		this.ensure();
		const found = this.find(id);
		if (!found) return undefined;
		const path = join(this.dir, found.file);
		try {
			unlinkSync(path);
		} catch {
			return undefined;
		}
		const index = this.rewriteIndex();
		return { file: found.file, index };
	}

	/**
	 * Render the index under the line and byte caps.
	 *
	 * When it overflows, entries are dropped from the end (the sort is stable)
	 * and one trailing line says how many are missing. That keeps the index
	 * deterministic and small instead of letting it grow forever.
	 */
	renderIndex(files: MemoryFile[] = this.files(), limits: MemoryLimits = this.limits): IndexRender {
		const sorted = sortFiles(files);
		const lines: string[] = [];
		let bytes = 0;
		let hidden = 0;
		for (let i = 0; i < sorted.length; i++) {
			const file = sorted[i]!;
			const name = oneLine(file.name, 100).replace(/[[\]]/g, "");
			const line = `- [${name}](${file.file}) — ${oneLine(file.description, 160)}`;
			const remaining = sorted.length - i - 1;
			const reserve = remaining > 0 ? byteLength(this.warning(remaining)) + 1 : 0;
			const cost = byteLength(line) + 1;
			if (lines.length + 1 >= limits.maxIndexLines || bytes + cost + reserve > limits.maxIndexBytes) {
				hidden = sorted.length - i;
				break;
			}
			lines.push(line);
			bytes += cost;
		}
		if (hidden > 0) {
			const room = Math.max(0, limits.maxIndexBytes - bytes - 1);
			const warning = truncateBytes(this.warning(hidden), room);
			if (warning.length > 0) {
				lines.push(warning);
				bytes += byteLength(warning) + 1;
			}
		}
		const text = lines.length > 0 ? `${lines.join("\n")}\n` : "";
		return {
			text,
			lines: lines.length,
			bytes: byteLength(text),
			truncated: hidden > 0,
			total: sorted.length,
		};
	}

	private warning(hidden: number): string {
		return `… ${hidden} more ${hidden === 1 ? "memory" : "memories"} not shown · /memory dream`;
	}

	/** Rewrite `MEMORY.md` when its rendered text changed. */
	rewriteIndex(): IndexRender {
		this.ensure();
		const rendered = this.renderIndex();
		let current: string | undefined;
		try {
			current = readFileSync(this.indexPath, "utf8");
		} catch {
			current = undefined;
		}
		if (current !== rendered.text) {
			writeAtomic(this.indexPath, rendered.text);
		}
		return rendered;
	}

	readIndex(): string {
		try {
			return readFileSync(this.indexPath, "utf8");
		} catch {
			return "";
		}
	}

	readState(): StoreState {
		try {
			return sanitizeState(JSON.parse(readFileSync(this.statePath, "utf8")));
		} catch {
			return emptyState();
		}
	}

	writeState(state: StoreState): void {
		this.ensure();
		// Keep the file bounded: the 40 most recently seen sessions are plenty
		// for cursors, and a stale cursor only costs a re-read.
		const sessions = Object.entries(state.sessions)
			.sort((a, b) => b[1].lastSeenAt - a[1].lastSeenAt)
			.slice(0, 40);
		const bounded: StoreState = { ...state, sessions: Object.fromEntries(sessions) };
		writeAtomic(this.statePath, `${JSON.stringify(bounded, null, 2)}\n`);
	}

	/** Read-modify-write the state file. */
	updateState(mutate: (state: StoreState) => void): StoreState {
		const state = this.readState();
		mutate(state);
		this.writeState(state);
		return state;
	}

	/**
	 * Take the consolidation/extraction lock.
	 *
	 * Returns a release function, or undefined when another live process holds
	 * it. A lock older than `ttlMs` is treated as a crash leftover and stolen.
	 */
	acquireLock(now: number = Date.now(), ttlMs = 120_000): (() => void) | undefined {
		this.ensure();
		const payload = JSON.stringify({ pid: process.pid, at: now });
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				writeFileSync(this.lockPath, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
				return () => {
					try {
						const held = JSON.parse(readFileSync(this.lockPath, "utf8")) as { pid?: number };
						if (held.pid === process.pid) unlinkSync(this.lockPath);
					} catch {
						// Already gone or unreadable; nothing useful to do.
					}
				};
			} catch {
				let heldAt = 0;
				try {
					heldAt = (JSON.parse(readFileSync(this.lockPath, "utf8")) as { at?: number }).at ?? 0;
				} catch {
					heldAt = 0;
				}
				if (now - heldAt < ttlMs) return undefined;
				try {
					unlinkSync(this.lockPath);
				} catch {
					return undefined;
				}
			}
		}
		return undefined;
	}

	/** Cheap counters for `/memory status`. */
	stats(): {
		files: number;
		bytes: number;
		indexLines: number;
		indexBytes: number;
		truncated: boolean;
		lastModified?: number;
	} {
		const files = this.files();
		const index = this.renderIndex(files);
		const lastModified = files.reduce<number | undefined>(
			(latest, file) => (latest === undefined || file.mtimeMs > latest ? file.mtimeMs : latest),
			undefined
		);
		return {
			files: files.length,
			bytes: files.reduce((sum, file) => sum + file.bytes, 0),
			indexLines: index.lines,
			indexBytes: index.bytes,
			truncated: index.truncated,
			lastModified,
		};
	}

	/** Test and recovery helper: remove everything this store owns. */
	clear(): void {
		for (const name of [INDEX_FILE, STATE_FILE, LOCK_FILE]) {
			try {
				rmSync(join(this.dir, name), { force: true });
			} catch {
				// ignore
			}
		}
		for (const file of this.files()) {
			try {
				rmSync(join(this.dir, file.file), { force: true });
			} catch {
				// ignore
			}
		}
	}
}

export function sortFiles(files: MemoryFile[]): MemoryFile[] {
	return [...files].sort((a, b) => {
		const type = TYPE_ORDER[a.type] - TYPE_ORDER[b.type];
		if (type !== 0) return type;
		return a.name.localeCompare(b.name, "en", { sensitivity: "base" });
	});
}

/** Read a JSON file, falling back when it is missing or corrupt. */
export function readJsonFile<T>(path: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return fallback;
	}
}
