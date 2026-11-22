import { describe, expect, it } from "vitest";
import {
	DEFAULT_CONFIG,
	DEFAULT_MODELS,
	describeAttention,
	normalizeAttentionConfig,
	readAttentionConfig,
} from "./config.ts";

describe("normalizeAttentionConfig", () => {
	it("pins the documented cascade and thresholds by default", () => {
		const { config, warnings } = normalizeAttentionConfig(undefined);
		expect(warnings).toEqual([]);
		expect(config.models).toEqual(DEFAULT_MODELS);
		expect(config).toMatchObject({
			enabled: true,
			timeoutSeconds: 2.5,
			needsYouAt: 0.5,
			nothingToDoAt: 0.85,
			log: true,
		});
	});

	it("reads a full settings block", () => {
		const { config, warnings } = normalizeAttentionConfig(
			{
				enabled: false,
				models: ["openrouter/microsoft/microsoft-decision-1.1"],
				timeoutSeconds: 1.5,
				needsYouAt: 0.7,
				nothingToDoAt: 0.95,
				log: false,
			},
			"settings.json",
		);
		expect(warnings).toEqual([]);
		expect(config).toEqual({
			enabled: false,
			models: ["openrouter/microsoft/microsoft-decision-1.1"],
			timeoutSeconds: 1.5,
			needsYouAt: 0.7,
			nothingToDoAt: 0.95,
			log: false,
		});
	});

	it("treats an empty model list as rules only", () => {
		const { config } = normalizeAttentionConfig({ models: [] });
		expect(config.models).toEqual([]);
	});

	it("warns about malformed values instead of half-applying them", () => {
		const { config, warnings } = normalizeAttentionConfig(
			{
				models: "jev",
				timeoutSeconds: 0,
				needsYouAt: 2,
				nothingToDoAt: "high",
				log: "yes",
			},
			"project settings",
		);
		expect(config).toMatchObject({
			models: DEFAULT_MODELS,
			timeoutSeconds: DEFAULT_CONFIG.timeoutSeconds,
			needsYouAt: DEFAULT_CONFIG.needsYouAt,
			nothingToDoAt: DEFAULT_CONFIG.nothingToDoAt,
			log: DEFAULT_CONFIG.log,
		});
		expect(warnings).toHaveLength(5);
		expect(warnings[0]).toContain("project settings");
	});

	it("warns when the block is not an object", () => {
		expect(normalizeAttentionConfig([]).warnings).toHaveLength(1);
		expect(normalizeAttentionConfig("on").warnings).toHaveLength(1);
	});

	it("drops non-string model entries with a warning", () => {
		const { config, warnings } = normalizeAttentionConfig({ models: ["a/b", 3, "  "] });
		expect(config.models).toEqual(["a/b"]);
		expect(warnings).toHaveLength(1);
	});
});

describe("readAttentionConfig", () => {
	it("reads only the attention key", () => {
		expect(readAttentionConfig({ attention: { enabled: false } })).toEqual({ enabled: false });
		expect(readAttentionConfig({})).toBeUndefined();
		expect(readAttentionConfig(null)).toBeUndefined();
	});
});

describe("describeAttention", () => {
	it("names the cascade, the rules-only case, and the thresholds", () => {
		expect(describeAttention(DEFAULT_CONFIG).join("\n")).toContain("openrouter/typesafe/jev-1.14 → ");
		expect(describeAttention({ ...DEFAULT_CONFIG, models: [] }).join("\n")).toContain("(rules only)");
		expect(describeAttention(DEFAULT_CONFIG).join("\n")).toContain("needsYouAt 0.5");
	});
});
