import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cachedAppFor, loadAppCache, saveAppKey, saveCachedApp } from "./global.ts";

const dirs: string[] = [];

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-review-global-"));
	dirs.push(dir);
	return dir;
}

describe("App cache", () => {
	it("round-trips entries by lowercased owner", async () => {
		const dir = await tempDir();
		const cachePath = join(dir, "pi-review.json");
		await saveCachedApp("AutumnsGrove", { appId: 1, slug: "pi-review-a", keyPath: "/k.pem" }, { cachePath });
		await saveCachedApp("acme", { appId: 2, slug: "pi-review-b", keyPath: "/b.pem" }, { cachePath });
		const cache = await loadAppCache({ cachePath });
		expect(cache.autumnsgrove).toEqual({ appId: 1, slug: "pi-review-a", keyPath: "/k.pem" });
		expect(cachedAppFor(cache, "ACME")?.appId).toBe(2);
		const mode = (await stat(cachePath)).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("returns an empty cache for a missing or malformed file", async () => {
		const dir = await tempDir();
		expect(await loadAppCache({ cachePath: join(dir, "missing.json") })).toEqual({});
		const bad = join(dir, "bad.json");
		await writeFile(bad, "not json", "utf8");
		expect(await loadAppCache({ cachePath: bad })).toEqual({});
		await writeFile(bad, JSON.stringify({ acme: { appId: "x" } }), "utf8");
		expect(await loadAppCache({ cachePath: bad })).toEqual({});
	});

	it("writes the key with mode 600", async () => {
		const dir = await tempDir();
		const path = await saveAppKey("Owner", "-----BEGIN PRIVATE KEY-----\nabc\n", { keyDir: dir });
		expect(path).toBe(join(dir, "owner.pem"));
		expect(await readFile(path, "utf8")).toContain("PRIVATE KEY");
		expect((await stat(path)).mode & 0o777).toBe(0o600);
	});
});
