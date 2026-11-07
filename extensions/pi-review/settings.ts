/**
 * The committed settings file, `.github/pi-review.json`.
 *
 * The workflow stays generic and this file carries the policy (model, triggers,
 * tools, paths, review state). Keeping it in the repo means a settings change is
 * a reviewable diff rather than a YAML edit, and the workflow can be regenerated
 * from it at any time.
 *
 * Parsing is lenient on missing keys (older files keep working) and strict on
 * values that would produce a broken workflow.
 */

import { providerEnvName } from "./detect.ts";

export const SETTINGS_PATH = ".github/pi-review.json";
export const WORKFLOW_PATH = ".github/workflows/pi-review.yml";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const TRIGGER_TYPES = ["opened", "synchronize", "ready_for_review", "reopened"] as const;
export const REVIEW_EVENTS = ["COMMENT", "REQUEST_CHANGES"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type TriggerType = (typeof TRIGGER_TYPES)[number];
export type ReviewEvent = (typeof REVIEW_EVENTS)[number];
export type IdentityMode = "app" | "token";

export interface ReviewSettings {
	version: 1;
	identity: IdentityMode;
	/** pi provider id, e.g. `opencode-go`. */
	provider: string;
	/** Environment variable the provider key is exposed as. */
	providerEnv: string;
	model: string;
	thinking: ThinkingLevel;
	tools: { bash: boolean };
	triggers: { types: TriggerType[]; skipDrafts: boolean; skipBots: boolean };
	review: { event: ReviewEvent; maxInlineComments: number };
	paths: { include: string[]; exclude: string[] };
	pi: { version: string; packageRef: string };
	/** Wall-clock ceiling for the review step. */
	timeoutMinutes: number;
}

export const DEFAULT_PI_VERSION = "1.5.0";
export const DEFAULT_TIMEOUT_MINUTES = 20;
export const DEFAULT_MAX_INLINE_COMMENTS = 25;

export interface SettingsDefaults {
	identity?: IdentityMode;
	provider?: string;
	model?: string;
	thinking?: ThinkingLevel;
	piVersion?: string;
	packageRef?: string;
}

export function defaultSettings(overrides: SettingsDefaults = {}): ReviewSettings {
	const provider = overrides.provider ?? "opencode-go";
	return {
		version: 1,
		identity: overrides.identity ?? "app",
		provider,
		providerEnv: providerEnvName(provider) ?? "",
		model: overrides.model ?? "",
		thinking: overrides.thinking ?? "medium",
		tools: { bash: false },
		triggers: {
			types: [...TRIGGER_TYPES],
			skipDrafts: true,
			skipBots: false,
		},
		review: { event: "COMMENT", maxInlineComments: DEFAULT_MAX_INLINE_COMMENTS },
		paths: { include: [], exclude: [] },
		pi: {
			version: overrides.piVersion ?? DEFAULT_PI_VERSION,
			packageRef: overrides.packageRef ?? "main",
		},
		timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function stringList(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value)) return fallback;
	return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T, label: string): T {
	if (typeof value !== "string") return fallback;
	const match = allowed.find((option) => option === value);
	if (!match) {
		throw new Error(`Invalid ${label} \`${value}\`; expected one of ${allowed.join(", ")}.`);
	}
	return match;
}

/**
 * Validate a parsed `.github/pi-review.json`. Missing keys fall back to the
 * defaults; an unknown value is an error so a typo cannot silently change the
 * review, except `maxInlineComments`, which is clamped.
 */
export function parseSettings(value: unknown, defaults = defaultSettings()): ReviewSettings {
	if (!isRecord(value)) throw new Error("`.github/pi-review.json` must contain a JSON object.");
	const tools = isRecord(value.tools) ? value.tools : {};
	const triggers = isRecord(value.triggers) ? value.triggers : {};
	const review = isRecord(value.review) ? value.review : {};
	const paths = isRecord(value.paths) ? value.paths : {};
	const pi = isRecord(value.pi) ? value.pi : {};

	const rawTypes = triggers.types;
	const types = Array.isArray(rawTypes)
		? rawTypes.map((entry) => oneOf(entry, TRIGGER_TYPES, "opened", "trigger type"))
		: defaults.triggers.types;
	if (types.length === 0) throw new Error("`triggers.types` cannot be empty.");

	const provider = stringValue(value.provider, defaults.provider);
	const providerEnv = stringValue(value.providerEnv, providerEnvName(provider) ?? defaults.providerEnv);

	const maxInline = Number(review.maxInlineComments ?? defaults.review.maxInlineComments);
	const timeout = Number(value.timeoutMinutes ?? defaults.timeoutMinutes);

	return {
		version: 1,
		identity: oneOf(value.identity, ["app", "token"] as const, defaults.identity, "identity"),
		provider,
		providerEnv,
		model: stringValue(value.model, defaults.model),
		thinking: oneOf(value.thinking, THINKING_LEVELS, defaults.thinking, "thinking level"),
		tools: { bash: booleanValue(tools.bash, defaults.tools.bash) },
		triggers: {
			types,
			skipDrafts: booleanValue(triggers.skipDrafts, defaults.triggers.skipDrafts),
			skipBots: booleanValue(triggers.skipBots, defaults.triggers.skipBots),
		},
		review: {
			event: oneOf(review.event, REVIEW_EVENTS, defaults.review.event, "review event"),
			maxInlineComments:
				Number.isFinite(maxInline)
					? Math.max(1, Math.min(100, Math.trunc(maxInline)))
					: defaults.review.maxInlineComments,
		},
		paths: {
			include: stringList(paths.include, defaults.paths.include),
			exclude: stringList(paths.exclude, defaults.paths.exclude),
		},
		pi: {
			version: stringValue(pi.version, defaults.pi.version),
			packageRef: stringValue(pi.packageRef, defaults.pi.packageRef),
		},
		timeoutMinutes:
			Number.isFinite(timeout) && timeout >= 5 && timeout <= 120
				? Math.trunc(timeout)
				: defaults.timeoutMinutes,
	};
}

export function renderSettings(settings: ReviewSettings): string {
	return `${JSON.stringify(settings, null, 2)}\n`;
}
