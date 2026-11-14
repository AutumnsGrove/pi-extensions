import { createServer, type Server } from "node:http";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SUPPORTED_EXTENSIONS, buildChunkers } from "../src/chunk/index.ts";
import { legacyDbPathForRoot } from "../src/config.ts";
import { invalidateDomainCache } from "../src/domains.ts";
import { makeSkip } from "../src/index/ignore.ts";
import { buildTree } from "../src/index/merkle.ts";
import { SemanticSearchManager } from "../src/manager.ts";
import { executePrune, planPrune } from "../src/store/prune.ts";
import { Store } from "../src/store/sqlite.ts";

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

	it("keeps adopted rows when the first run comes from a child root", async () => {
		const dataHome = tempDir();
		const env = { XDG_DATA_HOME: dataHome };
		const repo = project({
			"pkg/a.ts": "export function alpha() {\n  return 'alpha';\n}\n",
			"other/c.ts": "export function gamma() {\n  return 'gamma';\n}\n",
		});
		const pkg = join(repo, "pkg");
		const profile = {
			model: "keyword",
			dimensions: KEYWORDS.length,
			vectorStorage: "float32",
			maxChunkTokens: 512,
		};

		// A version-1 database for the repo root, with the real tree hashes.
		const tree = await buildTree(repo, makeSkip(repo, SUPPORTED_EXTENSIONS));
		const legacyPath = legacyDbPathForRoot(repo, profile, env);
		mkdirSync(join(legacyPath, ".."), { recursive: true });
		const legacy = Store.open(legacyPath, KEYWORDS.length);
		legacy.setMeta("project_path", realpathSync(repo));
		legacy.setMeta("root_hash", tree.rootHash);
		legacy.setMeta("embedding_model", profile.model);
		legacy.setMeta("total_files", String(tree.files.size));
		legacy.setMeta("last_indexed_at", new Date().toISOString());
		for (const [path, hash] of tree.files) {
			legacy.upsertFile(path, hash);
		}
		legacy.close();

		const plan = planPrune(profile, env);
		expect(plan.actions.map((action) => action.kind)).toEqual(["adopt"]);
		expect(executePrune(plan, profile, env).adopted).toBe(1);

		// The first session after pruning is in a subdirectory, not the domain
		// root. If adoption had not imported the root row, this run would see an
		// empty domain and collect every sibling row as garbage.
		const manager = newManager(dataHome);
		const child = await manager.ensure(pkg);
		expect(child.resolved.domainPath).toBe(realpathSync(repo));
		expect(child.resolved.rootPrefix).toBe("pkg");
		expect(child.store.getRoot(realpathSync(repo))).toBeTruthy();

		const result = await child.indexer.ensureFresh();
		expect(result.stats.chunksCreated).toBe(0);
		const hashes = child.store.getFileHashes();
		expect(hashes.has("other/c.ts")).toBe(true);
		expect(hashes.has("pkg/a.ts")).toBe(true);
		await manager.close();
	});
});
