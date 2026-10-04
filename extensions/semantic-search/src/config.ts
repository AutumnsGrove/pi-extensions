/**
 * Runtime configuration: embedding backend/model, chunk budget, vector
 * profile, and the content-addressed database path.
 *
 * Mirrors lumen's `internal/config`, simplified: a single backend rather than
 * a failover server list, and no legacy migration.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
	DEFAULT_LMSTUDIO_MODEL,
	DEFAULT_OLLAMA_MODEL,
	canonicalModel,
	modelDimensions,
	modelSpec,
} from "./embed/registry.ts";
import { DEFAULT_LM_STUDIO_HOST } from "./embed/lmstudio.ts";
import { DEFAULT_OLLAMA_HOST } from "./embed/ollama.ts";

/** Bump whenever a chunker/embedder/schema change invalidates existing indexes. */
export const INDEX_VERSION = 1;

export const DEFAULT_MAX_CHUNK_TOKENS = 512;
/** Reserved for int8 quantization; float32 is the only implemented profile. */
export const DEFAULT_VECTOR_STORAGE = "float32";

export const BACKEND_OLLAMA = "ollama";
export const BACKEND_LMSTUDIO = "lmstudio";

export interface SearchConfig {
	backend: string;
	model: string;
	dimensions: number;
	contextLength?: number;
	baseUrl: string;
	maxChunkTokens: number;
	vectorStorage: string;
}

type Env = Record<string, string | undefined>;

function parseIntOrUndefined(value: string | undefined): number | undefined {
	if (value === undefined || value.trim() === "") {
		return undefined;
	}
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/** Load configuration from the environment. Throws when dims are unresolvable. */
export function loadConfig(env: Env = process.env): SearchConfig {
	const model =
		env.PI_SEMSEARCH_MODEL ??
		(env.PI_SEMSEARCH_BACKEND === BACKEND_LMSTUDIO
			? DEFAULT_LMSTUDIO_MODEL
			: DEFAULT_OLLAMA_MODEL);
	const spec = modelSpec(model);
	const backend = env.PI_SEMSEARCH_BACKEND ?? spec?.backend ?? BACKEND_OLLAMA;

	const dimensions =
		parseIntOrUndefined(env.PI_SEMSEARCH_EMBED_DIMS) ?? modelDimensions(model);
	if (dimensions === undefined || dimensions <= 0) {
		throw new Error(
			`unknown embedding model "${model}"; set PI_SEMSEARCH_EMBED_DIMS to its output dimensions`
		);
	}

	const contextLength =
		parseIntOrUndefined(env.PI_SEMSEARCH_EMBED_CTX) ?? spec?.ctxLength;

	const baseUrl =
		backend === BACKEND_LMSTUDIO
			? (env.LM_STUDIO_HOST ?? DEFAULT_LM_STUDIO_HOST)
			: (env.OLLAMA_HOST ?? DEFAULT_OLLAMA_HOST);

	return {
		backend,
		model,
		dimensions,
		contextLength,
		baseUrl,
		maxChunkTokens:
			parseIntOrUndefined(env.PI_SEMSEARCH_MAX_CHUNK_TOKENS) ??
			DEFAULT_MAX_CHUNK_TOKENS,
		vectorStorage: env.PI_SEMSEARCH_VECTOR_STORAGE ?? DEFAULT_VECTOR_STORAGE,
	};
}

/** Data directory for indexes: `$XDG_DATA_HOME/pi-semantic-search`. */
export function dataDir(env: Env = process.env): string {
	const xdg = env.XDG_DATA_HOME;
	const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share");
	return join(base, "pi-semantic-search");
}

function findGitPath(start: string): string | undefined {
	let dir = resolve(start);
	for (;;) {
		const candidate = join(dir, ".git");
		if (existsSync(candidate)) {
			return candidate;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return undefined;
		}
		dir = parent;
	}
}

/**
 * Identity shared by all worktrees of one repository: the Git common directory
 * when present, otherwise the resolved project path.
 */
export function gitIdentity(projectPath: string): string {
	const gitPath = findGitPath(projectPath);
	if (!gitPath) {
		return safeRealpath(resolve(projectPath));
	}
	let isDir = false;
	try {
		isDir = lstatSync(gitPath).isDirectory();
	} catch {
		isDir = false;
	}
	if (isDir) {
		return safeRealpath(gitPath);
	}
	// A `.git` file points at `<repo>/.git/worktrees/<name>` for a worktree.
	try {
		const content = readFileSync(gitPath, "utf8");
		const match = content.match(/^gitdir:\s*(.+)\s*$/m);
		if (match?.[1]) {
			let target = match[1].trim();
			if (!isAbsolute(target)) {
				target = resolve(dirname(gitPath), target);
			}
			const parts = target.split(/[/\\]/);
			const worktreesIndex = parts.lastIndexOf("worktrees");
			if (worktreesIndex > 0) {
				target = parts.slice(0, worktreesIndex).join("/");
			}
			return safeRealpath(target);
		}
	} catch {
		// Fall through to the project path.
	}
	return safeRealpath(resolve(projectPath));
}

function safeRealpath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

export interface ProfileKey {
	projectPath: string;
	model: string;
	dimensions: number;
	vectorStorage: string;
	maxChunkTokens: number;
}

/** Content-addressed database path for a project + embedding profile. */
export function dbPathForProject(
	key: ProfileKey,
	env: Env = process.env
): string {
	const profile = [
		gitIdentity(key.projectPath),
		canonicalModel(key.model),
		String(key.dimensions),
		key.vectorStorage,
		String(key.maxChunkTokens),
		String(INDEX_VERSION),
	].join("\u0000");
	const hash = createHash("sha256").update(profile).digest("hex").slice(0, 16);
	return join(dataDir(env), hash, "index.db");
}
