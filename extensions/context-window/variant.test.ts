import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	buildVariantDefinition,
	findVariant,
	removeVariant,
	upsertVariant,
	variantIdFor,
	variantName,
	type ModelsJson,
} from "./variant.ts";

function baseModel(): Model<any> {
	return {
		id: "deepseek-v4.1-flash",
		name: "DeepSeek V4.1 Flash",
		api: "openai-completions",
		provider: "deepseek",
		baseUrl: "https://api.deepseek.com",
		input: ["text", "image"],
		cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.1 },
		reasoning: true,
		contextWindow: 1_000_000,
		maxTokens: 65536,
		thinkingLevelMap: { off: "off", low: "low" },
		samplingParams: { temperature: 0.7 },
	} as unknown as Model<any>;
}

describe("variant naming", () => {
	it("derives ids from the base id and size", () => {
		expect(variantIdFor("deepseek-v4.1-flash", 400000)).toBe("deepseek-v4.1-flash-400k");
		expect(variantIdFor("deepseek-v4.1-flash", 1_500_000)).toBe("deepseek-v4.1-flash-1.5m");
	});

	it("labels the derived model with the window", () => {
		expect(variantName("DeepSeek V4.1 Flash", 400000)).toBe("DeepSeek V4.1 Flash [400k ctx]");
	});
});

describe("buildVariantDefinition", () => {
	it("copies the base model and lowers the window", () => {
		const definition = buildVariantDefinition(baseModel(), 400000, "deepseek-v4.1-flash-400k");
		expect(definition).toMatchObject({
			id: "deepseek-v4.1-flash-400k",
			name: "DeepSeek V4.1 Flash [400k ctx]",
			api: "openai-completions",
			baseUrl: "https://api.deepseek.com",
			reasoning: true,
			contextWindow: 400000,
			maxTokens: 65536,
		});
		expect(definition.input).toEqual(["text", "image"]);
		expect(definition.cost).toEqual(baseModel().cost);
		expect(definition.thinkingLevelMap).toEqual({ off: "off", low: "low" });
	});

	it("does not mutate or alias the input arrays", () => {
		const base = baseModel();
		const definition = buildVariantDefinition(base, 400000, "x-400k");
		definition.input?.push("audio");
		expect(base.input).toEqual(["text", "image"]);
	});
});

describe("models.json edits", () => {
	it("adds a variant without touching other providers or models", () => {
		const models: ModelsJson = {
			providers: {
				deepseek: { models: [{ id: "deepseek-v4.1-flash" }] },
				other: { models: [{ id: "other-model" }] },
			},
		};
		const next = upsertVariant(models, "deepseek", { id: "deepseek-v4.1-flash-400k", contextWindow: 400000 });
		expect(next.providers?.deepseek?.models?.map((m) => m.id)).toEqual([
			"deepseek-v4.1-flash",
			"deepseek-v4.1-flash-400k",
		]);
		expect(next.providers?.other?.models).toEqual([{ id: "other-model" }]);
		// input untouched
		expect(models.providers?.deepseek?.models).toHaveLength(1);
	});

	it("replaces an existing variant by id", () => {
		let models: ModelsJson = { providers: { deepseek: { models: [] } } };
		models = upsertVariant(models, "deepseek", { id: "v", contextWindow: 400000 });
		models = upsertVariant(models, "deepseek", { id: "v", contextWindow: 300000 });
		expect(models.providers?.deepseek?.models).toEqual([{ id: "v", contextWindow: 300000 }]);
	});

	it("removes only the requested variant", () => {
		const models: ModelsJson = {
			providers: {
				deepseek: { models: [{ id: "base" }, { id: "variant" }] },
			},
		};
		const next = removeVariant(models, "deepseek", "variant");
		expect(next.providers?.deepseek?.models).toEqual([{ id: "base" }]);
		expect(findVariant(next, "deepseek", "variant")).toBeUndefined();
		expect(removeVariant(next, "deepseek", "missing")).toBe(next);
	});
});
