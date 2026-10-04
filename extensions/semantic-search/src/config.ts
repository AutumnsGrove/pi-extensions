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
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
	DEFAULT_OLLAMA_MODEL,
	canonicalModel,
	modelDimensions,
	modelSpec,
} from "./embed/registry.ts";
import { DEFAULT_OLLAMA_HOST } from "./embed/ollama.ts";

/** Bump whenever a chunker/embedder/schema change invalidates existing indexes. */
export const INDEX_VERSION = 1;

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

function parseIntOrUndefined(value: string | number | undefined): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : undefined;
	}
	if (value.trim() === "") {
		return undefined;
	}
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
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
		const parsed = JSON.parse(readFileSync(path, "utf8")) as SearchConfigFile;
		return parsed && typeof parsed === "object" ? parsed : {};
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

	return {
		model,
		dimensions,
		contextLength,
		baseUrl: env.OLLAMA_HOST ?? DEFAULT_OLLAMA_HOST,
		maxChunkTokens:
			parseIntOrUndefined(env.PI_SEMSEARCH_MAX_CHUNK_TOKENS) ??
			parseIntOrUndefined(file.maxChunkTokens) ??
			DEFAULT_MAX_CHUNK_TOKENS,
		vectorStorage:
			env.PI_SEMSEARCH_VECTOR_STORAGE ??
			file.vectorStorage ??
			DEFAULT_VECTOR_STORAGE,
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
export function dbPathForProject(key: ProfileKey, env: Env = process.env): string {
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
