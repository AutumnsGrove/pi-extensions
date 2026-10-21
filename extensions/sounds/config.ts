/**
 * Sound configuration.
 *
 * Lives under `"sounds"` in `settings.json`. Each entry maps a hook event to a
 * file; a bare filename is resolved against `directory`, and `null` disables
 * that event. The defaults match the ClaudeCodeSounds suites.
 */

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface SoundsConfig {
	enabled: boolean;
	/** Where bare filenames are resolved from. `~` is expanded. */
	directory: string;
	/** Overrides autodetection: `afplay`, `paplay`, `aplay`, `powershell`, … */
	player?: string;
	/** 0..1, applied on players that support it. */
	volume: number;
	/** Suppress the same file played twice within this window. */
	debounceMs: number;
	/** Event name → filename, or `null` to stay silent. */
	events: Record<string, string | null>;
}

export const DEFAULT_EVENTS: Record<string, string> = {
	SessionStart: "session_start.wav",
	SessionEnd: "session_end.wav",
	UserPromptSubmit: "prompt_submit.wav",
	AgentStart: "response_start.wav",
	Stop: "stop.wav",
	AgentSettled: "response_end.wav",
	PreToolUse: "tool_start.wav",
	PostToolUse: "tool_complete.wav",
	PostToolUseFailure: "tool_complete.wav",
	PreCompact: "precompact_warning.wav",
	PermissionRequest: "permission_request.wav",
	Notification: "notification.wav",
};

export const DEFAULT_SOUNDS: SoundsConfig = {
	enabled: true,
	directory: "~/ClaudeCodeSounds/Classic",
	volume: 0.7,
	debounceMs: 150,
	events: { ...DEFAULT_EVENTS },
};

export interface LoadedSounds {
	config: SoundsConfig;
	warnings: string[];
}

export function readSoundsConfig(settings: unknown): unknown {
	if (!settings || typeof settings !== "object") return undefined;
	return (settings as Record<string, unknown>).sounds;
}

export function normalizeSoundsConfig(raw: unknown, source = "settings.json"): LoadedSounds {
	const warnings: string[] = [];
	const config: SoundsConfig = {
		...DEFAULT_SOUNDS,
		events: { ...DEFAULT_EVENTS },
	};

	if (raw === undefined || raw === null) return { config, warnings };
	if (typeof raw !== "object" || Array.isArray(raw)) {
		warnings.push(`${source}: "sounds" must be an object`);
		return { config, warnings };
	}

	const value = raw as Record<string, unknown>;
	if (typeof value.enabled === "boolean") config.enabled = value.enabled;
	if (typeof value.directory === "string" && value.directory.trim()) {
		config.directory = value.directory.trim();
	}
	if (typeof value.player === "string" && value.player.trim()) {
		config.player = value.player.trim();
	}
	if (typeof value.volume === "number" && Number.isFinite(value.volume)) {
		config.volume = Math.min(1, Math.max(0, value.volume));
	}
	if (typeof value.debounceMs === "number" && value.debounceMs >= 0) {
		config.debounceMs = value.debounceMs;
	}
	if (value.events !== undefined) {
		if (value.events && typeof value.events === "object" && !Array.isArray(value.events)) {
			for (const [event, file] of Object.entries(value.events as Record<string, unknown>)) {
				if (file === null || file === false) {
					config.events[event] = null;
				} else if (typeof file === "string" && file.trim()) {
					config.events[event] = file.trim();
				} else {
					warnings.push(`${source}: sounds.events.${event} must be a filename or null`);
				}
			}
		} else {
			warnings.push(`${source}: sounds.events must be an object`);
		}
	}

	return { config, warnings };
}

export function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

/** Resolve an event's file: absolute or slash-containing paths stand alone. */
export function resolveSoundFile(file: string, directory: string): string {
	const expanded = expandHome(file);
	if (isAbsolute(expanded) || expanded.includes("/")) return expanded;
	return join(expandHome(directory), expanded);
}

/** The file to play for an event, or `undefined` when silent. */
export function soundForEvent(config: SoundsConfig, event: string): string | undefined {
	const file = config.events[event];
	if (!file) return undefined;
	return resolveSoundFile(file, config.directory);
}

export function describeSounds(config: SoundsConfig): string[] {
	const lines = [
		`Sounds: ${config.enabled ? "on" : "off"}`,
		`Directory: ${config.directory}`,
		`Player: ${config.player ?? "autodetect"} · volume ${config.volume.toFixed(2)} · debounce ${config.debounceMs}ms`,
	];
	for (const [event, file] of Object.entries(config.events)) {
		lines.push(`  ${event}: ${file ?? "(off)"}`);
	}
	return lines;
}
