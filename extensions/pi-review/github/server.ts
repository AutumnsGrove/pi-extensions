/**
 * The localhost half of the GitHub App manifest flow.
 *
 * The manifest cannot be pre-filled with a GET; the browser has to POST it to
 * GitHub. So this server serves one page that auto-submits the form, then
 * listens on `/callback` for the one-hour `code` GitHub redirects with. The
 * `state` nonce is echoed back and checked, so another local process cannot
 * hand us its own App's code.
 *
 * Everything is injected where it matters (`buildManifest`) and the server is
 * plain `node:http`, so tests drive it over a real socket.
 */

import { createServer, type Server } from "node:http";

export class ManifestTimeoutError extends Error {
	constructor() {
		super("Timed out waiting for GitHub to redirect back.");
		this.name = "ManifestTimeoutError";
	}
}

export class ManifestCancelledError extends Error {
	constructor() {
		super("The manifest flow was cancelled.");
		this.name = "ManifestCancelledError";
	}
}

export interface ManifestServerOptions {
	state: string;
	/** GitHub endpoint the form POSTs to, including the state query. */
	submitUrl: string;
	/** Manifest for the redirect URL the server ends up listening on. */
	buildManifest: (redirectUrl: string) => unknown;
	timeoutMs?: number;
	host?: string;
}

export interface ManifestServer {
	/** Page to open in the browser; it auto-submits the manifest to GitHub. */
	startUrl: string;
	redirectUrl: string;
	waitForCode: Promise<string>;
	close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (char) => {
		switch (char) {
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case '"':
				return "&quot;";
			default:
				return "&#39;";
		}
	});
}

function page(title: string, body: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 42rem; margin: 3rem auto; padding: 0 1.25rem; line-height: 1.55; color: #1f2328; }
h1 { font-size: 1.35rem; }
p { color: #57606a; }
button { font: inherit; padding: 0.45rem 0.9rem; border: 1px solid #d0d7de; border-radius: 6px; background: #f6f8fa; cursor: pointer; }
code { background: #f6f8fa; padding: 0.1rem 0.3rem; border-radius: 4px; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

export async function startManifestServer(options: ManifestServerOptions): Promise<ManifestServer> {
	const host = options.host ?? "127.0.0.1";
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	let server: Server | undefined;
	let redirectUrl = "";
	let settle: { resolve: (code: string) => void; reject: (error: Error) => void } | undefined;
	let done = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const waitForCode = new Promise<string>((resolve, reject) => {
		settle = { resolve, reject };
	});
	// A timeout can fire before the caller awaits; do not report an unhandled rejection.
	void waitForCode.catch(() => {});

	const finish = (error: Error | undefined, code?: string): void => {
		if (done) return;
		done = true;
		if (timer) clearTimeout(timer);
		server?.close();
		if (error) settle?.reject(error);
		else settle?.resolve(code ?? "");
	};

	server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", `http://${request.headers.host ?? host}`);
		if (request.method === "GET" && url.pathname === "/favicon.ico") {
			response.writeHead(204).end();
			return;
		}

		if (request.method === "GET" && url.pathname === "/") {
			const manifest = JSON.stringify(options.buildManifest(redirectUrl));
			const body = `<h1>Creating the pi-review GitHub App…</h1>
<p>Continuing to GitHub. If nothing happens, use the button below.</p>
<form id="manifest-form" method="post" action="${escapeHtml(options.submitUrl)}">
<input type="hidden" name="manifest" value="${escapeHtml(manifest)}">
<button type="submit">Continue to GitHub</button>
</form>
<script>document.getElementById("manifest-form").requestSubmit();</script>`;
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("pi-review", body));
			return;
		}

		if (request.method === "GET" && url.pathname === "/callback") {
			const code = url.searchParams.get("code");
			const state = url.searchParams.get("state");
			if (!code) {
				response
					.writeHead(400, { "content-type": "text/html; charset=utf-8" })
					.end(page("pi-review", "<h1>Missing code</h1><p>GitHub did not send a registration code. Return to pi and try again.</p>"));
				return;
			}
			if (state !== options.state) {
				response
					.writeHead(400, { "content-type": "text/html; charset=utf-8" })
					.end(page("pi-review", "<h1>State mismatch</h1><p>This redirect did not belong to this pi-review run. Return to pi and try again.</p>"));
				return;
			}
			response
				.writeHead(200, { "content-type": "text/html; charset=utf-8" })
				.end(page("pi-review", "<h1>Almost done</h1><p>Close this tab and return to pi. The App is created and its key is stored next.</p>"));
			finish(undefined, code);
			return;
		}

		response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
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

	timer = setTimeout(() => finish(new ManifestTimeoutError()), timeoutMs);
	redirectUrl = `http://${host}:${port}/callback`;

	return {
		startUrl: `http://${host}:${port}/`,
		redirectUrl,
		waitForCode,
		close: async () => {
			finish(new ManifestCancelledError());
		},
	};
}
