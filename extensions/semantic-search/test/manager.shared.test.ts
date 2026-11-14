import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SemanticSearchManager } from "../src/manager.ts";
import { invalidateDomainCache } from "../src/domains.ts";

const KEYWORDS = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
const dirs: string[] = [];
let server: Server;
let baseUrl = "";
let embeddedTexts = 0;

beforeAll(async () => {
	server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			const parsed = JSON.parse(body || "{}") as { input?: string[] };
			const inputs = Array.isArray(parsed.input) ? parsed.input : [];
			embeddedTexts += inputs.length;
			const embeddings = inputs.map((text) => {
				const lower = text.toLowerCase();
				return KEYWORDS.map((keyword) => lower.split(keyword).length - 1);
			});
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ embeddings }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address && typeof address === "object") {
		baseUrl = `http://127.0.0.1:${address.port}`;
	}
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
	invalidateDomainCache();
});

function tempDir(prefix = "semsearch-manager-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

function project(files: Record<string, string>): string {
	const root = tempDir();
	for (const [rel, content] of Object.entries(files)) {
		const path = join(root, rel);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
	return root;
}

function newManager(dataHome: string): SemanticSearchManager {
	return new SemanticSearchManager(
		{
			model: "keyword",
			dimensions: KEYWORDS.length,
			baseUrl,
			maxChunkTokens: 512,
			vectorStorage: "float32",
		},
		{ XDG_DATA_HOME: dataHome }
	);
}

const FILES = {
	"pkg/a.ts": "export function alpha() {\n  return 'alpha';\n}\n",
	"pkg/b.ts": "export function beta() {\n  return 'beta';\n}\n",
	"other/c.ts": "export function gamma() {\n  return 'gamma';\n}\n",
};

describe("SemanticSearchManager domain integration", () => {
	it("shares one database between a root and its subdirectory", async () => {
		const dataHome = tempDir();
		const repo = project(FILES);
		const pkg = join(repo, "pkg");
		const manager = newManager(dataHome);

		const parent = await manager.ensure(repo);
		await parent.indexer.index(false);
		expect(existsSync(parent.resolved.dbPath)).toBe(true);
		expect(parent.resolved.rootPrefix).toBe("");

		const before = embeddedTexts;
		const child = await manager.ensure(pkg);
		expect(child.resolved.domainPath).toBe(parent.resolved.domainPath);
		expect(child.store).toBe(parent.store);
		expect(child.resolved.rootPrefix).toBe("pkg");
		const fresh = await child.indexer.ensureFresh();
		expect(fresh.stats.chunksCreated).toBe(0);
		expect(embeddedTexts).toBe(before);

		const { output } = await manager.search(pkg, {
			query: "alpha",
			limit: 10,
			minScore: -1,
		});
		expect(output.results.length).toBeGreaterThan(0);
		for (const result of output.results) {
			expect(["a.ts", "b.ts"]).toContain(result.filePath);
		}
		await manager.close();
	});

	it("reopens the same database in a fresh process", async () => {
		const dataHome = tempDir();
		const repo = project(FILES);
		const pkg = join(repo, "pkg");

		const first = newManager(dataHome);
		const entry = await first.ensure(pkg);
		await entry.indexer.index(false);
		const dbPath = entry.resolved.dbPath;
		await first.close();

		const second = newManager(dataHome);
		const reopened = await second.ensure(pkg);
		expect(reopened.resolved.dbPath).toBe(dbPath);
		expect(reopened.indexer.status().totalFiles).toBe(2);
		expect((await reopened.indexer.ensureFresh()).reindexed).toBe(false);
		await second.close();
	});

	it("starts a new database when the model changes", async () => {
		const dataHome = tempDir();
		const repo = project(FILES);
		const first = newManager(dataHome);
		const original = await first.ensure(repo);
		await original.indexer.index(false);
		await first.close();

		const otherProfile = new SemanticSearchManager(
			{
				model: "another-model",
				dimensions: KEYWORDS.length,
				baseUrl,
				maxChunkTokens: 512,
				vectorStorage: "float32",
			},
			{ XDG_DATA_HOME: dataHome }
		);
		const second = await otherProfile.ensure(repo);
		expect(second.resolved.domainPath).toBe(original.resolved.domainPath);
		expect(second.resolved.dbPath).not.toBe(original.resolved.dbPath);
		await otherProfile.close();
	});

	it("scopes reindex runs to their own root", async () => {
		const dataHome = tempDir();
		const repo = project(FILES);
		const pkg = join(repo, "pkg");
		const manager = newManager(dataHome);

		const parent = await manager.ensure(repo);
		await parent.indexer.index(false);
		const child = await manager.ensure(pkg);
		await child.indexer.ensureFresh();

		writeFileSync(join(pkg, "a.ts"), "export function alpha() {\n  return 'new';\n}\n");
		const result = await child.indexer.ensureFresh();
		expect(result.reindexed).toBe(true);
		expect(result.stats.filesModified).toBe(1);
		// Sibling files outside the root were not touched.
		expect(parent.store.getFileHashes().has("other/c.ts")).toBe(true);
		await manager.close();
	});
});
