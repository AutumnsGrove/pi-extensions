/**
 * Open a URL in the system browser. Best effort: the caller always has the URL
 * to print, because SSH/container sessions cannot reach the local desktop.
 */

import { spawn } from "node:child_process";

export function openExternalUrl(url: string): boolean {
	try {
		if (process.platform === "darwin") {
			spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
			return true;
		}
		if (process.platform === "win32") {
			spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
			return true;
		}
		spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
		return true;
	} catch {
		return false;
	}
}
