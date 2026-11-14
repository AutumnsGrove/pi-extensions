import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	dbPathForDomain,
	legacyDbPathForRoot,
	type EmbeddingProfile,
} from "../src/config.ts";
import { invalidateDomainCache, readDomainMarkers, resolveIndexRoot, writeDomainMarker } from "../src/domains.ts";
import { executePrune, planPrune } from "../src/store/prune.ts";
import { Store } from "../src/store/sqlite.ts";

const PROFILE: EmbeddingProfile = {
	model: "ordis/jina-embeddings-v2-base-code",
	dimensions: 2,
	vectorStorage: "float32",
	maxChunkTokens: 512,
};

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
	invalidateDomainCache();
});

function tempDir(prefix = "semsearch-prune-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

function envFor(dataHome: string): Record<string, string> {
	return { XDG_DATA_HOME: dataHome };
}

/** Write a version-1 style database with the metadata a real one records. */
function legacyDatabase(options: {
	rootPath: string;
	dataHome: string;
	files?: Record<string, string>;
	rootHash?: string;
}): string {
	const env = envFor(options.dataHome);
	const dbPath = legacyDbPathForRoot(options.rootPath, PROFILE, env);
	mkdirSync(join(dbPath, ".."), { recursive: true });
	const store = Store.open(dbPath, PROFILE.dimensions);
	store.setMeta("project_path", options.rootPath);
	store.setMeta("root_hash", options.rootHash ?? "abc123");
	store.setMeta("embedding_model", PROFILE.model);
	store.setMeta("total_files", String(Object.keys(options.files ?? {}).length));
	store.setMeta("last_indexed_at", "2026-01-01T00:00:00.000Z");
	for (const [path, hash] of Object.entries(options.files ?? {})) {
		store.upsertFile(path, hash);
	}
	store.close();
	return dbPath;
}

describe("planPrune", () => {
	it("adopts the outermost root database and deletes its children", () => {
		const dataHome = tempDir();
		const projects = tempDir("semsearch-projects-");
		const lattice = join(projects, "Lattice");
		mkdirSync(lattice, { recursive: true });
		execFileSync("git", ["init", "-q", lattice], { stdio: "ignore" });

		const projectsDb = legacyDatabase({
			rootPath: projects,
			dataHome,
			files: { "Lattice/a.ts": "h1", "own.ts": "h2" },
		});
		const latticeDb = legacyDatabase({
			rootPath: lattice,
			dataHome,
			files: { "a.ts": "h1" },
		});

		const plan = planPrune(PROFILE, envFor(dataHome));
		const adopt = plan.actions.find((action) => action.kind === "adopt");
		expect(adopt?.dbPath).toBe(projectsDb);
		expect(adopt?.domainPath).toBe(realpathSync(projects));		const deletes = plan.actions.filter((action) => action.kind === "delete");
		expect(deletes.map((action) => action.dbPath)).toEqual([latticeDb]);
		expect(plan.freedBytes).toBeGreaterThan(0);
	});

	it("keeps a lone repository database, which is its own domain", () => {
		const dataHome = tempDir();
		const repo = tempDir("semsearch-repo-");
		execFileSync("git", ["init", "-q", repo], { stdio: "ignore" });
		legacyDatabase({ rootPath: repo, dataHome });

		const plan = planPrune(PROFILE, envFor(dataHome));
		expect(plan.actions.map((action) => action.kind)).toEqual(["adopt"]);
	});

	it("ignores databases for other embedding profiles", () => {
		const dataHome = tempDir();
		const repo = tempDir("semsearch-repo-");
		execFileSync("git", ["init", "-q", repo], { stdio: "ignore" });
		const other: EmbeddingProfile = { ...PROFILE, dimensions: 384 };
		const dbPath = legacyDbPathForRoot(repo, other, envFor(dataHome));
		mkdirSync(join(dbPath, ".."), { recursive: true });
		const store = Store.open(dbPath, other.dimensions);
		store.setMeta("project_path", repo);
		store.setMeta("root_hash", "abc");
		store.close();

		const plan = planPrune(PROFILE, envFor(dataHome));
		expect(plan.actions).toEqual([]);
	});

	it("deletes a nested live database the outer one covers", () => {
		const dataHome = tempDir();
		const projects = tempDir("semsearch-projects-");
		const lattice = join(projects, "Lattice");
		mkdirSync(lattice, { recursive: true });
		execFileSync("git", ["init", "-q", lattice], { stdio: "ignore" });
		const env = envFor(dataHome);

		// The outer domain has been indexed: it owns the whole tree.
		const outerPath = dbPathForDomain(projects, PROFILE, env);
		mkdirSync(join(outerPath, ".."), { recursive: true });
		const outer = Store.open(outerPath, PROFILE.dimensions);
		outer.upsertRoot({
			rootPath: projects,
			rootPrefix: "",
			rootHash: "outer",
			lastIndexError: "",
			totalFiles: 2,
		});
		outer.upsertFile("Lattice/a.ts", "h1");
		outer.close();
		writeDomainMarker(projects, PROFILE, env);

		// The nested domain still has its own (now redundant) database.
		const innerPath = dbPathForDomain(lattice, PROFILE, env);
		mkdirSync(join(innerPath, ".."), { recursive: true });
		const inner = Store.open(innerPath, PROFILE.dimensions);
		inner.upsertRoot({
			rootPath: lattice,
			rootPrefix: "",
			rootHash: "inner",
			lastIndexError: "",
			totalFiles: 1,
		});
		inner.close();
		writeDomainMarker(lattice, PROFILE, env);

		const plan = planPrune(PROFILE, env);
		expect(plan.actions).toHaveLength(1);
		expect(plan.actions[0]).toMatchObject({
			kind: "delete",
			dbPath: innerPath,
		});
		expect(plan.kept).toBe(1);
	});

	it("keeps a nested database the outer one does not cover", () => {
		const dataHome = tempDir();
		const projects = tempDir("semsearch-projects-");
		const lattice = join(projects, "Lattice");
		mkdirSync(lattice, { recursive: true });
		execFileSync("git", ["init", "-q", lattice], { stdio: "ignore" });
		const env = envFor(dataHome);

		const outerPath = dbPathForDomain(projects, PROFILE, env);
		mkdirSync(join(outerPath, ".."), { recursive: true });
		const outer = Store.open(outerPath, PROFILE.dimensions);
		// Only `own.ts` was indexed from the outer root.
		outer.upsertRoot({
			rootPath: projects,
			rootPrefix: "",
			rootHash: "outer",
			lastIndexError: "",
			totalFiles: 1,
		});
		outer.upsertFile("own.ts", "h2");
		outer.close();
		writeDomainMarker(projects, PROFILE, env);

		const innerPath = dbPathForDomain(lattice, PROFILE, env);
		mkdirSync(join(innerPath, ".."), { recursive: true });
		const inner = Store.open(innerPath, PROFILE.dimensions);
		inner.upsertRoot({
			rootPath: lattice,
			rootPrefix: "",
			rootHash: "inner",
			lastIndexError: "",
			totalFiles: 1,
		});
		inner.close();
		writeDomainMarker(lattice, PROFILE, env);

		// `own.ts` is the only row, so the outer root does not cover Lattice.
		expect(planPrune(PROFILE, env).actions).toEqual([]);
	});
});

describe("executePrune", () => {
	it("moves the adopted database and deletes the redundant ones", () => {
		const dataHome = tempDir();
		const env = envFor(dataHome);
		const projects = tempDir("semsearch-projects-");
		const lattice = join(projects, "Lattice");
		mkdirSync(lattice, { recursive: true });
		execFileSync("git", ["init", "-q", lattice], { stdio: "ignore" });

		const projectsDb = legacyDatabase({
			rootPath: projects,
			dataHome,
			files: { "Lattice/a.ts": "h1", "own.ts": "h2" },
		});
		const latticeDb = legacyDatabase({
			rootPath: lattice,
			dataHome,
			files: { "a.ts": "h1" },
		});
		// An unrelated file with no marker and no metadata.
		const orphan = join(dataHome, "pi-semantic-search", "orphan");
		mkdirSync(orphan, { recursive: true });
		writeFileSync(join(orphan, "index.db"), "not sqlite");

		const report = executePrune(planPrune(PROFILE, env), PROFILE, env);
		expect(report.adopted).toBe(1);
		expect(report.deleted).toBe(2);

		const adopted = dbPathForDomain(projects, PROFILE, env);
		expect(existsSync(adopted)).toBe(true);
		expect(existsSync(projectsDb)).toBe(false);
		expect(existsSync(latticeDb)).toBe(false);
		expect(existsSync(join(orphan, "index.db"))).toBe(false);

		// The adopted file still knows which directory it describes.
		const store = Store.open(adopted, PROFILE.dimensions);
		expect(store.adoptLegacyRoot(projects)).toBe(true);
		expect(store.getRoot(projects)).toMatchObject({ rootHash: "abc123", rootPrefix: "" });
		expect(store.getFileHashes().size).toBe(2);
		store.close();

		// And the child now resolves into the parent's database.
		invalidateDomainCache();
		const resolved = resolveIndexRoot(lattice, PROFILE, env);
		expect(resolved.domainPath).toBe(realpathSync(projects));
		expect(resolved.rootPrefix).toBe("Lattice");
		expect(readDomainMarkers(env).map((marker) => marker.domainPath)).toEqual([
			realpathSync(projects),
		]);
	});
});
