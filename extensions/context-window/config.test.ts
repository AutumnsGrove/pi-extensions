import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	emptyLimitConfig,
	getLimit,
	listLimits,
	modelKey,
	readLimitConfig,
	removeLimit,
	setLimit,
	writeLimitConfig,
} from "./config.ts";

let work: string;
let path: string;

beforeEach(() => {
	work = mkdtempSync(join(tmpdir(), "context-window-"));
	path = join(work, "context-window.json");
});

afterEach(() => {
	rmSync(work, { recursive: true, force: true });
});

describe("limit store", () => {
	it("treats a missing file as empty", () => {
		expect(readLimitConfig(path)).toEqual(emptyLimitConfig());
	});

	it("round-trips entries", () => {
		const config = setLimit(emptyLimitConfig(), "deepseek", {
			baseId: "deepseek-v4.1-flash",
			limit: 400000,
			variantId: "deepseek-v4.1-flash-400k",
		});
		writeLimitConfig(config, path);
		const loaded = readLimitConfig(path);
		expect(getLimit(loaded, "deepseek", "deepseek-v4.1-flash")).toEqual({
			baseId: "deepseek-v4.1-flash",
			limit: 400000,
			variantId: "deepseek-v4.1-flash-400k",
			updatedAt: expect.any(String),
		});
	});

	it("replaces an existing entry for the same base", () => {
		let config = setLimit(emptyLimitConfig(), "deepseek", {
			baseId: "deepseek-v4.1-flash",
			limit: 400000,
			variantId: "deepseek-v4.1-flash-400k",
		});
		config = setLimit(config, "deepseek", {
			baseId: "deepseek-v4.1-flash",
			limit: 300000,
			variantId: "deepseek-v4.1-flash-300k",
		});
		expect(Object.keys(config.models)).toHaveLength(1);
		expect(getLimit(config, "deepseek", "deepseek-v4.1-flash")?.limit).toBe(300000);
	});

	it("removes entries", () => {
		const config = setLimit(emptyLimitConfig(), "deepseek", {
			baseId: "deepseek-v4.1-flash",
			limit: 400000,
			variantId: "deepseek-v4.1-flash-400k",
		});
		expect(removeLimit(config, "deepseek", "deepseek-v4.1-flash").models).toEqual({});
		expect(removeLimit(config, "deepseek", "missing")).toBe(config);
	});

	it("drops malformed entries instead of throwing", () => {
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				models: {
					"a/b": { baseId: "b", limit: 100000, variantId: "b-100k" },
					"bad/one": { limit: 100000 },
					"bad/two": { baseId: "x", limit: -1, variantId: "x" },
				},
			}),
			"utf8"
		);
		const loaded = readLimitConfig(path);
		expect(Object.keys(loaded.models)).toEqual(["a/b"]);
	});

	it("lists entries with their provider and sorts by key", () => {
		let config = emptyLimitConfig();
		config = setLimit(config, "openrouter", {
			baseId: "z/model",
			limit: 250000,
			variantId: "z/model-250k",
		});
		config = setLimit(config, "deepseek", {
			baseId: "deepseek-v4.1-flash",
			limit: 400000,
			variantId: "deepseek-v4.1-flash-400k",
		});
		const listed = listLimits(config);
		expect(listed.map((item) => item.provider)).toEqual(["deepseek", "openrouter"]);
		expect(listed[1]?.entry.variantId).toBe("z/model-250k");
		expect(modelKey("deepseek", "deepseek-v4.1-flash")).toBe("deepseek/deepseek-v4.1-flash");
	});
});
