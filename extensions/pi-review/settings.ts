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
export const STRICTNESS_LEVELS = ["significant", "balanced", "thorough"] as const;
export const PROVIDER_FAILURE_MODES = ["fail", "warn"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type TriggerType = (typeof TRIGGER_TYPES)[number];
export type ReviewEvent = (typeof REVIEW_EVENTS)[number];
export type ReviewStrictness = (typeof STRICTNESS_LEVELS)[number];
export type ProviderFailureMode = (typeof PROVIDER_FAILURE_MODES)[number];
export type IdentityMode = "app" | "token";

/**
 * pi's own retry policy, tuned for an unattended CI review.
 *
 * The defaults are deliberately patient: a 429 or an overload spike is the
 * most likely failure a reviewer sees, and a few minutes of backoff turns it
 * into a normal review instead of a red check (#27). Provider-level retries
 * honour `Retry-After`; agent-level retries cover a failed turn.
 */
export interface RetrySettings {
	/** Agent-level attempts after the first failed turn. */
	maxRetries: number;
	/** First exponential-backoff delay, in milliseconds. */
	baseDelayMs: number;
	/** Cap on each agent-level delay, in milliseconds. */
	maxDelayMs: number;
	/** Provider-level attempts, which honour `Retry-After`. */
	providerMaxRetries: number;
}

export const DEFAULT_RETRY: RetrySettings = {
	maxRetries: 6,
	baseDelayMs: 5_000,
	maxDelayMs: 60_000,
	providerMaxRetries: 2,
};

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
	/**
	 * Pre-install dependencies in the workflow so the reviewer can run tests.
	 * `installCommand` overrides the lockfile detection entirely.
	 */
	verify: { installDependencies: boolean; installCommand: string };
	triggers: {
		types: TriggerType[];
		skipDrafts: boolean;
		skipBots: boolean;
		/** `@pi` comments from owners/members/collaborators trigger a review. */
		mention: boolean;
	};
	review: {
		event: ReviewEvent;
		maxInlineComments: number;
		/** How much to report; `significant` is the quiet default. */
		strictness: ReviewStrictness;
		/** Let a follow-up resolve its own threads when it verifies they are fixed. */
		resolveStaleThreads: boolean;
		/** pi's retry budget for provider and agent failures. */
		retry: RetrySettings;
		/** A provider outage after retries: a red check, or a green warning. */
		onProviderFailure: ProviderFailureMode;
	};
	paths: { include: string[]; exclude: string[] };
	/**
	 * Pinned pi version. Left unset by default so the reusable workflow's
	 * `pi-version` input decides; a repository that needs a specific release can
	 * still pin one here, and that value wins.
	 */
	pi?: { version: string };
	/** Wall-clock ceiling for the review step. */
	timeoutMinutes: number;
}

export const DEFAULT_TIMEOUT_MINUTES = 20;
export const DEFAULT_MAX_INLINE_COMMENTS = 25;

export interface SettingsDefaults {
	identity?: IdentityMode;
	provider?: string;
	model?: string;
	thinking?: ThinkingLevel;
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
		verify: { installDependencies: false, installCommand: "" },
		triggers: {
			types: [...TRIGGER_TYPES],
			skipDrafts: true,
			skipBots: false,
			mention: true,
		},
		review: {
			event: "COMMENT",
			maxInlineComments: DEFAULT_MAX_INLINE_COMMENTS,
			strictness: "significant",
			resolveStaleThreads: false,
			retry: { ...DEFAULT_RETRY },
			// Safer default: a check that silently passes without a review can
			// let a PR merge unreviewed. `warn` is available for flaky providers.
			onProviderFailure: "fail",
		},
		paths: { include: [], exclude: [] },
		timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

/** A trimmed string, or undefined when absent, so the key can be left out. */
function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function stringList(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value)) return fallback;
	return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function clampedNumber(value: unknown, fallback: number, min: number, max: number): number {
	const number = Number(value);
	if (!Number.isFinite(number)) return fallback;
	return Math.max(min, Math.min(max, Math.trunc(number)));
}

function retrySettings(value: Record<string, unknown>, fallback: RetrySettings): RetrySettings {
	const baseDelayMs = clampedNumber(value.baseDelayMs, fallback.baseDelayMs, 500, 60_000);
	return {
		maxRetries: clampedNumber(value.maxRetries, fallback.maxRetries, 0, 10),
		baseDelayMs,
		maxDelayMs: Math.max(baseDelayMs, clampedNumber(value.maxDelayMs, fallback.maxDelayMs, 1_000, 300_000)),
		providerMaxRetries: clampedNumber(value.providerMaxRetries, fallback.providerMaxRetries, 0, 5),
	};
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
	const verify = isRecord(value.verify) ? value.verify : {};
	const triggers = isRecord(value.triggers) ? value.triggers : {};
	const review = isRecord(value.review) ? value.review : {};
	const retry = isRecord(review.retry) ? review.retry : {};
	const paths = isRecord(value.paths) ? value.paths : {};
	const pi = isRecord(value.pi) ? value.pi : {};
	const piVersion = optionalString(pi.version);

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
		verify: {
			installDependencies: booleanValue(
				verify.installDependencies,
				defaults.verify.installDependencies
			),
			installCommand: stringValue(verify.installCommand, defaults.verify.installCommand),
		},
		triggers: {
			types,
			skipDrafts: booleanValue(triggers.skipDrafts, defaults.triggers.skipDrafts),
			skipBots: booleanValue(triggers.skipBots, defaults.triggers.skipBots),
			mention: booleanValue(triggers.mention, defaults.triggers.mention),
		},
		review: {
			event: oneOf(review.event, REVIEW_EVENTS, defaults.review.event, "review event"),
			strictness: oneOf(
				review.strictness,
				STRICTNESS_LEVELS,
				defaults.review.strictness,
				"review strictness"
			),
			resolveStaleThreads: booleanValue(
				review.resolveStaleThreads,
				defaults.review.resolveStaleThreads
			),
			retry: retrySettings(retry, defaults.review.retry),
			onProviderFailure: oneOf(
				review.onProviderFailure,
				PROVIDER_FAILURE_MODES,
				defaults.review.onProviderFailure,
				"provider failure mode"
			),
			maxInlineComments:
				Number.isFinite(maxInline)
					? Math.max(1, Math.min(100, Math.trunc(maxInline)))
					: defaults.review.maxInlineComments,
		},
		paths: {
			include: stringList(paths.include, defaults.paths.include),
			exclude: stringList(paths.exclude, defaults.paths.exclude),
		},
		// `packageRef` from an older settings file is ignored: the job runs from
		// the pi-extensions repository at main, so there is nothing to pin (#34).
		// `pi.version` is optional: absent means "whatever the workflow default
		// is", which lets one bump in the reusable workflow reach every caller.
		...(piVersion ? { pi: { version: piVersion } } : {}),
		timeoutMinutes:
			Number.isFinite(timeout) && timeout >= 5 && timeout <= 120
				? Math.trunc(timeout)
				: defaults.timeoutMinutes,
	};
}

export function renderSettings(settings: ReviewSettings): string {
	return `${JSON.stringify(settings, null, 2)}\n`;
}
