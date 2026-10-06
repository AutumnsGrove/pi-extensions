/**
 * Persistent limit store for the context-window extension.
 *
 * Lives at `<agent-dir>/context-window.json` and maps a base model
 * (`provider/modelId`) to the reduced window the user chose. It is the source
 * of truth; `models.json` only carries the derived model definitions the
 * registry needs at startup.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { readJsonFile, writeJsonFile } from "./json.ts";

export const CONFIG_VERSION = 1;

export interface LimitEntry {
	/** Real model id the limit derives from. */
	baseId: string;
	/** Effective context window, in tokens. */
	limit: number;
	/** Registry id of the derived model (`<baseId>-<slug>`). */
	variantId: string;
	/** ISO timestamp of the last change. */
	updatedAt: string;
}

export interface LimitConfig {
	version: number;
	/** Limits keyed by `provider/baseId`. */
	models: Record<string, LimitEntry>;
}

export function emptyLimitConfig(): LimitConfig {
	return { version: CONFIG_VERSION, models: {} };
}

export function limitConfigPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "context-window.json");
}

export function modelKey(provider: string, modelId: string): string {
	return `${provider}/${modelId}`;
}

/** Read the store, tolerating a missing or empty file. */
export function readLimitConfig(path: string = limitConfigPath()): LimitConfig {
	const parsed = readJsonFile<Partial<LimitConfig>>(path);
	if (!parsed || typeof parsed !== "object") {
		return emptyLimitConfig();
	}
	const models: Record<string, LimitEntry> = {};
	const raw = parsed.models;
	if (raw && typeof raw === "object") {
		for (const [key, entry] of Object.entries(raw)) {
			const normalized = normalizeEntry(entry);
			if (normalized) {
				models[key] = normalized;
			}
		}
	}
	return { version: CONFIG_VERSION, models };
}

function normalizeEntry(value: unknown): LimitEntry | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const entry = value as Record<string, unknown>;
	const baseId = typeof entry.baseId === "string" ? entry.baseId : undefined;
	const variantId = typeof entry.variantId === "string" ? entry.variantId : undefined;
	const limit = typeof entry.limit === "number" && Number.isFinite(entry.limit) ? entry.limit : undefined;
	if (!baseId || !variantId || !limit || limit <= 0) {
		return undefined;
	}
	return {
		baseId,
		limit: Math.round(limit),
		variantId,
		updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : new Date(0).toISOString(),
	};
}

export function writeLimitConfig(config: LimitConfig, path: string = limitConfigPath()): void {
	writeJsonFile(path, { version: CONFIG_VERSION, models: config.models });
}

export function getLimit(
	config: LimitConfig,
	provider: string,
	modelId: string
): LimitEntry | undefined {
	return config.models[modelKey(provider, modelId)];
}

/** Return a new config with the entry replaced; set the timestamp when omitted. */
export function setLimit(
	config: LimitConfig,
	provider: string,
	entry: Omit<LimitEntry, "updatedAt"> & { updatedAt?: string }
): LimitConfig {
	const key = modelKey(provider, entry.baseId);
	return {
		...config,
		models: {
			...config.models,
			[key]: { ...entry, updatedAt: entry.updatedAt ?? new Date().toISOString() },
		},
	};
}

export function removeLimit(
	config: LimitConfig,
	provider: string,
	modelId: string
): LimitConfig {
	const key = modelKey(provider, modelId);
	if (!(key in config.models)) {
		return config;
	}
	const models = { ...config.models };
	delete models[key];
	return { ...config, models };
}

/** All entries, flattened to `{ key, entry }` for listing. */
export function listLimits(config: LimitConfig): Array<{ key: string; provider: string; entry: LimitEntry }> {
	return Object.entries(config.models)
		.map(([key, entry]) => {
			const slash = key.indexOf("/");
			const provider = slash >= 0 ? key.slice(0, slash) : key;
			return { key, provider, entry };
		})
		.sort((a, b) => a.key.localeCompare(b.key));
}
