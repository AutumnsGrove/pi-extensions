import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig, sanitizeConfig } from "../config.ts";

const dirs: string[] = [];
const tmp = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "pi-memory-config-"));
	dirs.push(dir);
	return dir;
};

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("sanitizeConfig", () => {
	it("drops unknown keys and bad types", () => {
		const clean = sanitizeConfig({
			enabled: "yes",
			scope: "galaxy",
			store: 7,
			model: "  ",
			semantic: 1,
			wat: true,
		});
		expect(clean.enabled).toBeUndefined();
		expect(clean.scope).toBe("cwd");
		expect(clean.store).toBe("pi");
		expect(clean.model).toBeUndefined();
		expect(clean.semantic).toBeUndefined();
		expect(clean).not.toHaveProperty("wat");
	});

	it("clamps numbers into usable ranges", () => {
		const clean = sanitizeConfig({
			extraction: { every: 0, minMessages: -3, maxWrites: 1000 },
			recall: { maxFiles: 99, maxBytes: 1 },
			index: { maxLines: 1, maxBytes: 1 },
			dream: { afterHours: 0, afterSessions: 0 },
		});
		expect(clean.extraction).toEqual({ every: 1, minMessages: 1, maxWrites: 20 });
		expect(clean.recall).toEqual({ maxFiles: 20, maxBytes: 1 });
		expect(clean.index).toEqual({ maxLines: 20, maxBytes: 1024 });
		expect(clean.dream).toEqual({ afterHours: 1, afterSessions: 1 });
	});

	it("ignores a non-object", () => {
		expect(sanitizeConfig(null)).toEqual({});
		expect(sanitizeConfig([1, 2])).toEqual({});
		expect(sanitizeConfig("nope")).toEqual({});
	});
});

describe("loadConfig", () => {
	it("merges file values over defaults", () => {
		const file = join(tmp(), "memory.json");
		writeFileSync(file, JSON.stringify({ scope: "git-root", extraction: { every: 7 } }));
		const { config } = loadConfig({}, file);
		expect(config.scope).toBe("git-root");
		expect(config.extraction.every).toBe(7);
		expect(config.extraction.enabled).toBe(true);
		expect(config.recall.maxFiles).toBe(DEFAULT_CONFIG.recall.maxFiles);
	});

	it("lets the environment win over the file", () => {
		const file = join(tmp(), "memory.json");
		writeFileSync(file, JSON.stringify({ scope: "cwd", model: "file/model" }));
		const { config } = loadConfig(
			{ PI_MEMORY_SCOPE: "git-root", PI_MEMORY_MODEL: "env/model" },
			file
		);
		expect(config.scope).toBe("git-root");
		expect(config.model).toBe("env/model");
	});

	it("keeps file values for fields the environment does not set", () => {
		const file = join(tmp(), "memory.json");
		writeFileSync(
			file,
			JSON.stringify({
				dream: { afterHours: 48, afterSessions: 9 },
				extraction: { every: 7, maxWrites: 2 },
			})
		);
		const { config } = loadConfig(
			{ PI_MEMORY_AUTO_DREAM: "1", PI_MEMORY_EXTRACT_EVERY: "5" },
			file
		);
		expect(config.dream).toEqual({ auto: true, afterHours: 48, afterSessions: 9 });
		expect(config.extraction).toEqual({
			enabled: true,
			every: 5,
			minMessages: 3,
			maxWrites: 2,
		});
	});

	it("turns every path off with one switch", () => {
		const file = join(tmp(), "memory.json");
		writeFileSync(file, JSON.stringify({ enabled: true }));
		const { config } = loadConfig({ PI_MEMORY_DISABLED: "1" }, file);
		expect(config.enabled).toBe(false);
		expect(config.inlineSave).toBe(false);
		expect(config.extraction.enabled).toBe(false);
		expect(config.recall.enabled).toBe(false);
	});

	it("survives a corrupt file", () => {
		const file = join(tmp(), "memory.json");
		writeFileSync(file, "{ nope");
		const { config } = loadConfig({}, file);
		expect(config.enabled).toBe(true);
		expect(config.extraction.every).toBe(3);
	});
});
