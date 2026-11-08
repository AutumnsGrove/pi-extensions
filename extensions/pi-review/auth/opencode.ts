/**
 * OpenCode Go credential minting for CI.
 *
 * Reuses the device grant and `provisionApiKey` from the `opencode-go`
 * extension (the same Console flow `/login opencode-go` runs), but with a
 * dedicated, per-repository key name. `provisionApiKey` revokes active keys with
 * the **same name**, so this must never be the user's interactive key name.
 */

import type { ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { deviceSignIn, provisionApiKey } from "../../opencode-go/oauth.ts";

export interface AuthorizeOpenCodeOptions {
	keyName: string;
	notify: (message: string) => void;
	/** Poll ticks. Defaults to `notify`; a waiting dialog can mute them. */
	progress?: (message: string) => void;
	signal?: AbortSignal;
	fetcher?: typeof fetch;
	/** Test seams. */
	signIn?: typeof deviceSignIn;
	provision?: typeof provisionApiKey;
	timeoutMs?: number;
}

/** How long the device grant may stay unapproved before it is abandoned. */
export const OPENCODE_SIGN_IN_TIMEOUT_MS = 15 * 60_000;

/**
 * Sign in with the OpenCode Console device grant, then mint a revocable Go key
 * named `keyName`. Returns the key; never stores it.
 */
export async function authorizeOpenCodeGo(options: AuthorizeOpenCodeOptions): Promise<string> {
	const controller = new AbortController();
	const onAbort = (): void => controller.abort(options.signal?.reason);
	options.signal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(
		() => controller.abort(new Error("OpenCode sign-in timed out.")),
		options.timeoutMs ?? OPENCODE_SIGN_IN_TIMEOUT_MS
	);

	const interaction: ProviderAuthInteraction = {
		signal: controller.signal,
		// The device grant does not ask questions; this is here because the type
		// is shared with prompt-based auth.
		prompt: async () => {
			throw new Error("OpenCode sign-in does not need a prompt.");
		},
		notify: (event) => {
			if (event.type === "device_code") {
				options.notify(
					`OpenCode sign-in: open ${event.verificationUri} and confirm the code ${event.userCode}.`
				);
			} else if (event.type === "progress" || event.type === "info") {
				(options.progress ?? options.notify)(event.message);
			} else if (event.type === "auth_url") {
				options.notify(event.url);
			}
		},
	};

	try {
		const session = await (options.signIn ?? deviceSignIn)(interaction);
		options.notify("Signed in. Minting a dedicated review key…");
		return await (options.provision ?? provisionApiKey)(session.server, session.access, {
			keyName: options.keyName,
			...(session.orgId ? { orgId: session.orgId } : {}),
			signal: controller.signal,
			...(options.fetcher ? { fetcher: options.fetcher } : {}),
		});
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
	}
}
