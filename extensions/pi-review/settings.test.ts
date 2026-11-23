import { describe, expect, it } from "vitest";
import {
	DEFAULT_MAX_INLINE_COMMENTS,
	DEFAULT_RETRY,
	DEFAULT_TIMEOUT_MINUTES,
	defaultSettings,
	parseSettings,
	renderSettings,
} from "./settings.ts";

describe("defaultSettings", () => {
	it("is a working opencode-go configuration", () => {
		const settings = defaultSettings({
			provider: "opencode-go",
			model: "deepseek-v4.1-flash",
		});
		expect(settings).toMatchObject({
			version: 1,
			identity: "app",
			provider: "opencode-go",
			providerEnv: "OPENCODE_API_KEY",
			model: "deepseek-v4.1-flash",
			thinking: "medium",
			tools: { bash: false },
			review: {
				event: "COMMENT",
				maxInlineComments: DEFAULT_MAX_INLINE_COMMENTS,
				retry: DEFAULT_RETRY,
				onProviderFailure: "fail",
			},
			timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
		});
		// No pin by default: the reusable workflow's `pi-version` decides.
		expect(settings.pi).toBeUndefined();
		expect(settings.triggers.types).toEqual(["opened", "synchronize", "ready_for_review", "reopened"]);
		expect(settings.triggers.skipDrafts).toBe(true);
		expect(settings.paths).toEqual({ include: [], exclude: [] });
	});

	it("derives the provider env for known providers", () => {
		expect(defaultSettings({ provider: "openrouter" }).providerEnv).toBe("OPENROUTER_API_KEY");
		expect(defaultSettings({ provider: "custom-thing" }).providerEnv).toBe("");
	});
});

describe("parseSettings", () => {
	it("merges a partial file over the defaults", () => {
		const settings = parseSettings({ model: "m", tools: { bash: true } });
		expect(settings.model).toBe("m");
		expect(settings.tools.bash).toBe(true);
		expect(settings.identity).toBe("app");
		expect(settings.triggers.skipDrafts).toBe(true);
	});

	it("keeps a pinned pi version and omits an absent one", () => {
		expect(parseSettings({ pi: { version: "1.5.2" } }).pi).toEqual({ version: "1.5.2" });
		expect(parseSettings({}).pi).toBeUndefined();
		expect(parseSettings({ pi: { version: "  " } }).pi).toBeUndefined();
	});

	it("does not write an empty pi block when rendering", () => {
		const rendered = renderSettings(parseSettings({}));
		expect(rendered).not.toContain('"pi"');
		expect(renderSettings(parseSettings({ pi: { version: "1.5.2" } }))).toContain(
			'"version": "1.5.2"'
		);
	});

	it("parses strictness and rejects unknown levels", () => {
		expect(parseSettings({ review: { strictness: "thorough" } }).review.strictness).toBe("thorough");
		expect(parseSettings({ review: { strictness: "balanced" } }).review.strictness).toBe("balanced");
		expect(() => parseSettings({ review: { strictness: "picky" } })).toThrow("Invalid review strictness");
	});

	it("parses the mention trigger", () => {
		expect(parseSettings({ triggers: { mention: false } }).triggers.mention).toBe(false);
		expect(parseSettings({}).triggers.mention).toBe(true);
	});

	it("parses skipBots as a boolean or a list of logins", () => {
		expect(parseSettings({}).triggers.skipBots).toBe(false);
		expect(parseSettings({ triggers: { skipBots: true } }).triggers.skipBots).toBe(true);
		expect(
			parseSettings({ triggers: { skipBots: ["dependabot[bot]", "renovate[bot]"] } }).triggers.skipBots
		).toEqual(["dependabot[bot]", "renovate[bot]"]);
	});

	it("trims, deduplicates and keeps the order of the skip list", () => {
		expect(
			parseSettings({ triggers: { skipBots: [" dependabot[bot] ", "dependabot[bot]", "my-bot"] } })
				.triggers.skipBots
		).toEqual(["dependabot[bot]", "my-bot"]);
	});

	it("refuses a skip value that would not survive the workflow expression", () => {
		// `if:` is a plain YAML scalar built from this list, so a quote, a bracket
		// or a space here would change the condition rather than the policy.
		for (const value of ["dependabot[bot]", ["a b"], ["a'; rm -rf /"], ['"x"'], ["x'"], [1]]) {
			expect(() => parseSettings({ triggers: { skipBots: value } })).toThrow("triggers.skipBots");
		}
		expect(() => parseSettings({ triggers: { skipBots: { skip: ["x"] } } })).toThrow(
			"must be `true`, `false`, or a list of bot logins"
		);
	});

	it("parses resolveStaleThreads", () => {
		expect(parseSettings({ review: { resolveStaleThreads: true } }).review.resolveStaleThreads).toBe(true);
		expect(parseSettings({}).review.resolveStaleThreads).toBe(false);
	});

	it("parses the retry budget and clamps it", () => {
		const parsed = parseSettings({
			review: {
				retry: { maxRetries: 4, baseDelayMs: 3_000, maxDelayMs: 2_000, providerMaxRetries: 9 },
			},
		});
		expect(parsed.review.retry).toEqual({
			maxRetries: 4,
			baseDelayMs: 3_000,
			maxDelayMs: 3_000,
			providerMaxRetries: 5,
		});
		expect(parseSettings({ review: { retry: { maxRetries: 99 } } }).review.retry.maxRetries).toBe(10);
		expect(parseSettings({ review: { retry: { maxRetries: -1 } } }).review.retry.maxRetries).toBe(0);
	});

	it("parses the provider failure mode and rejects an unknown one", () => {
		expect(parseSettings({ review: { onProviderFailure: "warn" } }).review.onProviderFailure).toBe("warn");
		expect(parseSettings({}).review.onProviderFailure).toBe("fail");
		expect(() => parseSettings({ review: { onProviderFailure: "skip" } })).toThrow(
			"Invalid provider failure mode"
		);
	});

	it("parses the verify setting and its command override", () => {
		expect(parseSettings({ verify: { installDependencies: true } }).verify.installDependencies).toBe(true);
		expect(parseSettings({ verify: { installDependencies: "yes" } }).verify.installDependencies).toBe(false);
		expect(parseSettings({ verify: { installCommand: "make deps" } }).verify.installCommand).toBe(
			"make deps"
		);
		expect(parseSettings({}).verify.installCommand).toBe("");
	});

	it("keeps a committed file's provider env or derives it", () => {
		expect(parseSettings({ provider: "openrouter" }).providerEnv).toBe("OPENROUTER_API_KEY");
		expect(parseSettings({ provider: "x", providerEnv: "X_KEY" }).providerEnv).toBe("X_KEY");
	});

	it("rejects a non-object file", () => {
		expect(() => parseSettings([])).toThrow("must contain a JSON object");
		expect(() => parseSettings("x")).toThrow("must contain a JSON object");
	});

	it("rejects unknown enum values instead of silently changing the review", () => {
		expect(() => parseSettings({ thinking: "extreme" })).toThrow("Invalid thinking level");
		expect(() => parseSettings({ review: { event: "APPROVE" } })).toThrow("Invalid review event");
		expect(() => parseSettings({ identity: "nobody" })).toThrow("Invalid identity");
		expect(() => parseSettings({ triggers: { types: ["open"] } })).toThrow("Invalid trigger type");
	});

	it("rejects an empty trigger list", () => {
		expect(() => parseSettings({ triggers: { types: [] } })).toThrow("cannot be empty");
	});

	it("clamps inline comments and timeouts", () => {
		expect(parseSettings({ review: { maxInlineComments: 1000 } }).review.maxInlineComments).toBe(100);
		expect(parseSettings({ review: { maxInlineComments: 0 } }).review.maxInlineComments).toBe(1);
		expect(parseSettings({ timeoutMinutes: 1 }).timeoutMinutes).toBe(DEFAULT_TIMEOUT_MINUTES);
		expect(parseSettings({ timeoutMinutes: 45 }).timeoutMinutes).toBe(45);
	});

	it("ignores non-string path entries", () => {
		expect(parseSettings({ paths: { include: ["a", 3, ""] } }).paths.include).toEqual(["a"]);
	});

	it("round-trips through renderSettings", () => {
		const settings = defaultSettings({ provider: "openrouter", model: "m" });
		expect(parseSettings(JSON.parse(renderSettings(settings)))).toEqual(settings);
		expect(renderSettings(settings).endsWith("\n")).toBe(true);
	});
});
