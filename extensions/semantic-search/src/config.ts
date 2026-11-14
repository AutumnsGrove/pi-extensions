/**
 * Runtime configuration: embedding model, chunk budget, vector profile, and
 * the content-addressed database path.
 *
 * Model selection precedence: environment > config file > built-in registry.
 * The config file lives at `$PI_CODING_AGENT_DIR/semantic-search.json`
 * (default `~/.pi/agent/semantic-search.json`) and is written by
 * `/semsearch model <name>`.
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	DEFAULT_OLLAMA_MODEL,
	canonicalModel,
	modelDimensions,
	modelSpec,
} from "./embed/registry.ts";
import { DEFAULT_OLLAMA_HOST } from "./embed/ollama.ts";

/**
 * Bump whenever a chunker/embedder/schema change invalidates existing indexes.
 *
 * 2: databases are keyed by index domain (repository or top-level root) and
 *    store domain-relative paths plus a `roots` table, so a parent root and a
 *    child root share one database instead of duplicating every chunk.
 */
export const INDEX_VERSION = 2;

export const DEFAULT_MAX_CHUNK_TOKENS = 512;
/** Reserved for int8 quantization; float32 is the only implemented profile. */
export const DEFAULT_VECTOR_STORAGE = "float32";

export interface SearchConfig {
	model: string;
	dimensions: number;
	contextLength?: number;
	baseUrl: string;
	maxChunkTokens: number;
	vectorStorage: string;
}

/** Fields accepted in the on-disk config file. */
export interface SearchConfigFile {
	model?: string;
	dimensions?: number;
	contextLength?: number;
	maxChunkTokens?: number;
	vectorStorage?: string;
}

type Env = Record<string, string | undefined>;

/**
 * Parse an integer from an unknown JSON/env value. Total by design: bad types
 * (null, objects, arrays) and unparseable strings yield `undefined` instead of
 * throwing. A config file must never be able to crash config loading.
 */
function parseIntOrUndefined(value: unknown): number | undefined {
	if (typeof value === "number") {
		return Number.isFinite(value) ? Math.trunc(value) : undefined;
	}
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	if (trimmed === "") {
		return undefined;
	}
	const parsed = Number.parseInt(trimmed, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/** Keep only known, well-typed, usable fields from a parsed config object. */
function sanitizeConfigFile(value: unknown): SearchConfigFile {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	const raw = value as Record<string, unknown>;
	const clean: SearchConfigFile = {};
	if (typeof raw.model === "string" && raw.model.trim() !== "") {
		clean.model = raw.model;
	}
	const dimensions = parseIntOrUndefined(raw.dimensions);
	if (dimensions !== undefined && dimensions > 0) {
		clean.dimensions = dimensions;
	}
	const contextLength = parseIntOrUndefined(raw.contextLength);
	if (contextLength !== undefined && contextLength > 0) {
		clean.contextLength = contextLength;
	}
	const maxChunkTokens = parseIntOrUndefined(raw.maxChunkTokens);
	if (maxChunkTokens !== undefined && maxChunkTokens > 0) {
		clean.maxChunkTokens = maxChunkTokens;
	}
	if (typeof raw.vectorStorage === "string" && raw.vectorStorage.trim() !== "") {
		clean.vectorStorage = raw.vectorStorage;
	}
	return clean;
}

/** pi's agent directory, honouring `PI_CODING_AGENT_DIR`. */
export function agentDir(env: Env = process.env): string {
	const override = env.PI_CODING_AGENT_DIR;
	if (override && override.length > 0) {
		return override.startsWith("~") ? join(homedir(), override.slice(1)) : override;
	}
	return join(homedir(), ".pi", "agent");
}

/** Path to the semantic-search config file. */
export function defaultConfigFile(env: Env = process.env): string {
	return env.PI_SEMSEARCH_CONFIG ?? join(agentDir(env), "semantic-search.json");
}

export function readConfigFile(path: string): SearchConfigFile {
	if (!existsSync(path)) {
		return {};
	}
	try {
		return sanitizeConfigFile(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return {};
	}
}

/** Persist a model (and optional dimensions) to the config file. */
export function writeModelConfig(
	model: string,
	dimensions?: number,
	env: Env = process.env
): string {
	const path = defaultConfigFile(env);
	const next: SearchConfigFile = { ...readConfigFile(path), model };
	if (dimensions !== undefined) {
		next.dimensions = dimensions;
	} else if (modelSpec(model)) {
		delete next.dimensions;
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	return path;
}

/** Load configuration from env, config file, and the built-in registry. */
export function loadConfig(
	env: Env = process.env,
	configFile: string | null = defaultConfigFile(env)
): SearchConfig {
	const file = configFile ? readConfigFile(configFile) : {};
	const model = env.PI_SEMSEARCH_MODEL ?? file.model ?? DEFAULT_OLLAMA_MODEL;
	const spec = modelSpec(model);

	const dimensions =
		parseIntOrUndefined(env.PI_SEMSEARCH_EMBED_DIMS) ??
		parseIntOrUndefined(file.dimensions) ??
		modelDimensions(model);
	if (dimensions === undefined || dimensions <= 0) {
		throw new Error(
			`unknown embedding model "${model}"; set PI_SEMSEARCH_EMBED_DIMS or a "dimensions" field in the config file`
		);
	}

	const contextLength =
		parseIntOrUndefined(env.PI_SEMSEARCH_EMBED_CTX) ??
		parseIntOrUndefined(file.contextLength) ??
		spec?.ctxLength;

	const maxChunkTokens =
		parseIntOrUndefined(env.PI_SEMSEARCH_MAX_CHUNK_TOKENS) ??
		parseIntOrUndefined(file.maxChunkTokens) ??
		DEFAULT_MAX_CHUNK_TOKENS;

	return {
		model,
		dimensions,
		contextLength,
		baseUrl: env.OLLAMA_HOST ?? DEFAULT_OLLAMA_HOST,
		maxChunkTokens:
			maxChunkTokens > 0 ? maxChunkTokens : DEFAULT_MAX_CHUNK_TOKENS,
		vectorStorage:
			env.PI_SEMSEARCH_VECTOR_STORAGE ??
			file.vectorStorage ??
			DEFAULT_VECTOR_STORAGE,
	};
}

export interface SafeConfig {
	config: SearchConfig;
	/** Present when the requested config was unusable and defaults were used. */
	error?: string;
}

/**
 * Load configuration without throwing. A corrupt or unusable config (bad
 * dimensions, unknown model, poisoned file) falls back to the built-in default
 * profile and reports why. Extension construction must never fail because of a
 * config file.
 */
export function loadConfigSafe(
	env: Env = process.env,
	configFile: string | null = defaultConfigFile(env)
): SafeConfig {
	try {
		return { config: loadConfig(env, configFile) };
	} catch (error) {
		return {
			config: loadConfig({}, null),
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Data directory for indexes: `$XDG_DATA_HOME/pi-semantic-search`. */
export function dataDir(env: Env = process.env): string {
	const xdg = env.XDG_DATA_HOME;
	const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share");
	return join(base, "pi-semantic-search");
}

/**
 * Resolve a project path to a canonical absolute path. Symlinks and different
 * spellings of the same directory collapse to one entry; different directories
 * (including git worktrees) stay distinct. Which *database* a path uses is a
 * separate question answered by `resolveIndexRoot()` in `domains.ts`.
 */
export function resolveProjectRoot(projectPath: string): string {
	return safeRealpath(resolve(projectPath));
}

function safeRealpath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** Everything that makes two vectors incompatible. */
export interface EmbeddingProfile {
	model: string;
	dimensions: number;
	vectorStorage: string;
	maxChunkTokens: number;
}

export interface ProfileKey extends EmbeddingProfile {
	/** The index domain, not necessarily the invoking root. */
	projectPath: string;
}

/** Stable identity of an embedding profile; used for markers and databases. */
export function profileSignature(key: EmbeddingProfile): string {
	return [
		canonicalModel(key.model),
		String(key.dimensions),
		key.vectorStorage,
		String(key.maxChunkTokens),
	].join("\u0000");
}

/**
 * Content-addressed database path for an index domain + embedding profile.
 *
 * The domain is a repository (for roots inside one) or the top-level root that
 * was indexed first and now contains everything below it. Every root in a
 * domain opens this one file, so a chunk is embedded and stored once.
 */
export function dbPathForProject(key: ProfileKey, env: Env = process.env): string {
	return dbPathForDomain(resolveProjectRoot(key.projectPath), key, env, INDEX_VERSION);
}

export function dbPathForDomain(
	domainPath: string,
	key: EmbeddingProfile,
	env: Env,
	version: number = INDEX_VERSION
): string {
	const material = [
		resolveProjectRoot(domainPath),
		profileSignature(key),
		String(version),
	].join("\u0000");
	const hash = createHash("sha256").update(material).digest("hex").slice(0, 16);
	return join(dataDir(env), hash, "index.db");
}

/**
 * Where version-1 stored the index for a root: one database per invocation
 * root, with root-relative paths. Only the domain root's legacy database can be
 * adopted (its paths are already domain-relative); the rest are covered by it.
 */
export function legacyDbPathForRoot(
	rootPath: string,
	key: EmbeddingProfile,
	env: Env = process.env
): string {
	return dbPathForDomain(rootPath, key, env, 1);
}

