/**
 * Open a URL in the system browser. Best effort: the caller always has the URL
 * to print, because SSH/container sessions cannot reach the local desktop.
 */

import { spawn } from "node:child_process";

export interface OpenDeps {
	/** Test seam; also the explicit opt-in that bypasses the test guard. */
	spawn?: typeof spawn;
}

/** Spawn detached; a missing opener (no `xdg-open` on a headless box) emits an async `error` that would otherwise crash the host process. */
function launch(spawnFn: typeof spawn, command: string, args: string[]): void {
	const child = spawnFn(command, args, { detached: true, stdio: "ignore" });
	child.on("error", () => {});
	child.unref();
}

export function openExternalUrl(url: string, deps: OpenDeps = {}): boolean {
	// Tests must never open a real browser. Injecting `spawn` is the explicit opt-in.
	if (!deps.spawn && process.env.VITEST) return false;
	const spawnFn = deps.spawn ?? spawn;
	try {
		if (process.platform === "darwin") {
			launch(spawnFn, "open", [url]);
			return true;
		}
		if (process.platform === "win32") {
			launch(spawnFn, "cmd", ["/c", "start", "", url]);
			return true;
		}
		launch(spawnFn, "xdg-open", [url]);
		return true;
	} catch {
		return false;
	}
}
