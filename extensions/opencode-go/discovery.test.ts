import { describe, expect, it } from "vitest";
import { baseUrlFor, buildDiscoveredModels, inferApi } from "./discovery.ts";

describe("inferApi", () => {
	it("routes known Go families to their wire APIs", () => {
		expect(inferApi("claude-haiku-5-5")).toBe("anthropic-messages");
		expect(inferApi("minimax-m2.5")).toBe("anthropic-messages");
		expect(inferApi("qwen3.6-plus")).toBe("anthropic-messages");
		expect(inferApi("qwen3.8-max")).toBe("openai-completions");
		expect(inferApi("glm-5.1")).toBe("openai-completions");
		expect(inferApi("kimi-k2.6")).toBe("openai-completions");
		expect(inferApi("gpt-6-luna")).toBe("openai-responses");
		expect(inferApi("grok-4.5")).toBe("openai-responses");
		expect(inferApi("muse-spark-1.3-contributor")).toBe("openai-responses");
	});
});

describe("baseUrlFor", () => {
	it("drops /v1 for the Anthropic surface", () => {
		expect(baseUrlFor("anthropic-messages")).toBe("https://opencode.ai/zen/go");
		expect(baseUrlFor("openai-completions")).toBe("https://opencode.ai/zen/go/v1");
		expect(baseUrlFor("openai-responses")).toBe("https://opencode.ai/zen/go/v1");
	});
});

describe("buildDiscoveredModels", () => {
	it("builds overlay models for live ids missing from the baseline", () => {
		const dev = {
			"glm-5.1": {
				name: "GLM-5.1",
				reasoning: true,
				modalities: { input: ["text"] },
				limit: { context: 200_000, output: 131_072 },
				cost: { input: 1.4, output: 4.4, cache_read: 0.26 },
			},
			"claude-haiku-5-5": {
				name: "Claude Haiku 5.5",
				modalities: { input: ["text", "image"] },
				limit: { context: 200_000, output: 64_000 },
				cost: { input: 0.1, output: 0.5, cache_read: 0.01 },
			},
		};
		const models = buildDiscoveredModels(
			["glm-5.2", "glm-5.1", "claude-haiku-5-5"],
			dev,
			new Set(["glm-5.2"])
		);
		expect(models.map((model) => model.id)).toEqual(["glm-5.1", "claude-haiku-5-5"]);
		const glm = models[0]!;
		expect(glm.api).toBe("openai-completions");
		expect(glm.baseUrl).toBe("https://opencode.ai/zen/go/v1");
		expect(glm.contextWindow).toBe(200_000);
		expect(glm.cost.input).toBe(1.4);
		const haiku = models[1]!;
		expect(haiku.api).toBe("anthropic-messages");
		expect(haiku.baseUrl).toBe("https://opencode.ai/zen/go");
		expect(haiku.input).toEqual(["text", "image"]);
	});

	it("falls back to conservative defaults without models.dev metadata", () => {
		const models = buildDiscoveredModels(["omen-alpha"], {}, new Set());
		expect(models[0]!.contextWindow).toBe(131_072);
		expect(models[0]!.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(models[0]!.input).toEqual(["text"]);
	});
});
