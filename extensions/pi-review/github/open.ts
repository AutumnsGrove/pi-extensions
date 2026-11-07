/**
 * Open a URL in the system browser. Best effort: the caller always has the URL
 * to print, because SSH/container sessions cannot reach the local desktop.
 */

import { spawn } from "node:child_process";

/** Spawn detached; a missing opener (no `xdg-open` on a headless box) emits an async `error` that would otherwise crash the host process. */
function launch(command: string, args: string[]): void {
	const child = spawn(command, args, { detached: true, stdio: "ignore" });
	child.on("error", () => {});
	child.unref();
}

export function openExternalUrl(url: string): boolean {
	try {
		if (process.platform === "darwin") {
			launch("open", [url]);
			return true;
		}
		if (process.platform === "win32") {
			launch("cmd", ["/c", "start", "", url]);
			return true;
		}
		launch("xdg-open", [url]);
		return true;
	} catch {
		return false;
	}
}
