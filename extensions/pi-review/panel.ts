/**
 * Interactive settings menu for `/pi-review settings`.
 *
 * A sequence of select/input dialogs is the honest v1 of the panel: the common
 * fields in `.github/pi-review.json` are reachable without hand-editing JSON,
 * and "Edit raw JSON" still opens the editor for exact retry values, provider
 * and paths. The result is a complete settings object; the command commits it
 * and regenerates the workflow.
 */

import {
	DEFAULT_RETRY,
	REVIEW_EVENTS,
	STRICTNESS_LEVELS,
	THINKING_LEVELS,
	type RetrySettings,
	type ReviewSettings,
	type ReviewStrictness,
	type ThinkingLevel,
} from "./settings.ts";

export interface PanelUI {
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

/** Updated settings, `"json"` to open the raw editor, or undefined to cancel. */
export type PanelResult = ReviewSettings | "json" | undefined;

const SAVE = "Save and continue";
const CANCEL = "Cancel";
const RAW = "Edit raw JSON…";
const TOOLS_READ_ONLY = "Read-only (read, grep, find, ls)";
const TOOLS_BASH = "Read and run tests (+ bash)";

const STRICTNESS_LABELS: Record<ReviewStrictness, string> = {
	significant: "significant — merge-blocking findings only",
	balanced: "balanced — plus design and test gaps",
	thorough: "thorough — plus minor suggestions",
};

const RETRY_PRESETS: { label: string; retry: RetrySettings }[] = [
	{ label: "Default — 6 agent retries, 5s base, 2 provider retries", retry: { ...DEFAULT_RETRY } },
	{
		label: "Patient — 10 agent retries, 10s base, 3 provider retries",
		retry: { maxRetries: 10, baseDelayMs: 10_000, maxDelayMs: 60_000, providerMaxRetries: 3 },
	},
	{
		label: "Off — no retries",
		retry: { maxRetries: 0, baseDelayMs: 5_000, maxDelayMs: 60_000, providerMaxRetries: 0 },
	},
];

function labelFor(choice: string): string {
	return choice.split(" — ")[0] ?? choice;
}

export async function editSettings(settings: ReviewSettings, ui: PanelUI): Promise<PanelResult> {
	const current: ReviewSettings = structuredClone(settings);

	while (true) {
		const choice = await ui.select("pi-review settings", [
			`Model: ${current.model || "(not set)"}`,
			`Thinking: ${current.thinking}`,
			`Tools: ${current.tools.bash ? "read + bash" : "read-only"}`,
			`Strictness: ${STRICTNESS_LABELS[current.review.strictness]}`,
			`Verdict: ${current.review.event}`,
			`Install dependencies: ${current.verify.installDependencies ? "yes" : "no"}`,
			`Resolve stale threads: ${current.review.resolveStaleThreads ? "yes" : "no"}`,
			`Retries: ${current.review.retry.maxRetries} agent · ${current.review.retry.providerMaxRetries} provider`,
			`Provider failure: ${current.review.onProviderFailure === "warn" ? "warn (green check)" : "fail (red check)"}`,
			`Mention trigger: ${current.triggers.mention ? "on" : "off"}`,
			SAVE,
			RAW,
			CANCEL,
		]);
		if (choice === undefined || choice === CANCEL) return undefined;
		if (choice === SAVE) return current;
		if (choice === RAW) return "json";

		if (choice.startsWith("Model:")) {
			const value = await ui.input("Model id (provider/model)", current.model);
			if (value?.trim()) current.model = value.trim();
			continue;
		}

		if (choice.startsWith("Thinking:")) {
			const value = await ui.select("Thinking level", [...THINKING_LEVELS]);
			if (value) current.thinking = value as ThinkingLevel;
			continue;
		}

		if (choice.startsWith("Tools:")) {
			const value = await ui.select("Reviewer tools", [TOOLS_READ_ONLY, TOOLS_BASH]);
			if (value) {
				current.tools.bash = value === TOOLS_BASH;
				if (!current.tools.bash) current.verify.installDependencies = false;
			}
			continue;
		}

		if (choice.startsWith("Strictness:")) {
			const value = await ui.select(
				"Review strictness",
				STRICTNESS_LEVELS.map((level) => STRICTNESS_LABELS[level])
			);
			const level = value ? (labelFor(value) as ReviewStrictness) : undefined;
			if (level && STRICTNESS_LEVELS.includes(level)) current.review.strictness = level;
			continue;
		}

		if (choice.startsWith("Verdict:")) {
			const value = await ui.select("Review verdict", [
				"COMMENT — comment only",
				"REQUEST_CHANGES — request changes",
			]);
			const event = value ? labelFor(value) : undefined;
			if (event && REVIEW_EVENTS.includes(event as never)) {
				current.review.event = event as ReviewSettings["review"]["event"];
			}
			continue;
		}

		if (choice.startsWith("Install dependencies:")) {
			if (!current.tools.bash) {
				ui.notify("Enable bash under Tools first; dependency install is only useful with tests.", "warning");
				continue;
			}
			const value = await ui.select("Install dependencies before the review?", ["Yes", "No"]);
			if (value) current.verify.installDependencies = value === "Yes";
			continue;
		}

		if (choice.startsWith("Resolve stale threads:")) {
			const value = await ui.select(
				"Resolve review threads when a fix is verified?",
				["Yes", "No"]
			);
			if (value) current.review.resolveStaleThreads = value === "Yes";
			continue;
		}

		if (choice.startsWith("Retries:")) {
			const value = await ui.select(
				"Review retry budget",
				RETRY_PRESETS.map((preset) => preset.label)
			);
			const preset = RETRY_PRESETS.find((candidate) => candidate.label === value);
			if (preset) current.review.retry = { ...preset.retry };
			continue;
		}

		if (choice.startsWith("Provider failure:")) {
			const value = await ui.select(
				"When the provider is still unavailable after retries",
				["fail — red check and a comment", "warn — green check and a comment"]
			);
			if (value) current.review.onProviderFailure = value.startsWith("warn") ? "warn" : "fail";
			continue;
		}

		if (choice.startsWith("Mention trigger:")) {
			const value = await ui.select("Review on an @pi comment from a maintainer?", [
				"On",
				"Off",
			]);
			if (value) current.triggers.mention = value === "On";
			continue;
		}
	}
}
