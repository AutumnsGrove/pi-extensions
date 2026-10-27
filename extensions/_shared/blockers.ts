/**
 * Cross-extension "blocker" registry.
 *
 * A blocker is an interactive step that must hold the entire session. While a
 * blocker is active:
 *
 * - no tool may run (`pi-q-n-a` publishes one for the lifetime of its form),
 * - no background completion may wake the agent,
 * - no planning nudge may force one more turn.
 *
 * This is deliberately cooperative: extensions that can start work or trigger a
 * turn check `isBlocked()` before doing so. pi-q-n-a also blocks all tool calls
 * through the `tool_call` hook, which is the backstop for any extension that
 * forgets.
 *
 * State lives on `globalThis` so a `/reload` that re-evaluates the extension
 * modules cannot lose track of a form that is still on screen. Tokens are
 * unique, so overlapping questions release independently.
 */

/** The blocking question tool. Shared so other extensions can exclude it. */
export const PI_QNA_TOOL = "pi-q-n-a";

const REGISTRY_KEY = Symbol.for("pi-extensions.blockers");

interface BlockerRegistry {
	active: Map<string, string>;
	listeners: Set<() => void>;
}

const registry = (): BlockerRegistry => {
	const holder = globalThis as typeof globalThis & { [REGISTRY_KEY]?: BlockerRegistry };
	holder[REGISTRY_KEY] ??= { active: new Map(), listeners: new Set() };
	return holder[REGISTRY_KEY];
};

let nextToken = 0;

const notify = (): void => {
	for (const listener of registry().listeners) {
		try {
			listener();
		} catch {
			// A broken listener must not leave the session blocked.
		}
	}
};

/**
 * Mark the session as blocked and return an idempotent release function.
 * Always call it from a `finally` so a thrown error cannot wedge the session.
 */
export function beginBlocker(label: string): () => void {
	const reg = registry();
	const token = `${label}#${++nextToken}`;
	reg.active.set(token, label);
	notify();
	let released = false;
	return () => {
		if (released) return;
		released = true;
		reg.active.delete(token);
		notify();
	};
}

/** True while any interactive step owns the session. */
export function isBlocked(): boolean {
	return registry().active.size > 0;
}

/** Labels of the active blockers, in the order they were opened. */
export function activeBlockers(): string[] {
	return [...registry().active.values()];
}

/** Subscribe to transitions between blocked and unblocked. */
export function onBlockersChange(listener: () => void): () => void {
	const reg = registry();
	reg.listeners.add(listener);
	return () => reg.listeners.delete(listener);
}

/** Test hook: forget every blocker. */
export function resetBlockers(): void {
	const reg = registry();
	reg.active.clear();
	notify();
}
