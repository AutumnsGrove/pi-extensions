/**
 * Runtime configuration for pi-memory.
 *
 * Precedence: environment > `~/.pi/agent/memory.json` > defaults. The file is
 * optional; a corrupt one must never stop the extension from loading, so every
 * field is sanitised and anything unusable falls back to its default.
 *
 * Everything is local and cheap by default: the index is small, recall is
 * deterministic, extraction is one model call every three settled runs, and
 * consolidation only runs when asked (or when both auto gates pass).
 */

import { existsSync, readFileSync } from "node:fs";
import { configFile } from "./paths.ts";
import { DEFAULT_LIMITS, type MemoryLimits } from "./types.ts";

type Env = Record<string, string | undefined>;

export type MemoryScope = "cwd" | "git-root";
export type MemoryStoreKind = "pi" | "claude";

export interface MemoryConfig {
	enabled: boolean;
	scope: MemoryScope;
	/** Which on-disk layout to use. `claude` points at Claude Code's store. */
	store: MemoryStoreKind;
	/** `provider/model` override for extraction and consolidation. */
	model?: string;
	inlineSave: boolean;
	extraction: {
		enabled: boolean;
		/** Settled runs between extraction attempts, per session. */
		every: number;
		/** Minimum model-visible messages in the unprocessed slice. */
		minMessages: number;
		/** Writes accepted from one extraction. */
		maxWrites: number;
	};
	recall: {
		enabled: boolean;
		maxFiles: number;
		maxBytes: number;
	};
	dream: {
		auto: boolean;
		afterHours: number;
		afterSessions: number;
	};
	semantic: boolean;
	index: {
		maxLines: number;
		maxBytes: number;
	};
	limits: MemoryLimits;
}

/** A sanitised patch: sections may carry only the keys a source actually set. */
export type ConfigPatch = Omit<
	Partial<MemoryConfig>,
	"extraction" | "recall" | "dream" | "index"
> & {
	extraction?: Partial<MemoryConfig["extraction"]>;
	recall?: Partial<MemoryConfig["recall"]>;
	dream?: Partial<MemoryConfig["dream"]>;
	index?: Partial<MemoryConfig["index"]>;
};

export const DEFAULT_CONFIG: MemoryConfig = {
	enabled: true,
	scope: "cwd",
	store: "pi",
	inlineSave: true,
	extraction: {
		enabled: true,
		every: 3,
		minMessages: 3,
		maxWrites: 5,
	},
	recall: {
		enabled: true,
		maxFiles: DEFAULT_LIMITS.maxRecallFiles,
		maxBytes: DEFAULT_LIMITS.maxRecallBytes,
	},
	dream: {
		auto: false,
		afterHours: 24,
		afterSessions: 5,
	},
	semantic: true,
	index: {
		maxLines: DEFAULT_LIMITS.maxIndexLines,
		maxBytes: DEFAULT_LIMITS.maxIndexBytes,
	},
	limits: DEFAULT_LIMITS,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

const bool = (value: unknown, fallback: boolean): boolean =>
	typeof value === "boolean" ? value : fallback;

const int = (value: unknown): number | undefined => {
	if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
	if (typeof value !== "string" || value.trim() === "") return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
};

const clamped = (value: unknown, fallback: number, min: number, max: number): number => {
	const parsed = int(value);
	if (parsed === undefined) return fallback;
	return Math.min(max, Math.max(min, parsed));
};

const scope = (value: unknown, fallback: MemoryScope): MemoryScope =>
	value === "cwd" || value === "git-root" ? value : fallback;

const storeKind = (value: unknown, fallback: MemoryStoreKind): MemoryStoreKind =>
	value === "pi" || value === "claude" ? value : fallback;

const model = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

function section(raw: Record<string, unknown>, key: string): Record<string, unknown> {
	const value = raw[key];
	return isRecord(value) ? value : {};
}

/**
 * Merge a parsed config object over the defaults.
 *
 * Unknown keys are ignored, wrong types fall back, and numeric fields are
 * clamped to usable ranges. A memory store with `every: 0` would call a model
 * on every settled run, so that floor is one; `maxWrites: 0` would make
 * extraction useless, so it is one too.
 */
export function sanitizeConfig(value: unknown): ConfigPatch {
	if (!isRecord(value)) return {};
	const extraction = section(value, "extraction");
	const recall = section(value, "recall");
	const dream = section(value, "dream");
	const index = section(value, "index");
	const clean: ConfigPatch = {};
	if (typeof value.enabled === "boolean") clean.enabled = value.enabled;
	if (value.scope !== undefined) clean.scope = scope(value.scope, DEFAULT_CONFIG.scope);
	if (value.store !== undefined) clean.store = storeKind(value.store, DEFAULT_CONFIG.store);
	const modelOverride = model(value.model);
	if (modelOverride) clean.model = modelOverride;
	if (typeof value.inlineSave === "boolean") clean.inlineSave = value.inlineSave;
	if (typeof value.semantic === "boolean") clean.semantic = value.semantic;
	if (Object.keys(extraction).length > 0) {
		clean.extraction = {
			...(extraction.enabled !== undefined
				? { enabled: bool(extraction.enabled, DEFAULT_CONFIG.extraction.enabled) }
				: {}),
			...(extraction.every !== undefined
				? { every: clamped(extraction.every, DEFAULT_CONFIG.extraction.every, 1, 50) }
				: {}),
			...(extraction.minMessages !== undefined
				? {
						minMessages: clamped(
							extraction.minMessages,
							DEFAULT_CONFIG.extraction.minMessages,
							1,
							100
						),
					}
				: {}),
			...(extraction.maxWrites !== undefined
				? { maxWrites: clamped(extraction.maxWrites, DEFAULT_CONFIG.extraction.maxWrites, 1, 20) }
				: {}),
		};
	}
	if (Object.keys(recall).length > 0) {
		clean.recall = {
			...(recall.enabled !== undefined
				? { enabled: bool(recall.enabled, DEFAULT_CONFIG.recall.enabled) }
				: {}),
			...(recall.maxFiles !== undefined
				? { maxFiles: clamped(recall.maxFiles, DEFAULT_CONFIG.recall.maxFiles, 0, 20) }
				: {}),
			...(recall.maxBytes !== undefined
				? { maxBytes: clamped(recall.maxBytes, DEFAULT_CONFIG.recall.maxBytes, 0, 32_768) }
				: {}),
		};
	}
	if (Object.keys(dream).length > 0) {
		clean.dream = {
			...(dream.auto !== undefined ? { auto: bool(dream.auto, DEFAULT_CONFIG.dream.auto) } : {}),
			...(dream.afterHours !== undefined
				? { afterHours: clamped(dream.afterHours, DEFAULT_CONFIG.dream.afterHours, 1, 24 * 30) }
				: {}),
			...(dream.afterSessions !== undefined
				? {
						afterSessions: clamped(
							dream.afterSessions,
							DEFAULT_CONFIG.dream.afterSessions,
							1,
							500
						),
					}
				: {}),
		};
	}
	if (Object.keys(index).length > 0) {
		clean.index = {
			...(index.maxLines !== undefined
				? { maxLines: clamped(index.maxLines, DEFAULT_CONFIG.index.maxLines, 20, 1_000) }
				: {}),
			...(index.maxBytes !== undefined
				? { maxBytes: clamped(index.maxBytes, DEFAULT_CONFIG.index.maxBytes, 1_024, 200_000) }
				: {}),
		};
	}
	return clean;
}

/** Fields accepted from the environment, applied after the file. */
function envOverrides(env: Env): ConfigPatch {
	const clean: ConfigPatch = {};
	if (env.PI_MEMORY_DISABLED === "1" || env.PI_MEMORY_DISABLED === "true") {
		clean.enabled = false;
	}
	if (env.PI_MEMORY_SCOPE) clean.scope = scope(env.PI_MEMORY_SCOPE, DEFAULT_CONFIG.scope);
	if (env.PI_MEMORY_STORE) clean.store = storeKind(env.PI_MEMORY_STORE, DEFAULT_CONFIG.store);
	const modelOverride = model(env.PI_MEMORY_MODEL);
	if (modelOverride) clean.model = modelOverride;
	if (env.PI_MEMORY_AUTO_DREAM !== undefined) {
		clean.dream = {
			auto: env.PI_MEMORY_AUTO_DREAM === "1" || env.PI_MEMORY_AUTO_DREAM === "true",
		};
	}
	const every = int(env.PI_MEMORY_EXTRACT_EVERY);
	if (every !== undefined) {
		clean.extraction = { every: clamped(every, DEFAULT_CONFIG.extraction.every, 1, 50) };
	}
	return clean;
}

/** Read the config file. Never throws; an unreadable file is empty config. */
export function readConfigFile(path: string): ConfigPatch {
	if (!existsSync(path)) return {};
	try {
		return sanitizeConfig(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return {};
	}
}

function merge(base: MemoryConfig, patch: ConfigPatch): MemoryConfig {
	const merged: MemoryConfig = {
		...base,
		...patch,
		extraction: { ...base.extraction, ...patch.extraction },
		recall: { ...base.recall, ...patch.recall },
		dream: { ...base.dream, ...patch.dream },
		index: { ...base.index, ...patch.index },
	};
	merged.limits = {
		...DEFAULT_LIMITS,
		maxIndexLines: merged.index.maxLines,
		maxIndexBytes: merged.index.maxBytes,
		maxRecallFiles: merged.recall.maxFiles,
		maxRecallBytes: merged.recall.maxBytes,
	};
	return merged;
}

/** Effective configuration, with the config file path for `/memory status`. */
export function loadConfig(
	env: Env = process.env,
	path: string = configFile(env)
): { config: MemoryConfig; file: string; error?: string } {
	let fileConfig: ConfigPatch = {};
	let error: string | undefined;
	try {
		fileConfig = readConfigFile(path);
	} catch (cause) {
		error = cause instanceof Error ? cause.message : String(cause);
	}
	const config = merge(merge(DEFAULT_CONFIG, fileConfig), envOverrides(env));
	if (!config.enabled) {
		// One switch turns the whole feature off, including its tools.
		config.inlineSave = false;
		config.extraction.enabled = false;
		config.recall.enabled = false;
	}
	return { config, file: path, error };
}
