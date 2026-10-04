import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SemanticSearchManager } from "../src/manager.ts";
import { DEFAULT_OLLAMA_MODEL } from "../src/embed/registry.ts";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
	delete process.env.PI_SEMSEARCH_CONFIG;
});

describe("SemanticSearchManager config safety", () => {
	it("constructs with defaults when the config file is poisoned", async () => {
		const dir = mkdtempSync(join(tmpdir(), "semsearch-manager-"));
		dirs.push(dir);
		const file = join(dir, "config.json");
		writeFileSync(file, JSON.stringify({ model: "mystery", dimensions: null }));
		process.env.PI_SEMSEARCH_CONFIG = file;

		// Extension registration constructs the real manager; it must never throw.
		const manager = new SemanticSearchManager();
		expect(manager.config.model).toBe(DEFAULT_OLLAMA_MODEL);
		expect(manager.config.dimensions).toBe(768);
		expect(manager.configError).toBeTruthy();
		await manager.close();
		// Closing twice is safe (pi may shut a session down more than once).
		await manager.close();
	});
});
