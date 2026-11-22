/**
 * Load `settings.attention`.
 *
 * The shape follows the issue: an ordered model cascade, one timeout, and the
 * two thresholds that turn probabilities into a state. An empty `models` list
 * means rules only — no request is ever made.
 */

import type { AttentionConfig } from "./types.ts";

export const DEFAULT_MODELS = [
	"openrouter/typesafe/jev-1.14",
	"openrouter/microsoft/microsoft-decision-1.1",
];

export const DEFAULT_CONFIG: AttentionConfig = {
	enabled: true,
	models: [...DEFAULT_MODELS],
	timeoutSeconds: 2.5,
	needsYouAt: 0.5,
	nothingToDoAt: 0.85,
	log: true,
};

export interface LoadedAttention {
	config: AttentionConfig;
	warnings: string[];
}

export function readAttentionConfig(settings: unknown): unknown {
	if (!settings || typeof settings !== "object") return undefined;
	return (settings as Record<string, unknown>).attention;
}

const probability = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
		? value
		: undefined;

export function normalizeAttentionConfig(
	raw: unknown,
	source = "settings.json",
): LoadedAttention {
	const warnings: string[] = [];
	const config: AttentionConfig = { ...DEFAULT_CONFIG, models: [...DEFAULT_CONFIG.models] };

	if (raw === undefined || raw === null) return { config, warnings };
	if (typeof raw !== "object" || Array.isArray(raw)) {
		warnings.push(`${source}: "attention" must be an object`);
		return { config, warnings };
	}

	const value = raw as Record<string, unknown>;
	if (typeof value.enabled === "boolean") config.enabled = value.enabled;

	if (Array.isArray(value.models)) {
		const models = value.models
			.filter((model): model is string => typeof model === "string")
			.map((model) => model.trim())
			.filter(Boolean);
		if (models.length !== value.models.length) {
			warnings.push(`${source}: attention.models entries must be strings`);
		}
		config.models = models;
	} else if (value.models !== undefined) {
		warnings.push(`${source}: attention.models must be an array of model ids`);
	}

	if (typeof value.timeoutSeconds === "number" && value.timeoutSeconds > 0) {
		config.timeoutSeconds = value.timeoutSeconds;
	} else if (value.timeoutSeconds !== undefined) {
		warnings.push(`${source}: attention.timeoutSeconds must be a positive number`);
	}

	const needsYouAt = probability(value.needsYouAt);
	if (needsYouAt !== undefined) config.needsYouAt = needsYouAt;
	else if (value.needsYouAt !== undefined) {
		warnings.push(`${source}: attention.needsYouAt must be between 0 and 1`);
	}

	const nothingToDoAt = probability(value.nothingToDoAt);
	if (nothingToDoAt !== undefined) config.nothingToDoAt = nothingToDoAt;
	else if (value.nothingToDoAt !== undefined) {
		warnings.push(`${source}: attention.nothingToDoAt must be between 0 and 1`);
	}

	if (typeof value.log === "boolean") config.log = value.log;
	else if (value.log !== undefined) {
		warnings.push(`${source}: attention.log must be a boolean`);
	}

	return { config, warnings };
}

export function describeAttention(config: AttentionConfig): string[] {
	return [
		`Attention: ${config.enabled ? "on" : "off"}`,
		`Models: ${config.models.length > 0 ? config.models.join(" → ") : "(rules only)"}`,
		`Timeout: ${config.timeoutSeconds}s · needsYouAt ${config.needsYouAt} · nothingToDoAt ${config.nothingToDoAt}`,
		`Verdict log: ${config.log ? "on" : "off"}`,
	];
}
