import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	INDEX_VERSION,
	agentDir,
	dataDir,
	dbPathForProject,
	defaultConfigFile,
	gitIdentity,
	loadConfig,
	readConfigFile,
	writeModelConfig,
} from "../src/config.ts";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "semsearch-config-"));
	dirs.push(dir);
	return dir;
}

function profile(overrides: Partial<Parameters<typeof dbPathForProject>[0]> = {}) {
	return {
		projectPath: "/tmp/project",
		model: "ordis/jina-embeddings-v2-base-code",
		dimensions: 768,
		vectorStorage: "float32",
		maxChunkTokens: 512,
		...overrides,
	};
}

describe("loadConfig", () => {
	it("uses the Ollama default with no environment or file", () => {
		const config = loadConfig({}, null);
		expect(config.model).toBe("ordis/jina-embeddings-v2-base-code");
		expect(config.dimensions).toBe(768);
		expect(config.contextLength).toBe(8192);
		expect(config.maxChunkTokens).toBe(512);
		expect(config.baseUrl).toBe("http://localhost:11434");
	});

	it("honours env overrides", () => {
		const config = loadConfig(
			{
				PI_SEMSEARCH_MODEL: "custom-model",
				PI_SEMSEARCH_EMBED_DIMS: "128",
				PI_SEMSEARCH_EMBED_CTX: "2048",
				PI_SEMSEARCH_MAX_CHUNK_TOKENS: "256",
				OLLAMA_HOST: "http://ollama:11434",
			},
			null
		);
		expect(config.model).toBe("custom-model");
		expect(config.dimensions).toBe(128);
		expect(config.contextLength).toBe(2048);
		expect(config.maxChunkTokens).toBe(256);
		expect(config.baseUrl).toBe("http://ollama:11434");
	});

	it("throws for an unknown model with no dimensions", () => {
		expect(() => loadConfig({ PI_SEMSEARCH_MODEL: "mystery" }, null)).toThrow(
			/PI_SEMSEARCH_EMBED_DIMS/
		);
	});

	it("resolves a known non-default model from the registry", () => {
		const config = loadConfig({ PI_SEMSEARCH_MODEL: "qwen3-embedding:8b" }, null);
		expect(config.dimensions).toBe(4096);
		expect(config.contextLength).toBe(40960);
	});

	it("reads the config file and lets env override it", () => {
		const dir = tempDir();
		const file = join(dir, "semantic-search.json");
		writeFileSync(file, JSON.stringify({ model: "all-minilm", maxChunkTokens: 256 }));
		const fromFile = loadConfig({}, file);
		expect(fromFile.model).toBe("all-minilm");
		expect(fromFile.dimensions).toBe(384);
		expect(fromFile.maxChunkTokens).toBe(256);

		const fromEnv = loadConfig({ PI_SEMSEARCH_MODEL: "nomic-embed-text" }, file);
		expect(fromEnv.model).toBe("nomic-embed-text");
		expect(fromEnv.dimensions).toBe(768);
	});
});

describe("config file", () => {
	it("defaults under the pi agent dir, honouring PI_CODING_AGENT_DIR", () => {
		expect(agentDir({ PI_CODING_AGENT_DIR: "/custom" })).toBe("/custom");
		expect(defaultConfigFile({ PI_CODING_AGENT_DIR: "/custom" })).toBe(
			"/custom/semantic-search.json"
		);
	});

	it("writes a model selection and reads it back", () => {
		const dir = tempDir();
		const env = { PI_SEMSEARCH_CONFIG: join(dir, "config.json") };
		const path = writeModelConfig("qwen3-embedding:8b", undefined, env);
		expect(path).toBe(env.PI_SEMSEARCH_CONFIG);
		expect(readConfigFile(path).model).toBe("qwen3-embedding:8b");
		expect(loadConfig(env, path).dimensions).toBe(4096);
	});

	it("persists explicit dimensions for an unknown model", () => {
		const dir = tempDir();
		const env = { PI_SEMSEARCH_CONFIG: join(dir, "config.json") };
		writeModelConfig("my-local-model", 1024, env);
		expect(readConfigFile(env.PI_SEMSEARCH_CONFIG)).toEqual({
			model: "my-local-model",
			dimensions: 1024,
		});
		expect(loadConfig(env, env.PI_SEMSEARCH_CONFIG).dimensions).toBe(1024);
	});

	it("clears stale dimensions when switching to a known model", () => {
		const dir = tempDir();
		const env = { PI_SEMSEARCH_CONFIG: join(dir, "config.json") };
		writeModelConfig("my-local-model", 1024, env);
		writeModelConfig("all-minilm", undefined, env);
		const file = readConfigFile(env.PI_SEMSEARCH_CONFIG);
		expect(file.model).toBe("all-minilm");
		expect(file.dimensions).toBeUndefined();
	});

	it("ignores a malformed config file", () => {
		const dir = tempDir();
		const file = join(dir, "bad.json");
		writeFileSync(file, "{ not json");
		expect(readConfigFile(file)).toEqual({});
		expect(loadConfig({}, file).model).toBe("ordis/jina-embeddings-v2-base-code");
		expect(readFileSync(file, "utf8")).toBe("{ not json");
	});
});

describe("paths", () => {
	it("honours XDG_DATA_HOME", () => {
		expect(dataDir({ XDG_DATA_HOME: "/data" })).toBe("/data/pi-semantic-search");
	});

	it("builds a deterministic, profile-specific database path", () => {
		const base = dbPathForProject(profile(), {});
		expect(base).toBe(dbPathForProject(profile(), {}));
		expect(dbPathForProject(profile({ model: "nomic-embed-text" }), {})).not.toBe(base);
		expect(dbPathForProject(profile({ dimensions: 384 }), {})).not.toBe(base);
		expect(base).toContain("pi-semantic-search");
		expect(INDEX_VERSION).toBeGreaterThan(0);
	});
});

describe("gitIdentity", () => {
	it("uses the .git directory of a repository", () => {
		const root = tempDir();
		const gitDir = join(root, ".git");
		mkdirSync(gitDir);
		expect(gitIdentity(root)).toBe(realpathSync(gitDir));
	});

	it("resolves the common dir for a worktree .git file", () => {
		const repo = tempDir();
		const commonDir = join(repo, ".git");
		const worktreeGitDir = join(commonDir, "worktrees", "wt");
		mkdirSync(worktreeGitDir, { recursive: true });
		const worktree = join(tempDir(), "wt");
		mkdirSync(worktree, { recursive: true });
		writeFileSync(join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);
		expect(gitIdentity(worktree)).toBe(realpathSync(commonDir));
	});

	it("falls back to the project path outside a repository", () => {
		const root = tempDir();
		expect(gitIdentity(root)).toBe(realpathSync(root));
	});
});
