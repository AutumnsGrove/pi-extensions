import { describe, expect, it } from "vitest";
import { loadEmbedder } from "../embed.ts";

describe("loadEmbedder", () => {
	it("loads semantic-search's embedding profile without connecting", async () => {
		const result = await loadEmbedder({ PI_SEMSEARCH_CONFIG: "/nonexistent/memory-test.json" });
		expect(result.embedder ?? result.error).toBeDefined();
		expect(result.embedder?.dimensions).toBeGreaterThan(0);
		expect(typeof result.embedder?.embed).toBe("function");
	});
});
