import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SearchMode } from "./cost.ts";

export interface ParallelConfig {
	version: 1;
	/** Warn (but still allow) once the month crosses this many Parallel requests. */
	softLimitQueries: number;
	/** Never issue a Parallel request that would cross this many requests in a month. */
	hardLimitQueries: number;
	/** Never issue a Parallel request that would cross this estimated monthly spend. */
	hardLimitUsd: number;
	/** Default Search API mode. `fast` keeps us in the cheap tier. */
	searchMode: SearchMode;
	/** Default number of search results when the model does not specify. */
	defaultMaxResults: number;
	/** Total characters of fetched page content handed to the summarizer model. */
	maxSummaryChars: number;
	/** Parallel platform origin, overridable for testing/self-hosting. */
	platformOrigin: string;
	/** API base URL, overridable for testing. */
	apiBaseUrl: string;
}

export const DEFAULT_CONFIG: ParallelConfig = {
	version: 1,
	softLimitQueries: 3_000,
	hardLimitQueries: 4_000,
	hardLimitUsd: 4,
	searchMode: "fast",
	defaultMaxResults: 10,
	maxSummaryChars: 120_000,
	platformOrigin: "https://platform.parallel.ai",
	apiBaseUrl: "https://api.parallel.ai",
};

export const parallelDir = (): string => join(getAgentDir(), "parallel");
export const configPath = (): string => join(parallelDir(), "config.json");
export const quotaPath = (): string => join(parallelDir(), "quota.json");

const asPositiveInt = (value: unknown, fallback: number): number => {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return fallback;
	}
	return Math.floor(value);
};

const asPositiveNumber = (value: unknown, fallback: number): number => {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return fallback;
	}
	return value;
};

const asSearchMode = (value: unknown, fallback: SearchMode): SearchMode => {
	if (value === "turbo" || value === "fast" || value === "basic" || value === "advanced") {
		return value;
	}
	return fallback;
};

const asUrl = (value: unknown, fallback: string): string => {
	if (typeof value === "string" && value.trim().length > 0) {
		return value.trim().replace(/\/$/, "");
	}
	return fallback;
};

/** Load config merged over defaults. Missing or corrupt files fall back to defaults. */
export const loadConfig = (path: string = configPath()): ParallelConfig => {
	let parsed: Partial<ParallelConfig>;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<ParallelConfig>;
	} catch {
		return { ...DEFAULT_CONFIG };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ...DEFAULT_CONFIG };
	}

	const hardLimitQueries = asPositiveInt(parsed.hardLimitQueries, DEFAULT_CONFIG.hardLimitQueries);
	const softLimitQueries = Math.min(
		asPositiveInt(parsed.softLimitQueries, DEFAULT_CONFIG.softLimitQueries),
		hardLimitQueries
	);

	return {
		version: 1,
		softLimitQueries,
		hardLimitQueries,
		hardLimitUsd: asPositiveNumber(parsed.hardLimitUsd, DEFAULT_CONFIG.hardLimitUsd),
		searchMode: asSearchMode(parsed.searchMode, DEFAULT_CONFIG.searchMode),
		defaultMaxResults: asPositiveInt(parsed.defaultMaxResults, DEFAULT_CONFIG.defaultMaxResults),
		maxSummaryChars: asPositiveInt(parsed.maxSummaryChars, DEFAULT_CONFIG.maxSummaryChars),
		platformOrigin: asUrl(parsed.platformOrigin, DEFAULT_CONFIG.platformOrigin),
		apiBaseUrl: asUrl(parsed.apiBaseUrl, DEFAULT_CONFIG.apiBaseUrl),
	};
};

/** Create the extension's config directory if it does not exist. */
export const ensureParallelDir = (): void => {
	mkdirSync(parallelDir(), { recursive: true, mode: 0o700 });
};
