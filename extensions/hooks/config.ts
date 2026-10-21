/**
 * Load and normalize the `"hooks"` key from `settings.json`.
 *
 * Pi's settings manager parses JSON without a strict schema and deep-merges
 * global over project, so `hooks` is preserved and project values win. That
 * also means arrays are replaced rather than concatenated: a project entry for
 * an event replaces the global entry for the same event.
 */

import { canonicalEvent, isSupported } from "./events.ts";
import type {
	HookHandlerConfig,
	HookMatcherGroup,
	HookEventName,
	HooksConfig,
	NormalizedHook,
} from "./types.ts";

export interface LoadedHooks {
	hooks: NormalizedHook[];
	warnings: string[];
}

/** Read `settings.hooks` without assuming it is well formed. */
export function readHooksConfig(settings: unknown): unknown {
	if (!settings || typeof settings !== "object") return undefined;
	return (settings as Record<string, unknown>).hooks;
}

/** Normalize a raw config into dispatchable hooks. Invalid entries warn, never throw. */
export function normalizeHooks(raw: unknown, source = "settings.json"): LoadedHooks {
	const warnings: string[] = [];
	const hooks: NormalizedHook[] = [];

	if (raw === undefined || raw === null) return { hooks, warnings };
	if (typeof raw !== "object" || Array.isArray(raw)) {
		warnings.push(`${source}: "hooks" must be an object`);
		return { hooks, warnings };
	}

	for (const [rawEvent, groups] of Object.entries(raw as HooksConfig)) {
		const event = canonicalEvent(rawEvent);
		if (!event) {
			warnings.push(`${source}: unknown hook event "${rawEvent}"`);
			continue;
		}
		if (!isSupported(event)) {
			warnings.push(
				`${source}: "${rawEvent}" maps to ${event}, which this pi version does not expose yet; hook ignored`,
			);
			continue;
		}
		if (!Array.isArray(groups)) {
			warnings.push(`${source}: hooks.${rawEvent} must be an array of matcher groups`);
			continue;
		}
		for (const [groupIndex, group] of groups.entries()) {
			if (!group || typeof group !== "object") {
				warnings.push(`${source}: hooks.${rawEvent}[${groupIndex}] must be an object`);
				continue;
			}
			const matcher =
				typeof (group as HookMatcherGroup).matcher === "string"
					? (group as HookMatcherGroup).matcher
					: undefined;
			const handlers = (group as HookMatcherGroup).hooks;
			if (!Array.isArray(handlers)) {
				warnings.push(
					`${source}: hooks.${rawEvent}[${groupIndex}].hooks must be an array`,
				);
				continue;
			}
			for (const [handlerIndex, handler] of handlers.entries()) {
				const where = `${source}: hooks.${rawEvent}[${groupIndex}].hooks[${handlerIndex}]`;
				const problem = validateHandler(handler, event, where);
				if (typeof problem === "string") {
					warnings.push(problem);
					continue;
				}
				hooks.push({
					event,
					matcher,
					handler: problem,
					key: hookKey(event, matcher, problem),
					source,
				});
			}
		}
	}

	return { hooks, warnings };
}

function validateHandler(
	handler: unknown,
	event: HookEventName,
	where: string,
): HookHandlerConfig | string {
	if (!handler || typeof handler !== "object") return `${where} must be an object`;
	const value = handler as Record<string, unknown>;
	const type = value.type;
	if (type === undefined && typeof value.command === "string") {
		// Convenience: a command handler may omit `type`.
		return validateHandler({ ...value, type: "command" }, event, where);
	}
	if (type !== "command" && type !== "http" && type !== "prompt" && type !== "agent") {
		return `${where}.type must be "command", "http", "prompt", or "agent"`;
	}
	if (type === "agent") {
		return `${where}: "agent" hooks are not implemented yet; use "prompt"`;
	}
	if (type === "command" && typeof value.command !== "string") {
		return `${where}.command must be a string`;
	}
	if (type === "command" && value.args !== undefined && !isStringArray(value.args)) {
		return `${where}.args must be an array of strings`;
	}
	if (type === "http" && typeof value.url !== "string") {
		return `${where}.url must be a string`;
	}
	if (type === "prompt" && typeof value.prompt !== "string") {
		return `${where}.prompt must be a string`;
	}
	if (
		(type === "http" || type === "prompt") &&
		value.if !== undefined &&
		event !== "PreToolUse" &&
		event !== "PostToolUse" &&
		event !== "PostToolUseFailure" &&
		event !== "PermissionRequest" &&
		event !== "PermissionDenied"
	) {
		return `${where}.if is only valid on tool events`;
	}
	if (value.timeout !== undefined && !isPositiveNumber(value.timeout)) {
		return `${where}.timeout must be a positive number of seconds`;
	}
	if (value.onFailure !== undefined && value.onFailure !== "continue" && value.onFailure !== "block") {
		return `${where}.onFailure must be "continue" or "block"`;
	}

	return value as unknown as HookHandlerConfig;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isPositiveNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Stable identity, used for `once` tracking and `/hooks` output. */
export function hookKey(
	event: HookEventName,
	matcher: string | undefined,
	handler: HookHandlerConfig,
): string {
	return `${event}\u0000${matcher ?? "*"}\u0000${stableStringify(handler)}`;
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
	return `{${entries.join(",")}}`;
}

/** Default timeout in seconds, following Claude. */
export function defaultTimeout(type: HookHandlerConfig["type"]): number {
	switch (type) {
		case "prompt":
			return 30;
		case "agent":
			return 60;
		default:
			return 600;
	}
}
