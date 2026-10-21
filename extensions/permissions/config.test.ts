import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, normalizePermissionsConfig, readPermissionsConfig } from "./config.ts";

describe("readPermissionsConfig", () => {
	it("reads the permissions key", () => {
		expect(readPermissionsConfig({ permissions: { mode: "auto" } })).toEqual({ mode: "auto" });
		expect(readPermissionsConfig({})).toBeUndefined();
		expect(readPermissionsConfig("x")).toBeUndefined();
	});
});

describe("normalizePermissionsConfig", () => {
	it("returns defaults for missing config", () => {
		const { config, warnings } = normalizePermissionsConfig(undefined);
		expect(warnings).toEqual([]);
		expect(config.mode).toBe("default");
		expect(config.defaultDecision).toBe("ask");
		expect(config.allow.length).toBe(DEFAULT_CONFIG.allow.length);
		expect(config.deny.length).toBe(DEFAULT_CONFIG.deny.length);
	});

	it("accepts Claude's defaultMode alias", () => {
		const { config } = normalizePermissionsConfig({ defaultMode: "acceptEdits" });
		expect(config.mode).toBe("acceptEdits");
	});

	it("normalizes allow arrays and objects", () => {
		const { config } = normalizePermissionsConfig({
			allow: ["Bash(git status)", 42],
			ask: { "Bash(npm publish *)": true },
			deny: ["Bash(rm -rf /)"],
		});
		expect(config.allow.at(-1)?.rule).toBe("Bash(git status)");
		expect(config.ask.at(-1)?.rule).toBe("Bash(npm publish *)");
		expect(config.deny.at(-1)?.rule).toBe("Bash(rm -rf /)");
	});

	it("can disable the built-in lists", () => {
		const { config } = normalizePermissionsConfig({ useDefaultRules: false });
		expect(config.allow).toEqual([]);
		expect(config.ask).toEqual([]);
		expect(config.deny).toEqual([]);
	});

	it("normalizes reviewer settings and clamps thresholds", () => {
		const { config } = normalizePermissionsConfig({
			reviewer: {
				provider: "llm",
				model: "openrouter/anthropic/claude-haiku-4",
				fallbackToLlm: false,
				approveAt: 0.1,
				dangerAt: 2,
				timeoutSeconds: 5,
			},
		});
		expect(config.reviewer.provider).toBe("llm");
		expect(config.reviewer.approveAt).toBe(0.5);
		expect(config.reviewer.dangerAt).toBe(1);
		expect(config.reviewer.timeoutSeconds).toBe(5);
		expect(config.reviewer.fallbackToLlm).toBe(false);
	});

	it("warns on bad values", () => {
		const { warnings } = normalizePermissionsConfig({
			mode: "nope",
			defaultDecision: "maybe",
			reviewer: { provider: "gpt" },
		});
		expect(warnings).toHaveLength(3);
	});
});
