import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_MAX_ITEMS,
	clampMaxItems,
	defaultConfig,
	normalizeConfig,
	readConfig,
	writeConfig,
} from "./config.ts";

let work: string;
let path: string;

beforeEach(() => {
	work = mkdtempSync(join(tmpdir(), "transcript-window-"));
	path = join(work, "transcript-window.json");
});

afterEach(() => {
	rmSync(work, { recursive: true, force: true });
});

describe("config", () => {
	it("treats a missing file as the default", () => {
		expect(readConfig(path)).toEqual(defaultConfig());
	});

	it("round-trips the config", () => {
		writeConfig({ version: 1, enabled: false, maxItems: 12 }, path);
		expect(readConfig(path)).toEqual({
			version: 1,
			enabled: false,
			maxItems: 12,
		});
	});

	it("falls back on malformed JSON", () => {
		writeFileSync(path, "{ not json");
		expect(readConfig(path)).toEqual(defaultConfig());
	});

	it("normalizes loose shapes", () => {
		expect(normalizeConfig({ enabled: "no", maxItems: "40" })).toEqual(
			defaultConfig()
		);
		expect(normalizeConfig({ enabled: false, maxItems: 999999 })).toEqual({
			version: 1,
			enabled: false,
			maxItems: 5000,
		});
		expect(normalizeConfig({ enabled: true, maxItems: 0 })).toEqual({
			version: 1,
			enabled: true,
			maxItems: 0,
		});
	});

	it("clamps item counts to the supported range", () => {
		expect(clampMaxItems(1)).toBe(4);
		expect(clampMaxItems(12.6)).toBe(13);
		expect(clampMaxItems(100000)).toBe(5000);
		expect(clampMaxItems(Number.NaN)).toBe(DEFAULT_MAX_ITEMS);
	});
});
