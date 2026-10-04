import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	BACKEND_LMSTUDIO,
	INDEX_VERSION,
	dataDir,
	dbPathForProject,
	gitIdentity,
	loadConfig,
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
	it("uses the Ollama default with no environment", () => {
		const config = loadConfig({});
		expect(config.backend).toBe("ollama");
		expect(config.model).toBe("ordis/jina-embeddings-v2-base-code");
		expect(config.dimensions).toBe(768);
		expect(config.contextLength).toBe(8192);
		expect(config.maxChunkTokens).toBe(512);
	});

	it("defaults to the LM Studio model for the lmstudio backend", () => {
		const config = loadConfig({ PI_SEMSEARCH_BACKEND: BACKEND_LMSTUDIO });
		expect(config.model).toBe("nomic-ai/nomic-embed-code-GGUF");
		expect(config.dimensions).toBe(3584);
	});

	it("honours env overrides", () => {
		const config = loadConfig({
			PI_SEMSEARCH_MODEL: "custom-model",
			PI_SEMSEARCH_EMBED_DIMS: "128",
			PI_SEMSEARCH_EMBED_CTX: "2048",
			PI_SEMSEARCH_MAX_CHUNK_TOKENS: "256",
			OLLAMA_HOST: "http://ollama:11434",
		});
		expect(config.model).toBe("custom-model");
		expect(config.dimensions).toBe(128);
		expect(config.contextLength).toBe(2048);
		expect(config.maxChunkTokens).toBe(256);
		expect(config.baseUrl).toBe("http://ollama:11434");
	});

	it("throws for an unknown model with no dimensions", () => {
		expect(() => loadConfig({ PI_SEMSEARCH_MODEL: "mystery" })).toThrow(
			/PI_SEMSEARCH_EMBED_DIMS/
		);
	});

	it("resolves model aliases", () => {
		const config = loadConfig({
			PI_SEMSEARCH_MODEL: "text-embedding-nomic-embed-code",
		});
		expect(config.dimensions).toBe(3584);
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
		expect(base).toContain(`pi-semantic-search`);
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
