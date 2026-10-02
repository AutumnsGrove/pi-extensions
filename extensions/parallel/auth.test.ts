import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearParallelApiKey, generatePkce, readParallelApiKey, storeParallelApiKey } from "./auth.ts";

const tempDirs: string[] = [];
const tempDir = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "parallel-auth-"));
	tempDirs.push(dir);
	return dir;
};

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("generatePkce", () => {
	it("produces a base64url verifier and a 43-char S256 challenge", () => {
		const { verifier, challenge } = generatePkce();
		expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(challenge).toHaveLength(43);
		expect(verifier).not.toBe(challenge);
	});
});

describe("Parallel API key storage", () => {
	it("round-trips a key through auth.json", () => {
		const path = join(tempDir(), "auth.json");
		storeParallelApiKey("parallel-key", path);
		expect(readParallelApiKey(path)).toBe("parallel-key");
		clearParallelApiKey(path);
		expect(readParallelApiKey(path)).toBeUndefined();
	});

	it("preserves other providers and the api_key shape", () => {
		const path = join(tempDir(), "auth.json");
		writeFileSync(path, JSON.stringify({ openrouter: { type: "api_key", key: "or" } }), "utf-8");
		storeParallelApiKey("parallel-key", path);
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		expect(parsed.openrouter).toEqual({ type: "api_key", key: "or" });
		expect(parsed.parallel).toEqual({ type: "api_key", key: "parallel-key" });
	});

	it("refuses to overwrite a corrupt auth.json", () => {
		const path = join(tempDir(), "auth.json");
		writeFileSync(path, "{ not json", "utf-8");
		expect(() => storeParallelApiKey("key", path)).toThrow(/Refusing to overwrite/);
	});
});
