import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import type { ApiKeyCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { getAgentDir, readStoredCredential } from "@earendil-works/pi-coding-agent";

export const PARALLEL_PROVIDER = "parallel";
export const API_KEY_ENV_VAR = "PARALLEL_API_KEY";

const LOOPBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/callback";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_PLATFORM_ORIGIN = "https://platform.parallel.ai";

export const authFilePath = (): string => join(getAgentDir(), "auth.json");

/** Read the Parallel key stored in pi's `auth.json`. */
export const readParallelApiKey = (authPath: string = authFilePath()): string | undefined => {
	const credential = readStoredCredential(PARALLEL_PROVIDER, authPath) as
		| { type?: string; key?: string }
		| undefined;
	return credential?.type === "api_key" && typeof credential.key === "string"
		? credential.key
		: undefined;
};

const sleepSync = (ms: number): void => {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const withAuthFileLock = <T>(authPath: string, fn: () => T): T => {
	mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
	const lockPath = `${authPath}.parallel.lock`;
	for (let attempt = 0; attempt < 250; attempt++) {
		try {
			mkdirSync(lockPath);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				throw error;
			}
			try {
				if (Date.now() - statSync(lockPath).mtimeMs > 10_000) {
					rmSync(lockPath, { recursive: true, force: true });
					continue;
				}
			} catch {
				// Lock disappeared; retry.
			}
			sleepSync(20);
		}
	}
	try {
		return fn();
	} finally {
		rmSync(lockPath, { recursive: true, force: true });
	}
};

const modifyAuthFile = (
	authPath: string,
	update: (data: Record<string, unknown>) => Record<string, unknown>
): void => {
	withAuthFileLock(authPath, () => {
		let data: Record<string, unknown> = {};
		try {
			const parsed = JSON.parse(readFileSync(authPath, "utf-8")) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				data = parsed as Record<string, unknown>;
			} else {
				throw new Error("auth.json is not a JSON object");
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw new Error(`Refusing to overwrite ${authPath}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		const next = update(data);
		const tmp = `${authPath}.${process.pid}.${Date.now()}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
		renameSync(tmp, authPath);
	});
};

/** Persist the Parallel key under pi's auth store. Pi picks it up via file revision. */
export const storeParallelApiKey = (key: string, authPath: string = authFilePath()): void => {
	modifyAuthFile(authPath, (data) => ({
		...data,
		[PARALLEL_PROVIDER]: { type: "api_key", key } satisfies ApiKeyCredential,
	}));
};

/** Remove the stored Parallel key. */
export const clearParallelApiKey = (authPath: string = authFilePath()): void => {
	modifyAuthFile(authPath, (data) => {
		const next = { ...data };
		delete next[PARALLEL_PROVIDER];
		return next;
	});
};

const toBase64Url = (value: Buffer): string =>
	value.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

export const generatePkce = (): { verifier: string; challenge: string } => {
	const verifier = toBase64Url(randomBytes(32));
	const challenge = toBase64Url(createHash("sha256").update(verifier).digest());
	return { verifier, challenge };
};

export const resolvePlatformOrigin = (override?: string): string => {
	const raw = override ?? process.env.PARALLEL_PLATFORM_URL ?? DEFAULT_PLATFORM_ORIGIN;
	return raw.replace(/\/$/, "");
};

export const openExternalUrl = (url: string): boolean => {
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
};

interface CallbackListener {
	redirectUri: string;
	waitForCallbackUrl(timeoutMs?: number): Promise<string>;
	close(): Promise<void>;
}

const startCallbackListener = async (): Promise<CallbackListener> => {
	let resolveCallback: ((url: string) => void) | undefined;
	let callbackOrigin = "";
	const callbackPromise = new Promise<string>((resolve) => {
		resolveCallback = resolve;
	});

	const server = createServer((req, res) => {
		const requestUrl = req.url ?? "/";
		const callbackUrl = `${callbackOrigin}${requestUrl}`;
		let url: URL;
		try {
			url = new URL(callbackUrl);
		} catch {
			res.writeHead(400, { "Content-Type": "text/plain" });
			res.end("Bad request.");
			return;
		}
		if (url.pathname !== CALLBACK_PATH) {
			res.writeHead(404, { "Content-Type": "text/plain" });
			res.end("Not found.");
			return;
		}
		const denied = Boolean(url.searchParams.get("error"));
		const message = denied
			? "Parallel sign-in was denied. You can close this tab."
			: "Parallel sign-in completed. You can close this tab.";
		res.writeHead(denied ? 400 : 200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(`<!doctype html><html><body><p>${message}</p></body></html>`);
		resolveCallback?.(callbackUrl);
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, LOOPBACK_HOST, () => {
			server.off("error", reject);
			resolve();
		});
	});

	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("Could not start the Parallel OAuth callback listener.");
	}
	callbackOrigin = `http://${LOOPBACK_HOST}:${address.port}`;

	return {
		redirectUri: `${callbackOrigin}${CALLBACK_PATH}`,
		waitForCallbackUrl(timeoutMs = DEFAULT_TIMEOUT_MS) {
			return new Promise<string>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("Parallel sign-in timed out.")), timeoutMs);
				callbackPromise.then(
					(url) => {
						clearTimeout(timer);
						resolve(url);
					},
					(error: unknown) => {
						clearTimeout(timer);
						reject(error instanceof Error ? error : new Error(String(error)));
					}
				);
			});
		},
		async close() {
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections?.();
			});
		},
	};
};

export const exchangeCodeForApiKey = async (
	platformOrigin: string,
	code: string,
	verifier: string,
	redirectUri: string
): Promise<string> => {
	const response = await fetch(`${platformOrigin}/getKeys/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			client_id: new URL(redirectUri).hostname,
			redirect_uri: redirectUri,
			code_verifier: verifier,
		}),
	});
	if (!response.ok) {
		throw new Error(`Parallel token exchange failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
	}
	const payload = (await response.json()) as { access_token?: unknown };
	if (typeof payload.access_token !== "string" || payload.access_token.length === 0) {
		throw new Error("Parallel token exchange did not return an API key.");
	}
	return payload.access_token;
};

const delay = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});

export interface ParallelLoginOptions {
	/** Open the system browser. Providers that render their own auth URL pass false. */
	openBrowser?: boolean;
	onAuthUrl?(url: string, opened: boolean): void;
	promptForCallback?(authUrl: string, signal: AbortSignal): Promise<string | undefined>;
	/** Delay before surfacing the manual-paste prompt. 0 disables the prompt. */
	manualPromptDelayMs?: number;
	signal?: AbortSignal;
	timeoutMs?: number;
	platformOrigin?: string;
}

const raceAbort = async <T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> => {
	if (!signal) {
		return promise;
	}
	if (signal.aborted) {
		throw signal.reason instanceof Error ? signal.reason : new Error("Parallel sign-in was cancelled.");
	}
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<never>((_, reject) => {
		onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("Parallel sign-in was cancelled."));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([promise, aborted]);
	} finally {
		if (onAbort) {
			signal.removeEventListener("abort", onAbort);
		}
	}
};

/**
 * Run the Parallel OAuth 2.0 + PKCE flow against a loopback callback server and
 * return the user's Parallel API key. Falls back to a manually pasted callback
 * URL when the browser cannot reach the loopback server.
 */
export const loginWithParallel = async (options: ParallelLoginOptions = {}): Promise<string> => {
	const platformOrigin = resolvePlatformOrigin(options.platformOrigin);
	const listener = await startCallbackListener();
	const { verifier, challenge } = generatePkce();
	const state = randomUUID();
	const manualController = new AbortController();

	try {
		const authUrl = new URL(`${platformOrigin}/getKeys/authorize`);
		authUrl.searchParams.set("client_id", new URL(listener.redirectUri).hostname);
		authUrl.searchParams.set("redirect_uri", listener.redirectUri);
		authUrl.searchParams.set("response_type", "code");
		authUrl.searchParams.set("scope", "key:read");
		authUrl.searchParams.set("code_challenge", challenge);
		authUrl.searchParams.set("code_challenge_method", "S256");
		authUrl.searchParams.set("state", state);

		const opened = options.openBrowser === false ? false : openExternalUrl(authUrl.toString());
		options.onAuthUrl?.(authUrl.toString(), opened);

		const callbackPromise = raceAbort(listener.waitForCallbackUrl(options.timeoutMs), options.signal).then((url) => {
			manualController.abort();
			return { source: "callback" as const, url };
		});
		// Avoid an unhandled rejection if the manual prompt wins the race.
		callbackPromise.catch(() => undefined);

		let manualPromise: Promise<{ source: "manual"; url: string }> | undefined;
		const prompt = options.promptForCallback;
		const promptDelay = options.manualPromptDelayMs ?? 1_500;
		if (prompt && promptDelay !== 0) {
			manualPromise = delay(promptDelay)
				.then(() => prompt(authUrl.toString(), manualController.signal))
				.then((value) =>
					value && value.trim().length > 0
						? { source: "manual" as const, url: value.trim() }
						: new Promise<never>(() => undefined)
				)
				.catch(() => new Promise<never>(() => undefined));
		}

		const chosen = manualPromise
			? await Promise.race([callbackPromise, manualPromise])
			: await callbackPromise;

		const url = new URL(chosen.url);
		if (url.searchParams.get("state") !== state) {
			throw new Error("Parallel sign-in state check failed.");
		}
		const error = url.searchParams.get("error");
		if (error) {
			throw new Error(`Parallel sign-in failed: ${url.searchParams.get("error_description") ?? error}`);
		}
		const code = url.searchParams.get("code");
		if (!code) {
			throw new Error("Parallel sign-in callback did not include an authorization code.");
		}
		return await exchangeCodeForApiKey(platformOrigin, code, verifier, listener.redirectUri);
	} finally {
		manualController.abort();
		await listener.close();
	}
};

/** Provider-owned login used by pi's native `/login parallel` flow. */
export const parallelProviderLogin = async (
	interaction: ProviderAuthInteraction
): Promise<ApiKeyCredential> => {
	interaction.signal.throwIfAborted();
	const key = await loginWithParallel({
		openBrowser: false,
		signal: interaction.signal,
		onAuthUrl: (url, opened) =>
			interaction.notify({
				type: "auth_url",
				url,
				instructions: opened ? undefined : "Open this URL to sign in to Parallel.",
			}),
		promptForCallback: async (authUrl, signal) => {
			try {
				return await interaction.prompt({
					type: "manual_code",
					message: "Paste the Parallel callback URL",
					placeholder: authUrl,
					signal,
				});
			} catch {
				return undefined;
			}
		},
	});
	interaction.signal.throwIfAborted();
	return { type: "api_key", key };
};

export { raceAbort };
