/**
 * sounds — audio feedback for pi, driven entirely by the hooks bus.
 *
 * The extension registers an observe-only handler for each hook event and
 * plays the mapped file, debounced and detached. It shares no code with
 * `notify`: that extension owns desktop banners, this one owns audio.
 *
 * It also listens for `pi-permissions:prompt` (emitted by the permissions
 * extension) so the permission dialog gets a cue, because the hooks engine
 * never dispatches `PermissionRequest` itself.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { SUPPORTED_EVENTS, type HookInput } from "../hooks/types.ts";
import {
	describeSounds,
	normalizeSoundsConfig,
	readSoundsConfig,
	soundForEvent,
	type SoundsConfig,
} from "./config.ts";
import { createPlayer } from "./player.ts";

export interface SoundsDeps {
	play?: (file: string) => void;
	now?: () => number;
}

export function createSounds(pi: ExtensionAPI, deps: SoundsDeps = {}): void {
	// Settings are not readable during extension loading; `session_start`
	// performs the first real load.
	let loaded = normalizeSoundsConfig(undefined);
	const lastPlayed = new Map<string, number>();
	const now = deps.now ?? (() => Date.now());
	let player: ((file: string) => void) | undefined;

	const playEvent = (event: string): void => {
		const config = loaded.config;
		if (!config.enabled) return;
		const file = soundForEvent(config, event);
		if (!file) return;
		const stamp = now();
		const previous = lastPlayed.get(file);
		if (previous !== undefined && stamp - previous < config.debounceMs) return;
		lastPlayed.set(file, stamp);
		if (deps.play) {
			deps.play(file);
			return;
		}
		player ??= createPlayer(config);
		player(file);
	};

	const register = (): void => {
		for (const event of SUPPORTED_EVENTS) {
			pi.events.emit("pi-hooks:register", {
				event,
				source: "sounds",
				handler: (input: HookInput) => {
					playEvent(input.hook_event_name ?? event);
				},
			});
		}
	};

	if ((globalThis as Record<string, unknown>).__piHooksReady) {
		register();
	} else {
		pi.events.on("pi-hooks:ready", () => register());
	}

	// Permission dialogs come from the permissions extension, not a hook event.
	pi.events.on("pi-permissions:prompt", () => playEvent("PermissionRequest"));

	pi.on("session_start", async (_event, ctx) => {
		reload();
		if (pi.getFlag("mute") === true) loaded.config.enabled = false;
		reportWarnings(ctx);
	});

	pi.on("session_shutdown", async () => {
		lastPlayed.clear();
	});

	pi.registerFlag("mute", {
		description: "Start with sounds disabled",
		type: "boolean",
	});

	pi.registerCommand("sounds", {
		description: "Show, toggle, or test the sound mapping",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const trimmed = args.trim();
			const [sub, ...rest] = trimmed.split(/\s+/);
			const tail = rest.join(" ").trim();

			if (!trimmed) {
				ctx.ui.notify(describeSounds(loaded.config).join("\n"), "info");
				return;
			}
			if (sub === "on" || sub === "off") {
				loaded.config.enabled = sub === "on";
				ctx.ui.notify(`Sounds ${sub}.`, "info");
				return;
			}
			if (sub === "reload") {
				reload();
				ctx.ui.notify(
					`Reloaded sound settings${loaded.warnings.length ? ` with ${loaded.warnings.length} warning(s)` : ""}.`,
					loaded.warnings.length ? "warning" : "info",
				);
				return;
			}
			if (sub === "dir") {
				if (!tail) {
					ctx.ui.notify("Usage: /sounds dir <path>", "warning");
					return;
				}
				loaded.config.directory = tail;
				ctx.ui.notify(`Sound directory: ${tail}`, "info");
				return;
			}
			if (sub === "test") {
				const event = tail || "SessionStart";
				const file = soundForEvent(loaded.config, event);
				if (!file) {
					ctx.ui.notify(`${event} is not mapped to a sound.`, "warning");
					return;
				}
				playEvent(event);
				ctx.ui.notify(`Played ${file}`, "info");
				return;
			}
			ctx.ui.notify(`Unknown subcommand "${sub}".`, "warning");
		},
	});

	function reload(): void {
		try {
			loaded = normalizeSoundsConfig(readSoundsConfig(pi.getSettings()), "settings.json");
		} catch {
			// Keep the previous mapping.
		}
	}

	function reportWarnings(ctx: ExtensionContext): void {
		if (loaded.warnings.length > 0 && ctx.hasUI) {
			ctx.ui.notify(loaded.warnings.join("\n"), "warning");
		}
	}
}

export default function sounds(pi: ExtensionAPI): void {
	createSounds(pi);
}
