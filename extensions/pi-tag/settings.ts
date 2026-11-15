/**
 * The settings file: `.github/pi-tag.json` in the repository being tagged.
 *
 * Same shape as `.github/pi-review.json`, and the workflow is generated from it,
 * so the policy is a file you edit rather than YAML you are afraid of. The
 * defaults are the ones the plan argues for, and the validator refuses the
 * combinations that would quietly weaken the guarantees — `tools.bash`, a
 * removal mode other than `never` or `on-request`, a trigger nobody can type.
 */

import { readFileSync } from "node:fs";

export type Identity = "app" | "token";
export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type RemovalMode = "never" | "on-request";

/** Where the settings live in the target repository. */
export const SETTINGS_PATH = ".github/pi-tag.json";

/** Where the workflow is written in the target repository. */
export const WORKFLOW_PATH = ".github/workflows/pi-tag.yml";

export interface Settings {
	version: 1;
	identity: Identity;
	provider: string;
	providerEnv: string;
	model: string;
	thinking: Thinking;
	/** Read-only, always. Present so a settings file that turns bash on is refused. */
	tools: { bash: false };
	triggers: { types: string[]; mention: string; fix: string; who: string[] };
	labels: { manifest: string; remove: RemovalMode };
	comment: { always: boolean; considered: boolean };
	pi: { version: string; packageRef?: string };
	timeoutMinutes: number;
}

export const DEFAULT_SETTINGS: Settings = {
	version: 1,
	identity: "app",
	provider: "opencode-go",
	providerEnv: "PI_TAG_API_KEY",
	model: "glm-5.3-flash",
	thinking: "medium",
	tools: { bash: false },
	triggers: {
		types: ["opened"],
		mention: "@pi",
		fix: "fix",
		who: ["OWNER", "MEMBER", "COLLABORATOR"],
	},
	labels: { manifest: ".github/labels.yml", remove: "on-request" },
	comment: { always: true, considered: true },
	pi: { version: "1.5.2" },
	timeoutMinutes: 5,
};

const THINKING: Thinking[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR", "CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "NONE"];

export class SettingsError extends Error {
	readonly problems: string[];

	constructor(problems: string[]) {
		super(`${SETTINGS_PATH} has ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n${problems.map((p) => `  • ${p}`).join("\n")}`);
		this.name = "SettingsError";
		this.problems = problems;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, fallback: string, at: string, problems: string[]): string {
	if (value === undefined) return fallback;
	if (typeof value !== "string" || !value.trim()) {
		problems.push(`${at}: expected a non-empty string`);
		return fallback;
	}
	return value.trim();
}

function booleanField(value: unknown, fallback: boolean, at: string, problems: string[]): boolean {
	if (value === undefined) return fallback;
	if (typeof value !== "boolean") {
		problems.push(`${at}: expected true or false`);
		return fallback;
	}
	return value;
}

/** Everything the generator and the runner rely on, checked in one place. */
export function parseSettings(value: unknown): Settings {
	if (!isRecord(value)) throw new SettingsError(["the file is not a JSON object"]);
	const problems: string[] = [];

	if (value.version !== 1) problems.push(`version: expected 1, got ${String(value.version)}`);

	const identity = value.identity ?? DEFAULT_SETTINGS.identity;
	if (identity !== "app" && identity !== "token") problems.push('identity: expected "app" or "token"');

	const thinking = value.thinking ?? DEFAULT_SETTINGS.thinking;
	if (!THINKING.includes(thinking as Thinking)) problems.push(`thinking: expected one of ${THINKING.join(", ")}`);

	// A tagger has nothing to execute. Turning bash on is refused rather than
	// warned about, because the run holds a token and reads an untrusted issue.
	const bash = isRecord(value.tools) ? value.tools.bash : undefined;
	if (bash === true) {
		problems.push("tools.bash: pi-tag never runs a shell — remove the setting rather than disabling it by hand");
	}

	const triggers = isRecord(value.triggers) ? value.triggers : {};
	const mention = stringField(triggers.mention, DEFAULT_SETTINGS.triggers.mention, "triggers.mention", problems);
	if (!mention.startsWith("@")) problems.push('triggers.mention: expected a mention such as "@pi"');
	const fix = stringField(triggers.fix, DEFAULT_SETTINGS.triggers.fix, "triggers.fix", problems);
	if (/\s/.test(fix)) problems.push("triggers.fix: expected a single word");

	if (triggers.types !== undefined) {
		if (!Array.isArray(triggers.types) || triggers.types.length === 0) {
			problems.push("triggers.types: expected a non-empty list");
		} else if (triggers.types.some((type) => type !== "opened")) {
			problems.push('triggers.types: only "opened" is supported — edited and labeled would run twice for no reason');
		}
	}

	let who = DEFAULT_SETTINGS.triggers.who;
	if (triggers.who !== undefined) {
		if (!Array.isArray(triggers.who) || triggers.who.length === 0) {
			problems.push("triggers.who: expected a non-empty list of author associations");
		} else {
			const bad = triggers.who.filter((entry) => !ASSOCIATIONS.includes(String(entry)));
			if (bad.length > 0) problems.push(`triggers.who: unknown association(s) ${bad.join(", ")}`);
			else who = triggers.who.map(String);
		}
	}

	const labels = isRecord(value.labels) ? value.labels : {};
	const remove = labels.remove ?? DEFAULT_SETTINGS.labels.remove;
	if (remove !== "never" && remove !== "on-request") {
		problems.push('labels.remove: expected "never" or "on-request"');
	}

	const comment = isRecord(value.comment) ? value.comment : {};
	const push = isRecord(value.pi) ? value.pi : {};
	const rawTimeout = value.timeoutMinutes;
	const timeout =
		typeof rawTimeout === "number" && Number.isInteger(rawTimeout) && rawTimeout >= 1 && rawTimeout <= 30
			? rawTimeout
			: DEFAULT_SETTINGS.timeoutMinutes;
	if (rawTimeout !== undefined && timeout !== rawTimeout) {
		problems.push("timeoutMinutes: expected a whole number between 1 and 30");
	}

	if (problems.length > 0) throw new SettingsError(problems);

	return {
		version: 1,
		identity: identity as Identity,
		provider: stringField(value.provider, DEFAULT_SETTINGS.provider, "provider", problems),
		providerEnv: stringField(value.providerEnv, DEFAULT_SETTINGS.providerEnv, "providerEnv", problems),
		model: stringField(value.model, DEFAULT_SETTINGS.model, "model", problems),
		thinking: thinking as Thinking,
		tools: { bash: false },
		triggers: { types: ["opened"], mention, fix, who },
		labels: {
			manifest: stringField(labels.manifest, DEFAULT_SETTINGS.labels.manifest, "labels.manifest", problems),
			remove: remove as RemovalMode,
		},
		comment: {
			always: booleanField(comment.always, DEFAULT_SETTINGS.comment.always, "comment.always", problems),
			considered: booleanField(comment.considered, DEFAULT_SETTINGS.comment.considered, "comment.considered", problems),
		},
		pi: {
			version: stringField(push.version, DEFAULT_SETTINGS.pi.version, "pi.version", problems),
			packageRef: typeof push.packageRef === "string" ? push.packageRef.trim() || undefined : undefined,
		},
		timeoutMinutes: timeout,
	};
}

export function readSettings(file: string): Settings {
	let source: string;
	try {
		source = readFileSync(file, "utf8");
	} catch (error) {
		throw new SettingsError([`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`]);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch (error) {
		throw new SettingsError([`not valid JSON: ${error instanceof Error ? error.message : String(error)}`]);
	}
	return parseSettings(parsed);
}
