/**
 * Audio playback.
 *
 * Playback is fire-and-forget: the process is spawned detached, stdio is
 * discarded, and errors are ignored. A missing file or player must never
 * interrupt a run.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { SoundsConfig } from "./config.ts";

export interface PlayerCommand {
	command: string;
	args: string[];
}

export function detectPlayer(
	platform: NodeJS.Platform = process.platform,
	has: (command: string) => boolean = commandExists,
): string {
	if (platform === "darwin") return "afplay";
	if (platform === "win32") return "powershell";
	if (has("paplay")) return "paplay";
	if (has("aplay")) return "aplay";
	return "afplay";
}

export function commandExists(command: string): boolean {
	const path = process.env.PATH ?? "";
	for (const dir of path.split(delimiter)) {
		if (!dir) continue;
		if (existsSync(join(dir, command))) return true;
	}
	return false;
}

export function buildPlayerCommand(
	player: string,
	file: string,
	volume: number,
): PlayerCommand {
	switch (player) {
		case "afplay":
			return { command: "afplay", args: ["-v", volume.toFixed(2), file] };
		case "paplay":
			return {
				command: "paplay",
				args: ["--volume", String(Math.round(volume * 65536)), file],
			};
		case "aplay":
			return { command: "aplay", args: [file] };
		case "powershell":
			return {
				command: "powershell",
				args: [
					"-NoProfile",
					"-c",
					`(New-Object Media.SoundPlayer '${file.replace(/'/g, "''")}').PlaySync();`,
				],
			};
		default:
			return { command: player, args: [file] };
	}
}

export type SpawnLike = (
	command: string,
	args: string[],
	options: { detached: boolean; stdio: "ignore" },
) => { on(event: string, listener: () => void): unknown; unref(): void };

/** Build the play function used by the extension. */
export function createPlayer(
	config: SoundsConfig,
	deps: { spawn?: SpawnLike; exists?: (path: string) => boolean } = {},
): (file: string) => void {
	const spawnFn = deps.spawn ?? (spawn as unknown as SpawnLike);
	const exists = deps.exists ?? existsSync;
	const player = config.player ?? detectPlayer();

	return (file: string): void => {
		if (!exists(file)) return;
		const { command, args } = buildPlayerCommand(player, file, config.volume);
		try {
			const child = spawnFn(command, args, { detached: true, stdio: "ignore" });
			child.on("error", () => undefined);
			child.unref();
		} catch {
			// A missing player is not worth interrupting a run for.
		}
	};
}
