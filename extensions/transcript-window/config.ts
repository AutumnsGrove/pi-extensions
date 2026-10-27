/**
 * Persistent settings for the transcript-window extension.
 *
 * Display-only state, so it lives outside the session at
 * `<agent-dir>/transcript-window.json`. It does not affect model context.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const CONFIG_VERSION = 1 as const;
/** A dozen-ish tool calls plus the surrounding messages. */
export const DEFAULT_MAX_ITEMS = 100;
export const MIN_MAX_ITEMS = 4;
export const MAX_MAX_ITEMS = 5000;

export interface TranscriptWindowConfig {
	version: typeof CONFIG_VERSION;
	enabled: boolean;
	/** Trailing chat components to render. 0 means unlimited. */
	maxItems: number;
}

export function defaultConfig(): TranscriptWindowConfig {
	return {
		version: CONFIG_VERSION,
		enabled: true,
		maxItems: DEFAULT_MAX_ITEMS,
	};
}

export function configPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, "transcript-window.json");
}

/** Clamp an item count to the supported range. */
export function clampMaxItems(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_MAX_ITEMS;
	return Math.min(MAX_MAX_ITEMS, Math.max(MIN_MAX_ITEMS, Math.round(value)));
}

/** Accept loose/older config shapes and fall back to defaults. */
export function normalizeConfig(value: unknown): TranscriptWindowConfig {
	const fallback = defaultConfig();
	if (!value || typeof value !== "object") return fallback;
	const record = value as Record<string, unknown>;
	const enabled =
		typeof record.enabled === "boolean" ? record.enabled : fallback.enabled;
	const rawItems = record.maxItems;
	const maxItems =
		typeof rawItems === "number" && Number.isFinite(rawItems)
			? rawItems <= 0
				? 0
				: clampMaxItems(rawItems)
			: fallback.maxItems;
	return { version: CONFIG_VERSION, enabled, maxItems };
}

/** Read the config, tolerating a missing, empty, or malformed file. */
export function readConfig(path: string = configPath()): TranscriptWindowConfig {
	try {
		if (!existsSync(path)) return defaultConfig();
		const raw = readFileSync(path, "utf8");
		if (!raw.trim()) return defaultConfig();
		return normalizeConfig(JSON.parse(raw));
	} catch {
		return defaultConfig();
	}
}

/** Atomically write the config, creating the agent directory if needed. */
export function writeConfig(
	config: TranscriptWindowConfig,
	path: string = configPath()
): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}
