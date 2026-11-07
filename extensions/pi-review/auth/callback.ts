/**
 * A one-shot localhost callback for OAuth PKCE flows.
 *
 * OpenRouter's PKCE flow redirects the browser to a URL we control with a
 * `code`. This server serves exactly that one request, validates `state` when
 * the provider echoes it, and resolves with the code. It is not a general web
 * server: 127.0.0.1 only, one path, one request.
 */

import { createServer, type Server } from "node:http";

export class CallbackTimeoutError extends Error {
	constructor() {
		super("Timed out waiting for the authorization redirect.");
		this.name = "CallbackTimeoutError";
	}
}

export class CallbackCancelledError extends Error {
	constructor() {
		super("The authorization flow was cancelled.");
		this.name = "CallbackCancelledError";
	}
}

export interface CallbackServerOptions {
	path?: string;
	host?: string;
	timeoutMs?: number;
	/** When set, the callback must echo this `state` value. */
	expectedState?: string;
}

export interface CallbackServer {
	/** Full URL to hand to the provider. */
	url: string;
	waitForCode: Promise<{ code: string; state?: string }>;
	close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

function page(title: string, body: string): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:42rem;margin:3rem auto;padding:0 1.25rem;line-height:1.55;color:#1f2328}h1{font-size:1.35rem}p{color:#57606a}</style>
</head><body>${body}</body></html>`;
}

export async function startCallbackServer(options: CallbackServerOptions = {}): Promise<CallbackServer> {
	const host = options.host ?? "127.0.0.1";
	const path = options.path ?? "/callback";
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	let server: Server | undefined;
	let url = "";
	let settle: { resolve: (value: { code: string; state?: string }) => void; reject: (error: Error) => void } | undefined;
	let done = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const waitForCode = new Promise<{ code: string; state?: string }>((resolve, reject) => {
		settle = { resolve, reject };
	});
	// A timeout can fire before the caller awaits; avoid an unhandled rejection.
	void waitForCode.catch(() => {});

	const finish = (error: Error | undefined, code?: string, state?: string): void => {
		if (done) return;
		done = true;
		if (timer) clearTimeout(timer);
		server?.close();
		if (error) settle?.reject(error);
		else settle?.resolve({ code: code ?? "", ...(state ? { state } : {}) });
	};

	server = createServer((request, response) => {
		const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
		if (request.method !== "GET" || requestUrl.pathname !== path) {
			response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
			return;
		}
		const code = requestUrl.searchParams.get("code");
		const state = requestUrl.searchParams.get("state") ?? undefined;
		if (!code) {
			response
				.writeHead(400, { "content-type": "text/html; charset=utf-8" })
				.end(page("pi-review", "<h1>Missing code</h1><p>The provider did not send an authorization code. Return to pi and try again.</p>"));
			return;
		}
		if (options.expectedState !== undefined && state !== options.expectedState) {
			response
				.writeHead(400, { "content-type": "text/html; charset=utf-8" })
				.end(page("pi-review", "<h1>State mismatch</h1><p>This redirect did not belong to this sign-in. Return to pi and try again.</p>"));
			return;
		}
		response
			.writeHead(200, { "content-type": "text/html; charset=utf-8" })
			.end(page("pi-review", "<h1>Authorized</h1><p>Close this tab and return to pi.</p>"));
		finish(undefined, code, state);
	});

	let port = 0;
	await new Promise<void>((resolve, reject) => {
		server!.once("error", reject);
		server!.listen(0, host, () => {
			const address = server!.address();
			if (address && typeof address === "object") port = address.port;
			resolve();
		});
	});
	url = `http://${host}:${port}${path}`;
	timer = setTimeout(() => finish(new CallbackTimeoutError()), timeoutMs);

	return {
		url,
		waitForCode,
		close: async () => {
			finish(new CallbackCancelledError());
		},
	};
}
