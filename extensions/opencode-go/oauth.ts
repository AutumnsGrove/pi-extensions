/**
 * OpenCode Go Console sign-in.
 *
 * Go inference is served by `https://opencode.ai/zen/go/v1`, which accepts a
 * workspace **service key** (`oc_sk_…`), not a Console session token. So signing
 * in means: run the shared Console OAuth 2.0 device authorization grant (the
 * same flow OpenCode itself uses with the public `opencode-cli` client), then
 * provision (or reuse) a `pi` service account with a per-machine key and store
 * that key as pi's api-key credential.
 *
 *   POST /auth/device/code   -> { device_code, user_code, verification_uri_complete, expires_in, interval }
 *   POST /auth/device/token  (poll; grant_type urn:ietf:params:oauth:grant-type:device_code)
 *   GET  /api/service-accounts, POST /api/service-accounts, POST …/keys
 *   GET  /api/go/status      (usage meters; the same key works here)
 */

import { spawn } from "node:child_process";
import type { ApiKeyCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import {
	OPENCODE_CLIENT_ID,
	SERVICE_ACCOUNT_NAME,
	defaultKeyName,
	resolveServer,
} from "./config.ts";

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const CONSOLE_ALIAS_HOST = "console.opencode.ai";

export interface Tokens {
	access: string;
	refresh: string;
	expiresIn: number;
	orgId?: string;
}

export interface DeviceCode {
	deviceCode: string;
	userCode: string;
	verificationUrl: string;
	/** Epoch milliseconds at which the device code stops being accepted. */
	expiresAt: number;
	/** Minimum polling interval, milliseconds. */
	intervalMs: number;
	server: string;
}

export interface DeviceSession {
	server: string;
	access: string;
	refresh: string;
	expiresIn: number;
	accountId: string;
	email: string;
	orgId?: string;
}

interface DeviceCodeCallbacks {
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
	fetcher?: typeof fetch;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
	new Promise<void>((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		if (!signal) return;
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(signal.reason instanceof Error ? signal.reason : new Error("Cancelled."));
		};
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});

const asRecord = (value: unknown): Record<string, unknown> | null =>
	typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const stringField = (record: Record<string, unknown> | null, key: string): string | undefined => {
	const value = record?.[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
};

/** Open a URL in the system browser; returns false when it could not be launched. */
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

/**
 * Resolve the device verification URL. The API returns an origin-absolute path
 * such as `/console/device?user_code=…`; resolving it against the site origin
 * (not the `/console` server path) avoids doubling the prefix.
 */
export function resolveVerificationUrl(server: string, verification: string): string {
	let url: URL;
	try {
		url = new URL(verification, new URL(server).origin);
	} catch {
		throw new Error("OpenCode Console returned an invalid verification URL.");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("OpenCode Console returned a non-HTTP verification URL.");
	}
	if (url.hostname === CONSOLE_ALIAS_HOST) url.hostname = "opencode.ai";
	return url.toString();
}

export function parseDeviceCode(payload: unknown, server: string): DeviceCode | undefined {
	const record = asRecord(payload);
	const deviceCode = stringField(record, "device_code");
	const userCode = stringField(record, "user_code");
	const verification =
		stringField(record, "verification_uri_complete") ?? stringField(record, "verification_uri");
	if (!deviceCode || !userCode || !verification) return undefined;
	const expiresIn =
		typeof record?.expires_in === "number" && record.expires_in > 0 ? record.expires_in : 600;
	const interval = typeof record?.interval === "number" && record.interval > 0 ? record.interval : 5;
	return {
		deviceCode,
		userCode,
		verificationUrl: resolveVerificationUrl(server, verification),
		expiresAt: Date.now() + expiresIn * 1000,
		intervalMs: Math.max(1, interval) * 1000,
		server,
	};
}

export const parseTokens = (payload: unknown): Tokens | undefined => {
	const record = asRecord(payload);
	const access = stringField(record, "access_token");
	if (!access) return undefined;
	const refresh = stringField(record, "refresh_token") ?? "";
	const expiresIn =
		typeof record?.expires_in === "number" && record.expires_in > 0 ? record.expires_in : 3600;
	const orgId = stringField(record, "org_id");
	return { access, refresh, expiresIn, ...(orgId ? { orgId } : {}) };
};

/** Request a device + user code from the Console. */
export async function requestDeviceCode(
	server: string = resolveServer(),
	fetcher: typeof fetch = fetch
): Promise<DeviceCode> {
	const response = await fetcher(`${server}/auth/device/code`, {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json" },
		body: JSON.stringify({ client_id: OPENCODE_CLIENT_ID }),
	});
	if (!response.ok) {
		throw new Error(`OpenCode Go device authorization failed (${response.status}).`);
	}
	const device = parseDeviceCode(await response.json().catch(() => undefined), server);
	if (!device) {
		throw new Error("OpenCode Go returned an incomplete device-code response.");
	}
	return device;
}

/** Poll the token endpoint until the browser approves, denies, or the code expires. */
export async function completeDeviceSignIn(
	device: DeviceCode,
	callbacks: DeviceCodeCallbacks = {}
): Promise<Tokens> {
	const fetcher = callbacks.fetcher ?? fetch;
	const sleep = callbacks.sleep ?? defaultSleep;
	let intervalMs = device.intervalMs;
	while (Date.now() < device.expiresAt) {
		callbacks.onProgress?.("Waiting for OpenCode Go sign-in…");
		await sleep(intervalMs, callbacks.signal);
		const response = await fetcher(`${device.server}/auth/device/token`, {
			method: "POST",
			headers: { Accept: "application/json", "Content-Type": "application/json" },
			body: JSON.stringify({
				grant_type: DEVICE_GRANT,
				device_code: device.deviceCode,
				client_id: OPENCODE_CLIENT_ID,
			}),
			...(callbacks.signal ? { signal: callbacks.signal } : {}),
		});
		const payload = (await response.json().catch(() => undefined)) as unknown;
		const error = stringField(asRecord(payload), "error");
		if (error === "authorization_pending") continue;
		if (error === "slow_down") {
			intervalMs += 5000;
			continue;
		}
		if (error === "expired_token") {
			throw new Error("OpenCode Go device code expired; start sign-in again.");
		}
		if (error === "access_denied") {
			throw new Error("OpenCode Go sign-in was denied.");
		}
		if (error) {
			throw new Error(`OpenCode Go sign-in failed: ${error}`);
		}
		const tokens = parseTokens(payload);
		if (!response.ok || !tokens) {
			throw new Error(`OpenCode Go token exchange failed (${response.status}).`);
		}
		return tokens;
	}
	throw new Error("OpenCode Go device code expired; start sign-in again.");
}

interface ConsoleUser {
	accountId: string;
	email: string;
	orgId?: string;
}

const getJson = async (
	fetcher: typeof fetch,
	url: string,
	token: string,
	signal?: AbortSignal,
	orgId?: string
): Promise<unknown> => {
	const headers: Record<string, string> = {
		Accept: "application/json",
		Authorization: `Bearer ${token}`,
	};
	if (orgId) headers["x-org-id"] = orgId;
	const response = await fetcher(url, { headers, ...(signal ? { signal } : {}) });
	if (!response.ok) throw new Error(`GET ${url} failed (${response.status}).`);
	return response.json().catch(() => undefined);
};

const postJson = async (
	fetcher: typeof fetch,
	url: string,
	token: string,
	body: unknown,
	signal?: AbortSignal,
	orgId?: string
): Promise<unknown> => {
	const headers: Record<string, string> = {
		Accept: "application/json",
		"Content-Type": "application/json",
		Authorization: `Bearer ${token}`,
	};
	if (orgId) headers["x-org-id"] = orgId;
	const response = await fetcher(url, {
		method: "POST",
		headers,
		body: JSON.stringify(body ?? {}),
		...(signal ? { signal } : {}),
	});
	if (!response.ok) throw new Error(`POST ${url} failed (${response.status}).`);
	return response.json().catch(() => undefined);
};

const fetchConsoleUser = async (
	server: string,
	token: string,
	signal?: AbortSignal,
	fetcher: typeof fetch = fetch
): Promise<ConsoleUser> => {
	const [userRaw, orgsRaw] = await Promise.all([
		getJson(fetcher, `${server}/api/user`, token, signal),
		getJson(fetcher, `${server}/api/orgs`, token, signal),
	]);
	const user = asRecord(userRaw);
	const accountId = stringField(user, "id");
	const email = stringField(user, "email");
	if (!accountId || !email) {
		throw new Error("OpenCode Console returned incomplete account information.");
	}
	const orgId = Array.isArray(orgsRaw) ? stringField(asRecord(orgsRaw[0]), "id") : undefined;
	return { accountId, email, ...(orgId ? { orgId } : {}) };
};

/** Full device sign-in against the Console. */
export async function deviceSignIn(
	interaction: ProviderAuthInteraction
): Promise<DeviceSession> {
	const server = resolveServer();
	const device = await requestDeviceCode(server);
	interaction.notify({
		type: "device_code",
		userCode: device.userCode,
		verificationUri: device.verificationUrl,
		intervalSeconds: Math.round(device.intervalMs / 1000),
		expiresInSeconds: Math.round((device.expiresAt - Date.now()) / 1000),
	});
	// Convenience: open the pre-filled approval page automatically.
	openExternalUrl(device.verificationUrl);

	const tokens = await completeDeviceSignIn(device, {
		...(interaction.signal ? { signal: interaction.signal } : {}),
		onProgress: (message) => interaction.notify({ type: "progress", message }),
	});
	const user = await fetchConsoleUser(server, tokens.access, interaction.signal);
	return {
		server,
		access: tokens.access,
		refresh: tokens.refresh,
		expiresIn: tokens.expiresIn,
		accountId: user.accountId,
		email: user.email,
		...(user.orgId ? { orgId: user.orgId } : {}),
	};
}

interface ServiceAccount {
	id: string;
	name: string;
}

interface ServiceAccountItem {
	account?: ServiceAccount;
	keys?: { id: string; name: string; status?: string }[];
}

const findServiceAccount = (
	payload: unknown,
	items: { account?: ServiceAccount }[]
): ServiceAccount | undefined => {
	const list = asRecord(payload);
	const rawItems = list?.items;
	if (Array.isArray(rawItems)) {
		for (const entry of rawItems) {
			if (entry && typeof entry === "object") items.push(entry as { account?: ServiceAccount });
		}
	}
	for (const item of items) {
		if (item.account?.name === SERVICE_ACCOUNT_NAME) return item.account;
	}
	return undefined;
};

export interface ProvisionOptions {
	keyName?: string;
	/** Workspace id; required when provisioning with a Console session token. */
	orgId?: string;
	signal?: AbortSignal;
	fetcher?: typeof fetch;
}

/**
 * Ensure the `pi` service account exists and mint a fresh key for it. Active
 * keys with the same per-machine name are revoked first so re-login replaces
 * the old key instead of piling up.
 */
export async function provisionApiKey(
	server: string,
	sessionToken: string,
	options: ProvisionOptions = {}
): Promise<string> {
	const fetcher = options.fetcher ?? fetch;
	const keyName = options.keyName ?? defaultKeyName();
	const items: { account?: ServiceAccount }[] = [];
	const list = await getJson(fetcher, `${server}/api/service-accounts`, sessionToken, options.signal, options.orgId);
	let account = findServiceAccount(list, items);
	if (!account) {
		const created = asRecord(
			await postJson(
				fetcher,
				`${server}/api/service-accounts`,
				sessionToken,
				{ name: SERVICE_ACCOUNT_NAME },
				options.signal,
				options.orgId
			)
		);
		const nested = asRecord(created?.account) ?? created;
		const id = stringField(nested, "id");
		if (id) account = { id, name: stringField(nested, "name") ?? SERVICE_ACCOUNT_NAME };
	}
	if (!account?.id) {
		throw new Error("Could not create the OpenCode Go service account.");
	}

	const detail = asRecord(
		await getJson(
			fetcher,
			`${server}/api/service-accounts/${account.id}`,
			sessionToken,
			options.signal,
			options.orgId
		)
	);
	const keys = (detail?.keys ?? asRecord(items.find((i) => i.account?.id === account?.id))?.keys) as
		| { id: string; name: string; status?: string }[]
		| undefined;
	for (const key of keys ?? []) {
		if (key.name === keyName && (key.status ?? "active") === "active") {
			await postJson(
				fetcher,
				`${server}/api/service-accounts/keys/${key.id}/revoke`,
				sessionToken,
				undefined,
				options.signal,
				options.orgId
			);
		}
	}

	const created = asRecord(
		await postJson(
			fetcher,
			`${server}/api/service-accounts/${account.id}/keys`,
			sessionToken,
			{ name: keyName, permissions: "all" },
			options.signal,
			options.orgId
		)
	);
	const token = stringField(created, "token");
	if (!token) {
		throw new Error("OpenCode Go provisioning did not return an API key.");
	}
	return token;
}

/**
 * Native `/login opencode-go` flow: device sign-in, then provision a per-machine
 * Go API key and hand it back as pi's api-key credential.
 */
export async function connectOpenCodeGo(
	interaction: ProviderAuthInteraction
): Promise<ApiKeyCredential> {
	const session = await deviceSignIn(interaction);
	interaction.notify({ type: "progress", message: "Provisioning OpenCode Go API key…" });
	const key = await provisionApiKey(session.server, session.access, {
		keyName: defaultKeyName(),
		...(session.orgId ? { orgId: session.orgId } : {}),
		signal: interaction.signal,
	});
	return { type: "api_key", key };
}
