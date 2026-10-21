import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_EVENTS,
	describeSounds,
	expandHome,
	normalizeSoundsConfig,
	readSoundsConfig,
	resolveSoundFile,
	soundForEvent,
} from "./config.ts";

describe("readSoundsConfig", () => {
	it("reads the sounds key", () => {
		expect(readSoundsConfig({ sounds: { enabled: false } })).toEqual({ enabled: false });
		expect(readSoundsConfig({})).toBeUndefined();
	});
});

describe("normalizeSoundsConfig", () => {
	it("returns defaults", () => {
		const { config, warnings } = normalizeSoundsConfig(undefined);
		expect(warnings).toEqual([]);
		expect(config.enabled).toBe(true);
		expect(config.events.PreToolUse).toBe("tool_start.wav");
		expect(config.debounceMs).toBe(150);
	});

	it("merges event overrides and disables with null", () => {
		const { config } = normalizeSoundsConfig({
			events: { PreToolUse: "ping.wav", PostToolUse: null },
		});
		expect(config.events.PreToolUse).toBe("ping.wav");
		expect(config.events.PostToolUse).toBeNull();
		expect(config.events.SessionStart).toBe(DEFAULT_EVENTS.SessionStart);
	});

	it("clamps volume and validates types", () => {
		const { config, warnings } = normalizeSoundsConfig({
			volume: 5,
			debounceMs: 10,
			events: { SessionStart: 42 },
		});
		expect(config.volume).toBe(1);
		expect(config.debounceMs).toBe(10);
		expect(warnings[0]).toContain("must be a filename or null");
	});
});

describe("file resolution", () => {
	it("expands home", () => {
		expect(expandHome("~/x")).toBe(join(homedir(), "x"));
	});

	it("joins bare names and passes paths through", () => {
		expect(resolveSoundFile("a.wav", "/sounds")).toBe("/sounds/a.wav");
		expect(resolveSoundFile("/abs/a.wav", "/sounds")).toBe("/abs/a.wav");
		expect(resolveSoundFile("sub/a.wav", "/sounds")).toBe("sub/a.wav");
	});

	it("returns undefined for a disabled event", () => {
		const { config } = normalizeSoundsConfig({ events: { Stop: null } });
		expect(soundForEvent(config, "Stop")).toBeUndefined();
		expect(soundForEvent(config, "SessionStart")).toContain("session_start.wav");
	});
});

describe("describeSounds", () => {
	it("lists the mapping", () => {
		const { config } = normalizeSoundsConfig(undefined);
		const lines = describeSounds(config);
		expect(lines[0]).toContain("on");
		expect(lines.join("\n")).toContain("PreToolUse: tool_start.wav");
	});
});
