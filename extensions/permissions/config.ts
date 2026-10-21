/**
 * Load `settings.permissions`.
 *
 * Shape follows Claude where it can: `allow` / `ask` / `deny` are rule lists,
 * and `defaultMode` is accepted as an alias for `mode`. Extra keys
 * (`reviewer`, `reviewTools`, `log`) configure the classifier.
 */

import { parseMode } from "./modes.ts";
import { defaultRules } from "./rules.ts";
import type {
	Decision,
	PermissionsConfig,
	ReviewerConfig,
	ReviewerKind,
	RuleEntry,
} from "./types.ts";

export interface LoadedConfig {
	config: PermissionsConfig;
	warnings: string[];
}

const DEFAULT_REVIEWER: ReviewerConfig = {
	provider: "jev",
	model: "openrouter/~typesafe/jev-latest",
	fallbackToLlm: true,
	approveAt: 0.9,
	dangerAt: 0.9,
	timeoutSeconds: 20,
	cache: true,
};

export const DEFAULT_CONFIG: PermissionsConfig = {
	mode: "default",
	defaultDecision: "ask",
	allow: defaultRules().allow,
	ask: defaultRules().ask,
	deny: defaultRules().deny,
	reviewer: DEFAULT_REVIEWER,
	reviewTools: ["bash", "powershell", "write", "edit"],
	useDefaultRules: true,
	log: { enabled: true, fullState: false },
	persistGrants: true,
};

export function readPermissionsConfig(settings: unknown): unknown {
	if (!settings || typeof settings !== "object") return undefined;
	return (settings as Record<string, unknown>).permissions;
}

export function normalizePermissionsConfig(raw: unknown, source = "settings.json"): LoadedConfig {
	const warnings: string[] = [];
	const config: PermissionsConfig = {
		...DEFAULT_CONFIG,
		allow: [...DEFAULT_CONFIG.allow],
		ask: [...DEFAULT_CONFIG.ask],
		deny: [...DEFAULT_CONFIG.deny],
		reviewer: { ...DEFAULT_REVIEWER },
		reviewTools: [...DEFAULT_CONFIG.reviewTools],
		log: { ...DEFAULT_CONFIG.log },
	};

	if (raw === undefined || raw === null) return { config, warnings };
	if (typeof raw !== "object" || Array.isArray(raw)) {
		warnings.push(`${source}: "permissions" must be an object`);
		return { config, warnings };
	}

	const value = raw as Record<string, unknown>;
	const modeRaw = value.mode ?? value.defaultMode;
	if (modeRaw !== undefined) {
		const mode = typeof modeRaw === "string" ? parseMode(modeRaw) : undefined;
		if (mode) config.mode = mode;
		else warnings.push(`${source}: unknown permission mode "${String(modeRaw)}"`);
	}

	const defaultRaw = value.defaultDecision ?? value.default;
	if (defaultRaw !== undefined) {
		const decision = normalizeDecision(defaultRaw);
		if (decision) config.defaultDecision = decision;
		else warnings.push(`${source}: defaultDecision must be allow, ask, or deny`);
	}

	if (typeof value.useDefaultRules === "boolean") {
		config.useDefaultRules = value.useDefaultRules;
	}
	if (!config.useDefaultRules) {
		config.allow = [];
		config.ask = [];
		config.deny = [];
	}

	const allow = normalizeRules(value.allow, `${source}: permissions.allow`, warnings);
	const ask = normalizeRules(value.ask, `${source}: permissions.ask`, warnings);
	const deny = normalizeRules(value.deny, `${source}: permissions.deny`, warnings);
	config.allow = [...config.allow, ...allow];
	config.ask = [...config.ask, ...ask];
	config.deny = [...config.deny, ...deny];

	if (Array.isArray(value.reviewTools)) {
		const tools = value.reviewTools.filter((tool): tool is string => typeof tool === "string");
		if (tools.length > 0) config.reviewTools = tools;
	}

	if (typeof value.persistGrants === "boolean") {
		config.persistGrants = value.persistGrants;
	}

	if (value.log !== undefined) {
		if (value.log && typeof value.log === "object" && !Array.isArray(value.log)) {
			const log = value.log as Record<string, unknown>;
			if (typeof log.enabled === "boolean") config.log.enabled = log.enabled;
			if (typeof log.fullState === "boolean") config.log.fullState = log.fullState;
		} else {
			warnings.push(`${source}: permissions.log must be an object`);
		}
	}

	if (value.reviewer !== undefined) {
		if (value.reviewer && typeof value.reviewer === "object" && !Array.isArray(value.reviewer)) {
			config.reviewer = normalizeReviewer(
				value.reviewer as Record<string, unknown>,
				`${source}: permissions.reviewer`,
				warnings,
			);
		} else {
			warnings.push(`${source}: permissions.reviewer must be an object`);
		}
	}

	return { config, warnings };
}

function normalizeReviewer(
	raw: Record<string, unknown>,
	where: string,
	warnings: string[],
): ReviewerConfig {
	const reviewer: ReviewerConfig = { ...DEFAULT_REVIEWER };
	if (raw.provider !== undefined) {
		if (raw.provider === "jev" || raw.provider === "llm" || raw.provider === "off") {
			reviewer.provider = raw.provider;
		} else {
			warnings.push(`${where}.provider must be jev, llm, or off`);
		}
	}
	if (typeof raw.model === "string" && raw.model.trim()) reviewer.model = raw.model.trim();
	if (typeof raw.fallbackModel === "string" && raw.fallbackModel.trim()) {
		reviewer.fallbackModel = raw.fallbackModel.trim();
	}
	if (typeof raw.fallbackToLlm === "boolean") reviewer.fallbackToLlm = raw.fallbackToLlm;
	if (typeof raw.cache === "boolean") reviewer.cache = raw.cache;
	reviewer.approveAt = clampProbability(raw.approveAt, reviewer.approveAt);
	reviewer.dangerAt = clampProbability(raw.dangerAt, reviewer.dangerAt);
	if (typeof raw.timeoutSeconds === "number" && raw.timeoutSeconds > 0) {
		reviewer.timeoutSeconds = raw.timeoutSeconds;
	}
	return reviewer;
}

function clampProbability(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(1, Math.max(0.5, value));
}

function normalizeDecision(value: unknown): Decision | undefined {
	if (value === "allow" || value === "ask" || value === "deny") return value;
	return undefined;
}

function normalizeRules(raw: unknown, where: string, warnings: string[]): RuleEntry[] {
	if (raw === undefined) return [];
	if (Array.isArray(raw)) {
		const entries: RuleEntry[] = [];
		for (const value of raw) {
			if (typeof value !== "string" || !value.trim()) {
				warnings.push(`${where} contains a non-string rule`);
				continue;
			}
			entries.push({ rule: value.trim(), source: "global" });
		}
		return entries;
	}
	if (raw && typeof raw === "object") {
		// `{ "Bash(git *)": true }` or `{ "Bash(rm *)": "reason" }`
		return Object.keys(raw as Record<string, unknown>)
			.filter((rule) => rule.trim().length > 0)
			.map((rule) => ({ rule: rule.trim(), source: "global" as const }));
	}
	warnings.push(`${where} must be an array or object of rules`);
	return [];
}

/** `/permissions` output: mode, reviewer, and rule counts. */
export function describeConfig(config: PermissionsConfig): string[] {
	return [
		`Mode: ${config.mode} (default decision: ${config.defaultDecision})`,
		`Reviewer: ${config.reviewer.provider}${config.reviewer.model ? ` · ${config.reviewer.model}` : ""}${config.reviewer.fallbackToLlm ? " · llm fallback" : ""}`,
		`Rules: allow ${config.allow.length}, ask ${config.ask.length}, deny ${config.deny.length}`,
		`Review tools: ${config.reviewTools.join(", ")}`,
		`Log: ${config.log.enabled ? "on" : "off"}${config.log.fullState ? " (full state)" : " (redacted)"}`,
	];
}

/** Kind of reviewer a config resolves to after "off". */
export function reviewerKind(config: PermissionsConfig): ReviewerKind {
	return config.reviewer.provider;
}
