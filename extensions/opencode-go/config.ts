import { hostname } from "node:os";

/** OpenCode Console origins, provider id, and the public device-flow client id. */
export const PROVIDER_ID = "opencode-go";
export const DEFAULT_SERVER = "https://opencode.ai/console";
/** Public client used by OpenCode itself for the Console device flow. */
export const OPENCODE_CLIENT_ID = "opencode-cli";
/** Service account that owns the keys this extension provisions. */
export const SERVICE_ACCOUNT_NAME = "pi";

/** Console origin. `OPENCODE_CONSOLE_SERVER` mirrors the upstream env override. */
export function resolveServer(override?: string): string {
	const raw = override ?? process.env.OPENCODE_CONSOLE_SERVER ?? DEFAULT_SERVER;
	return raw.replace(/\/+$/, "");
}

/** Per-machine key name, so re-login on a host replaces its own key only. */
export function defaultKeyName(): string {
	const host = (hostname().split(".")[0] ?? "cli").replace(/[^A-Za-z0-9_-]/g, "-");
	return `pi-${host}`.slice(0, 60);
}
