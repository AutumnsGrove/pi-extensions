/**
 * Live OpenCode Go model discovery.
 *
 * `GET https://opencode.ai/zen/go/v1/models` returns only ids, so metadata comes
 * from pi's built-in catalog (for models it already knows) and, for newer ids,
 * from models.dev. The resolved overlay is cached on disk so startup stays fast
 * and works offline; the provider is registered with the built-in catalog plus
 * this overlay.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { PROVIDER_ID } from "./config.ts";

export const GO_BASE_URL = "https://opencode.ai/zen/go/v1";
export const GO_ANTHROPIC_BASE_URL = "https://opencode.ai/zen/go";
const MODELS_DEV_URL = "https://models.dev/api.json";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_CONTEXT = 131_072;
const DEFAULT_MAX_TOKENS = 16_384;

export type RouteApi = "openai-completions" | "openai-responses" | "anthropic-messages";

/**
 * Route a Go model id to its wire API. Mirrors OpenCode's endpoint table and the
 * built-in catalog; conservative default is OpenAI-compatible chat completions.
 */
export function inferApi(id: string): RouteApi {
	if (/^claude-/i.test(id)) return "anthropic-messages";
	if (/^minimax-/i.test(id)) return "anthropic-messages";
	if (/^qwen3\.8-max$/i.test(id)) return "openai-completions";
	if (/^qwen/i.test(id)) return "anthropic-messages";
	if (/^(gpt-|grok|muse-spark-)/i.test(id)) return "openai-responses";
	return "openai-completions";
}

export function baseUrlFor(api: RouteApi): string {
	return api === "anthropic-messages" ? GO_ANTHROPIC_BASE_URL : GO_BASE_URL;
}

export interface DevModel {
	name?: string;
	reasoning?: boolean;
	modalities?: { input?: string[] };
	limit?: { context?: number; output?: number };
	cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
}

interface ModelCache {
	checkedAt: number;
	models: Model<Api>[];
}

const cachePath = (): string => join(getAgentDir(), "opencode-go-models.json");

const asRecord = (value: unknown): Record<string, unknown> | null =>
	typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

/** Fetch the live Go model ids (workspace-filtered when a key is supplied). */
export async function fetchLiveGoModelIds(
	token: string | undefined,
	signal: AbortSignal
): Promise<string[]> {
	const response = await fetch(`${GO_BASE_URL}/models`, {
		headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
		signal,
	});
	if (!response.ok) throw new Error(`Go models request failed (${response.status}).`);
	const payload = (await response.json().catch(() => undefined)) as unknown;
	const rows = Array.isArray(asRecord(payload)?.data)
		? (asRecord(payload)?.data as unknown[])
		: Array.isArray(payload)
			? payload
			: [];
	const ids: string[] = [];
	for (const row of rows) {
		const id = typeof row === "string" ? row : asRecord(row)?.id;
		if (typeof id === "string" && id.length > 0) ids.push(id);
	}
	return ids;
}

/** models.dev `opencode-go` metadata. */
export async function loadModelsDev(signal: AbortSignal): Promise<Record<string, DevModel>> {
	try {
		const response = await fetch(MODELS_DEV_URL, { signal });
		if (!response.ok) return {};
		const payload = (await response.json()) as unknown;
		const models = asRecord(asRecord(asRecord(payload)?.["opencode-go"])?.models);
		return models ? (models as Record<string, DevModel>) : {};
	} catch {
		return {};
	}
}

/** Build overlay models for live ids the built-in catalog does not already cover. */
export function buildDiscoveredModels(
	liveIds: readonly string[],
	dev: Record<string, DevModel>,
	baselineIds: ReadonlySet<string>
): Model<Api>[] {
	const models: Model<Api>[] = [];
	for (const id of liveIds) {
		if (baselineIds.has(id)) continue;
		const meta = dev[id];
		const api = inferApi(id);
		const limit = meta?.limit ?? {};
		const cost = meta?.cost ?? {};
		const input = (meta?.modalities?.input ?? ["text"]).filter(
			(entry): entry is "text" | "image" => entry === "text" || entry === "image"
		);
		models.push({
			id,
			name: meta?.name ?? id,
			api,
			provider: PROVIDER_ID,
			baseUrl: baseUrlFor(api),
			reasoning: meta?.reasoning ?? false,
			input: input.length > 0 ? input : ["text"],
			cost: {
				input: cost.input ?? 0,
				output: cost.output ?? 0,
				cacheRead: cost.cache_read ?? 0,
				cacheWrite: cost.cache_write ?? 0,
			},
			contextWindow: limit.context ?? DEFAULT_CONTEXT,
			maxTokens: limit.output ?? DEFAULT_MAX_TOKENS,
		} as unknown as Model<Api>);
	}
	return models;
}

export function loadModelCache(): { models: Model<Api>[]; fresh: boolean } | undefined {
	try {
		const cached = JSON.parse(readFileSync(cachePath(), "utf8")) as ModelCache;
		if (!Array.isArray(cached?.models)) return undefined;
		return {
			models: cached.models,
			fresh: Date.now() - cached.checkedAt < CACHE_TTL_MS,
		};
	} catch {
		return undefined;
	}
}

function saveModelCache(models: Model<Api>[]): void {
	try {
		writeFileSync(cachePath(), JSON.stringify({ checkedAt: Date.now(), models }), "utf8");
	} catch {
		// Best effort; discovery still works this run.
	}
}

/** Fetch + enrich + cache the Go model overlay. */
export async function refreshGoModels(
	baselineIds: ReadonlySet<string>,
	token: string | undefined,
	signal: AbortSignal
): Promise<Model<Api>[]> {
	const [liveIds, dev] = await Promise.all([fetchLiveGoModelIds(token, signal), loadModelsDev(signal)]);
	const models = buildDiscoveredModels(liveIds, dev, baselineIds);
	saveModelCache(models);
	return models;
}
