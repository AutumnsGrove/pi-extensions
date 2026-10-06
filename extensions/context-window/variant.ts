/**
 * Derived "context window" models.
 *
 * Pi has no first-class way to lower a model's context window, so the
 * extension materializes a real model definition into `models.json`: a full
 * copy of the base model with a smaller `contextWindow` and a derived id
 * (`deepseek-v4.1-flash-400k`). Because it is a normal registry model, pi's
 * own auto-compaction, footer percentage, and `getContextUsage()` all respect
 * it, it appears in `/model`, and a resumed session restores it without the
 * extension being involved.
 *
 * `models.json` upserts definitions by id, so writing a variant never disturbs
 * other providers or models.
 */

import type { Model } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { formatTokenCount, sizeSlug } from "./format.ts";

export interface ModelDefinition {
	id: string;
	name?: string;
	api?: string;
	baseUrl?: string;
	reasoning?: boolean;
	thinkingLevelMap?: unknown;
	input?: string[];
	inputLimits?: unknown;
	cost?: unknown;
	promptCache?: unknown;
	contextWindow?: number;
	maxTokens?: number;
	samplingParams?: Record<string, unknown>;
	headers?: Record<string, string>;
	compat?: unknown;
	type?: string;
}

export interface ModelsProviderConfig {
	models?: ModelDefinition[];
	[key: string]: unknown;
}

export interface ModelsJson {
	providers?: Record<string, ModelsProviderConfig>;
	[key: string]: unknown;
}

export function modelsJsonPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "models.json");
}

export function variantIdFor(baseId: string, limit: number): string {
	return `${baseId}-${sizeSlug(limit)}`;
}

export function variantName(baseName: string, limit: number): string {
	return `${baseName} [${formatTokenCount(limit)} ctx]`;
}

/** Build the `models.json` definition for a reduced-window copy of `base`. */
export function buildVariantDefinition(
	base: Model<any>,
	limit: number,
	variantId: string
): ModelDefinition {
	const definition: ModelDefinition = {
		id: variantId,
		name: variantName(base.name, limit),
		api: base.api,
		baseUrl: base.baseUrl,
		reasoning: base.reasoning,
		input: [...base.input],
		cost: base.cost,
		contextWindow: limit,
		maxTokens: base.maxTokens,
	};
	if (base.thinkingLevelMap) {
		definition.thinkingLevelMap = base.thinkingLevelMap;
	}
	if (base.inputLimits) {
		definition.inputLimits = base.inputLimits;
	}
	if (base.promptCache) {
		definition.promptCache = base.promptCache;
	}
	if (base.samplingParams) {
		definition.samplingParams = base.samplingParams;
	}
	if (base.compat) {
		definition.compat = base.compat;
	}
	if (base.headers) {
		definition.headers = base.headers;
	}
	return definition;
}

/** Return a new models.json object with the provider's model list updated. */
export function upsertVariant(
	models: ModelsJson,
	provider: string,
	definition: ModelDefinition
): ModelsJson {
	const providers = { ...(models.providers ?? {}) };
	const providerConfig: ModelsProviderConfig = { ...(providers[provider] ?? {}) };
	const existing = providerConfig.models ?? [];
	const index = existing.findIndex((entry) => entry.id === definition.id);
	const nextModels = [...existing];
	if (index >= 0) {
		nextModels[index] = definition;
	} else {
		nextModels.push(definition);
	}
	providerConfig.models = nextModels;
	providers[provider] = providerConfig;
	return { ...models, providers };
}

/** Return a new models.json object without the given model id. */
export function removeVariant(models: ModelsJson, provider: string, id: string): ModelsJson {
	const providerConfig = models.providers?.[provider];
	if (!providerConfig?.models?.some((entry) => entry.id === id)) {
		return models;
	}
	const providers = { ...(models.providers ?? {}) };
	providers[provider] = {
		...providerConfig,
		models: providerConfig.models.filter((entry) => entry.id !== id),
	};
	return { ...models, providers };
}

export function findVariant(
	models: ModelsJson,
	provider: string,
	id: string
): ModelDefinition | undefined {
	return models.providers?.[provider]?.models?.find((entry) => entry.id === id);
}
