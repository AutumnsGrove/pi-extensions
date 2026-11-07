/**
 * OpenRouter OAuth PKCE: mint a user-controlled API key without ever seeing the
 * user's password or copying their development key.
 *
 * 1. `GET https://openrouter.ai/auth?callback_url=…&code_challenge=…&key_label=…`
 *    (or without `callback_url` in headless mode; the page shows a code).
 * 2. The redirect carries a one-time `code` (10 minutes).
 * 3. `POST https://openrouter.ai/api/v1/auth/keys` with the code and verifier
 *    returns `{ key }`.
 *
 * The verifier never leaves this process, so a stolen code cannot be exchanged.
 */

import { createHash, randomBytes } from "node:crypto";
import type { FetchLike } from "../github/app.ts";
import {
	CallbackCancelledError,
	CallbackTimeoutError,
	type CallbackServer,
	type CallbackServerOptions,
	startCallbackServer,
} from "./callback.ts";

export const OPENROUTER_AUTH_URL = "https://openrouter.ai/auth";
export const OPENROUTER_KEYS_URL = "https://openrouter.ai/api/v1/auth/keys";

export interface PkcePair {
	verifier: string;
	challenge: string;
}

/** S256 PKCE: verifier is 43 base64url chars, challenge is its SHA-256. */
export function createPkcePair(): PkcePair {
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return { verifier, challenge };
}

export function openRouterAuthUrl(options: {
	challenge: string;
	callbackUrl?: string;
	keyLabel?: string;
	state?: string;
}): string {
	const url = new URL(OPENROUTER_AUTH_URL);
	if (options.callbackUrl) url.searchParams.set("callback_url", options.callbackUrl);
	url.searchParams.set("code_challenge", options.challenge);
	url.searchParams.set("code_challenge_method", "S256");
	if (options.keyLabel) url.searchParams.set("key_label", options.keyLabel);
	if (options.state) url.searchParams.set("state", options.state);
	return url.toString();
}

export interface ExchangeDeps {
	fetch?: FetchLike;
}

/** Exchange the one-time code for the minted key. */
export async function exchangeOpenRouterCode(
	code: string,
	verifier: string,
	deps: ExchangeDeps = {}
): Promise<string> {
	const fetchImpl = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
	const response = await fetchImpl(OPENROUTER_KEYS_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
			"User-Agent": "pi-review",
		},
		body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
	});
	const body = await response.text();
	if (!response.ok) {
		throw new Error(
			`OpenRouter rejected the authorization code (${response.status}): ${body.slice(0, 300) || "no response body"}`
		);
	}
	let parsed: { key?: unknown };
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new Error("OpenRouter returned a token response that was not JSON.");
	}
	if (typeof parsed.key !== "string" || !parsed.key.startsWith("sk-or-")) {
		throw new Error("OpenRouter did not return an API key.");
	}
	return parsed.key;
}

export interface AuthorizeDeps {
	fetch?: FetchLike;
	openUrl?: (url: string) => Promise<boolean>;
	startServer?: (options: CallbackServerOptions) => Promise<CallbackServer>;
	notify?: (message: string) => void;
	/** Headless fallback when the browser cannot reach localhost. */
	onCodePrompt?: () => Promise<string | undefined>;
	timeoutMs?: number;
}

/**
 * Run the full flow and return the minted key.
 *
 * Throws on cancellation, timeout without a pasted code, or a provider error.
 */
export async function authorizeOpenRouter(options: { keyLabel: string } & AuthorizeDeps): Promise<string> {
	const { verifier, challenge } = createPkcePair();
	const state = randomBytes(16).toString("hex");
	const startServer = options.startServer ?? startCallbackServer;
	const notify = options.notify ?? (() => {});
	const openUrl = options.openUrl ?? (async () => false);

	const server = await startServer({
		expectedState: state,
		...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
	});

	try {
		const authUrl = openRouterAuthUrl({
			challenge,
			callbackUrl: server.url,
			keyLabel: options.keyLabel,
			state,
		});
		notify(`Authorize pi-review on OpenRouter: ${authUrl}`);
		await openUrl(authUrl);

		let code: string | undefined;
		try {
			code = (await server.waitForCode).code;
		} catch (error) {
			if (error instanceof CallbackTimeoutError) {
				code = await options.onCodePrompt?.();
				if (!code?.trim()) throw new Error("OpenRouter authorization was cancelled.");
			} else if (error instanceof CallbackCancelledError) {
				throw new Error("OpenRouter authorization was cancelled.");
			} else {
				throw error;
			}
		}

		return await exchangeOpenRouterCode(code, verifier, {
			...(options.fetch ? { fetch: options.fetch } : {}),
		});
	} finally {
		await server.close();
	}
}
