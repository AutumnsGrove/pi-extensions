import { describe, expect, it, vi } from "vitest";
import {
	buildPlayerCommand,
	createPlayer,
	detectPlayer,
	type SpawnLike,
} from "./player.ts";
import { normalizeSoundsConfig } from "./config.ts";

describe("detectPlayer", () => {
	it("picks the platform default", () => {
		expect(detectPlayer("darwin", () => false)).toBe("afplay");
		expect(detectPlayer("win32", () => false)).toBe("powershell");
		expect(detectPlayer("linux", (command) => command === "paplay")).toBe("paplay");
		expect(detectPlayer("linux", (command) => command === "aplay")).toBe("aplay");
	});
});

describe("buildPlayerCommand", () => {
	it("builds the right arguments per player", () => {
		expect(buildPlayerCommand("afplay", "a.wav", 0.5)).toEqual({
			command: "afplay",
			args: ["-v", "0.50", "a.wav"],
		});
		expect(buildPlayerCommand("paplay", "a.wav", 1).args[0]).toBe("--volume");
		expect(buildPlayerCommand("aplay", "a.wav", 0.5)).toEqual({
			command: "aplay",
			args: ["a.wav"],
		});
		expect(buildPlayerCommand("powershell", "a.wav", 0.5).args[1]).toBe("-c");
		expect(buildPlayerCommand("mpv", "a.wav", 0.5)).toEqual({
			command: "mpv",
			args: ["a.wav"],
		});
	});
});

describe("createPlayer", () => {
	it("spawns detached and ignores errors", () => {
		const calls: Array<{ command: string; args: string[] }> = [];
		const unref = vi.fn();
		const on = vi.fn();
		const spawnFn: SpawnLike = (command, args) => {
			calls.push({ command, args });
			return { on, unref };
		};
		const { config } = normalizeSoundsConfig({ player: "afplay", volume: 0.5 });
		const play = createPlayer(config, { spawn: spawnFn, exists: () => true });
		play("/sounds/a.wav");
		expect(calls[0]?.command).toBe("afplay");
		expect(on).toHaveBeenCalledWith("error", expect.any(Function));
		expect(unref).toHaveBeenCalled();
	});

	it("skips missing files", () => {
		const spawnFn = vi.fn() as unknown as SpawnLike;
		const { config } = normalizeSoundsConfig(undefined);
		createPlayer(config, { spawn: spawnFn, exists: () => false })("/missing.wav");
		expect(spawnFn).not.toHaveBeenCalled();
	});
});
