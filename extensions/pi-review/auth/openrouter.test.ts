import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../github/app.ts";
import type { CallbackServer } from "./callback.ts";
import {
	authorizeOpenRouter,
	createPkcePair,
	exchangeOpenRouterCode,
	openRouterAuthUrl,
} from "./openrouter.ts";

function fakeFetch(status: number, body: string) {
	const calls: { url: string; init?: { body?: string; method?: string } }[] = [];
	const fetchImpl = async (url: string, init?: { body?: string; method?: string }) => {
		calls.push({ url, ...(init ? { init } : {}) });
		return { ok: status >= 200 && status < 300, status, text: async () => body };
	};
	return Object.assign(fetchImpl, { calls });
}

describe("createPkcePair", () => {
	it("produces a 43-character verifier and its S256 challenge", () => {
		const { verifier, challenge } = createPkcePair();
		expect(verifier).toHaveLength(43);
		expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
		expect(challenge).not.toContain("=");
	});

	it("is random per call", () => {
		expect(createPkcePair().verifier).not.toBe(createPkcePair().verifier);
	});
});

describe("openRouterAuthUrl", () => {
	it("includes callback, PKCE, label, and state", () => {
		const url = new URL(
			openRouterAuthUrl({
				challenge: "CH",
				callbackUrl: "http://127.0.0.1:9999/callback",
				keyLabel: "pi-review-owner-repo",
				state: "st",
			})
		);
		expect(url.origin + url.pathname).toBe("https://openrouter.ai/auth");
		expect(url.searchParams.get("callback_url")).toBe("http://127.0.0.1:9999/callback");
		expect(url.searchParams.get("code_challenge")).toBe("CH");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("key_label")).toBe("pi-review-owner-repo");
		expect(url.searchParams.get("state")).toBe("st");
	});

	it("omits the callback in headless mode", () => {
		const url = new URL(openRouterAuthUrl({ challenge: "CH", keyLabel: "label" }));
		expect(url.searchParams.has("callback_url")).toBe(false);
		expect(url.searchParams.get("code_challenge")).toBe("CH");
	});
});

describe("exchangeOpenRouterCode", () => {
	it("posts the code, verifier, and method", async () => {
		const fetchImpl = fakeFetch(200, JSON.stringify({ key: "sk-or-v1-abc" }));
		const key = await exchangeOpenRouterCode("CODE", "VERIFIER", { fetch: fetchImpl as FetchLike });
		expect(key).toBe("sk-or-v1-abc");
		expect(fetchImpl.calls[0]!.url).toBe("https://openrouter.ai/api/v1/auth/keys");
		expect(fetchImpl.calls[0]!.init?.method).toBe("POST");
		expect(JSON.parse(fetchImpl.calls[0]!.init!.body!)).toEqual({
			code: "CODE",
			code_verifier: "VERIFIER",
			code_challenge_method: "S256",
		});
	});

	it("surfaces a rejection", async () => {
		const fetchImpl = fakeFetch(403, "Invalid code or code_verifier");
		await expect(
			exchangeOpenRouterCode("CODE", "V", { fetch: fetchImpl as FetchLike })
		).rejects.toThrow("Invalid code or code_verifier");
	});

	it("rejects a response without an OpenRouter key", async () => {
		const fetchImpl = fakeFetch(200, JSON.stringify({ token: "nope" }));
		await expect(
			exchangeOpenRouterCode("CODE", "V", { fetch: fetchImpl as FetchLike })
		).rejects.toThrow("did not return an API key");
	});

	it("rejects non-JSON", async () => {
		const fetchImpl = fakeFetch(200, "<html>");
		await expect(
			exchangeOpenRouterCode("CODE", "V", { fetch: fetchImpl as FetchLike })
		).rejects.toThrow("not JSON");
	});
});

describe("authorizeOpenRouter", () => {
	function fakeServer(code: string): {
		start: (options: unknown) => Promise<CallbackServer>;
		options: unknown[];
		closes: { count: number };
	} {
		const options: unknown[] = [];
		const closes = { count: 0 };
		const start = async (serverOptions: unknown): Promise<CallbackServer> => {
			options.push(serverOptions);
			return {
				url: "http://127.0.0.1:9999/callback",
				waitForCode: Promise.resolve({ code }),
				close: async () => {
					closes.count += 1;
				},
			};
		};
		return { start, options, closes };
	}

	it("opens the auth URL and exchanges the callback code", async () => {
		const server = fakeServer("CODE-OK");
		const fetchImpl = fakeFetch(200, JSON.stringify({ key: "sk-or-v1-minted" }));
		const opened: string[] = [];
		const messages: string[] = [];
		const key = await authorizeOpenRouter({
			keyLabel: "pi-review-owner-repo",
			startServer: server.start as never,
			fetch: fetchImpl as FetchLike,
			openUrl: async (url) => {
				opened.push(url);
				return true;
			},
			notify: (message) => messages.push(message),
		});
		expect(key).toBe("sk-or-v1-minted");
		expect(opened).toHaveLength(1);
		expect(opened[0]).toContain("callback_url=http");
		expect(opened[0]).toContain("key_label=pi-review-owner-repo");
		expect(messages[0]).toContain("Authorize pi-review on OpenRouter");
		expect(server.closes.count).toBe(1);
		const state = (server.options[0] as { expectedState: string }).expectedState;
		expect(state).toMatch(/^[a-f0-9]{32}$/);
	});

	it("falls back to a pasted code when the callback times out", async () => {
		const server = {
			start: async (): Promise<CallbackServer> => ({
				url: "http://127.0.0.1:9999/callback",
				waitForCode: Promise.reject(new (await import("./callback.ts")).CallbackTimeoutError()),
				close: async () => {},
			}),
		};
		const fetchImpl = fakeFetch(200, JSON.stringify({ key: "sk-or-v1-pasted" }));
		const key = await authorizeOpenRouter({
			keyLabel: "label",
			startServer: server.start as never,
			fetch: fetchImpl as FetchLike,
			openUrl: async () => true,
			onCodePrompt: async () => "PASTED-CODE",
		});
		expect(key).toBe("sk-or-v1-pasted");
		expect(JSON.parse(fetchImpl.calls[0]!.init!.body!).code).toBe("PASTED-CODE");
	});

	it("throws when the pasted code is cancelled", async () => {
		const { CallbackTimeoutError } = await import("./callback.ts");
		const server = {
			start: async (): Promise<CallbackServer> => ({
				url: "http://127.0.0.1:9999/callback",
				waitForCode: Promise.reject(new CallbackTimeoutError()),
				close: async () => {},
			}),
		};
		await expect(
			authorizeOpenRouter({
				keyLabel: "label",
				startServer: server.start as never,
				openUrl: async () => true,
				onCodePrompt: async () => undefined,
			})
		).rejects.toThrow("cancelled");
	});
});
