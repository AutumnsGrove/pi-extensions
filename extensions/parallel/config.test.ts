import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig } from "./config.ts";

const tempDirs: string[] = [];
const tempDir = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "parallel-config-"));
	tempDirs.push(dir);
	return dir;
};

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

const write = (value: unknown): string => {
	const path = join(tempDir(), "config.json");
	writeFileSync(path, JSON.stringify(value), "utf-8");
	return path;
};

describe("loadConfig", () => {
	it("returns defaults for a missing or corrupt file", () => {
		expect(loadConfig(join(tempDir(), "missing.json"))).toEqual(DEFAULT_CONFIG);
		expect(loadConfig(write("not an object"))).toEqual(DEFAULT_CONFIG);
	});

	it("merges overrides over the defaults", () => {
		const config = loadConfig(write({ hardLimitQueries: 4_500, searchMode: "advanced" }));
		expect(config.hardLimitQueries).toBe(4_500);
		expect(config.searchMode).toBe("advanced");
		expect(config.softLimitQueries).toBe(DEFAULT_CONFIG.softLimitQueries);
	});

	it("clamps the soft limit to the hard limit", () => {
		const config = loadConfig(write({ softLimitQueries: 9_000, hardLimitQueries: 4_000 }));
		expect(config.softLimitQueries).toBe(4_000);
	});

	it("rejects invalid numbers and modes", () => {
		const config = loadConfig(
			write({
				softLimitQueries: -1,
				hardLimitQueries: 0,
				hardLimitUsd: "lots",
				searchMode: "warp",
				maxSummaryChars: 0,
			})
		);
		expect(config.hardLimitQueries).toBe(DEFAULT_CONFIG.hardLimitQueries);
		expect(config.hardLimitUsd).toBe(DEFAULT_CONFIG.hardLimitUsd);
		expect(config.searchMode).toBe(DEFAULT_CONFIG.searchMode);
		expect(config.maxSummaryChars).toBe(DEFAULT_CONFIG.maxSummaryChars);
	});

	it("defaults to a 3k soft / 4k hard / $4 budget", () => {
		expect(DEFAULT_CONFIG.softLimitQueries).toBe(3_000);
		expect(DEFAULT_CONFIG.hardLimitQueries).toBe(4_000);
		expect(DEFAULT_CONFIG.hardLimitUsd).toBe(4);
	});
});
