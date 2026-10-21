/**
 * Permission modes.
 *
 * Claude's `plan` mode has no pi equivalent (pi has no read-only planning
 * mode), so it is deliberately absent. `shift+tab` is already pi's
 * thinking-level cycle, hence the two shortcuts at the bottom.
 */

import type { PermissionMode } from "./types.ts";

export interface ModeInfo {
	id: PermissionMode;
	label: string;
	icon: string;
	description: string;
}

export const MODES: readonly ModeInfo[] = [
	{
		id: "default",
		label: "Default",
		icon: "🔒",
		description: "Rules decide; ask when unsure.",
	},
	{
		id: "acceptEdits",
		label: "Accept edits",
		icon: "✏️",
		description: "Auto-allow file edits inside the project.",
	},
	{
		id: "auto",
		label: "Auto",
		icon: "🤖",
		description: "Rules, then a classifier; ask only on uncertainty.",
	},
	{
		id: "dontAsk",
		label: "Don't ask",
		icon: "🚫",
		description: "Never prompt; deny anything unmatched.",
	},
	{
		id: "bypass",
		label: "Bypass",
		icon: "⚡",
		description: "Allow everything except explicit denies.",
	},
];

const ALIASES: Record<string, PermissionMode> = {
	default: "default",
	ask: "default",
	"accept-edits": "acceptEdits",
	acceptedits: "acceptEdits",
	accept_edits: "acceptEdits",
	edits: "acceptEdits",
	auto: "auto",
	"dont-ask": "dontAsk",
	dontask: "dontAsk",
	dont_ask: "dontAsk",
	deny: "dontAsk",
	bypass: "bypass",
	yolo: "bypass",
	"bypass-permissions": "bypass",
};

export function parseMode(value: string): PermissionMode | undefined {
	return ALIASES[value.trim().toLowerCase()];
}

export function modeInfo(mode: PermissionMode): ModeInfo {
	return MODES.find((entry) => entry.id === mode) ?? MODES[0]!;
}

/** Cycle order for the shortcut: default → acceptEdits → auto → dontAsk → bypass. */
export function nextMode(mode: PermissionMode): PermissionMode {
	const index = MODES.findIndex((entry) => entry.id === mode);
	return MODES[(index + 1) % MODES.length]!.id;
}

export function modeStatus(mode: PermissionMode): string {
	const info = modeInfo(mode);
	return `${info.icon} ${info.label}`;
}
