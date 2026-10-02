import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	emptyPins,
	loadPins,
	parsePinsFile,
	savePins,
	type ProviderPin,
} from "./config.ts";

const validPin: ProviderPin = {
	tag: "deepseek",
	providerName: "DeepSeek",
	allowFallbacks: false,
	quantizations: [],
	updatedAt: "2026-10-02T00:00:00.000Z",
};

const tempDirs: string[] = [];

const tempDir = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "provider-pinning-"));
	tempDirs.push(dir);
	return dir;
};

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("parsePinsFile", () => {
	it("keeps valid pins and drops malformed ones", () => {
		const parsed = parsePinsFile({
			version: 1,
			pins: {
				"deepseek/deepseek-v4.1-flash": validPin,
				"bad/model": { tag: "x" },
			},
		});
		expect(Object.keys(parsed.pins)).toEqual(["deepseek/deepseek-v4.1-flash"]);
	});

	it("returns an empty file for junk", () => {
		expect(parsePinsFile(null)).toEqual(emptyPins());
		expect(parsePinsFile({ pins: "nope" })).toEqual(emptyPins());
	});
});

describe("pins persistence", () => {
	it("round-trips through an atomic write", () => {
		const path = join(tempDir(), "provider-pins.json");
		savePins(path, {
			version: 1,
			pins: { "deepseek/deepseek-v4.1-flash": validPin },
		});
		const raw = readFileSync(path, "utf8");
		expect(raw.endsWith("\n")).toBe(true);
		expect(loadPins(path).pins["deepseek/deepseek-v4.1-flash"]?.tag).toBe("deepseek");
	});

	it("falls back to empty on a corrupt file", () => {
		const path = join(tempDir(), "provider-pins.json");
		writeFileSync(path, "{ not json", "utf8");
		expect(loadPins(path)).toEqual(emptyPins());
	});
});
