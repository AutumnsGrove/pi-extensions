/**
 * `http` hooks: POST the event JSON and read the same JSON output schema back.
 *
 * 2xx with an empty body is success with no output. 2xx with a JSON object is
 * parsed like command stdout. Anything else is a non-blocking error unless the
 * hook sets `onFailure: "block"`.
 */

import type { HookInput, HookOutput, NormalizedHook } from "../types.ts";
import { normalizeOutput } from "../input.ts";

export interface HttpHookResult {
	output: HookOutput | null;
	error?: string;
	blocked: boolean;
	durationMs: number;
}

const ENV_REFERENCE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

export function interpolateHeaders(
	headers: Record<string, string> | undefined,
	env: NodeJS.ProcessEnv,
	allowed: string[] | undefined,
): Record<string, string> {
	const out: Record<string, string> = {};
	const allowedSet = allowed ? new Set(allowed) : undefined;
	for (const [name, value] of Object.entries(headers ?? {})) {
		out[name] = value.replace(ENV_REFERENCE, (_match, braced: string, bare: string) => {
			const key = braced ?? bare;
			if (allowedSet && !allowedSet.has(key)) return "";
			return env[key] ?? "";
		});
	}
	return out;
}

export async function runHttpHook(
	hook: NormalizedHook,
	input: HookInput,
	options: { timeoutMs: number; signal?: AbortSignal; debug?: (message: string) => void },
): Promise<HttpHookResult> {
	const handler = hook.handler as Extract<NormalizedHook["handler"], { type: "http" }>;
	const started = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), Math.max(1, options.timeoutMs));
	const onAbort = (): void => controller.abort();
	options.signal?.addEventListener("abort", onAbort, { once: true });

	try {
		const response = await fetch(handler.url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...interpolateHeaders(handler.headers, process.env, handler.allowedEnvVars),
			},
			body: JSON.stringify(input),
			signal: controller.signal,
		});
		const text = (await response.text()).trim();
		if (!response.ok) {
			return {
				output: null,
				error: `HTTP ${response.status}${text ? `: ${text.slice(0, 500)}` : ""}`,
				blocked: handler.onFailure === "block",
				durationMs: Date.now() - started,
			};
		}
		if (text === "") {
			options.debug?.(`http ${handler.url} returned an empty body`);
			return { output: {}, blocked: false, durationMs: Date.now() - started };
		}
		if (!text.startsWith("{")) {
			return {
				output: null,
				error: "HTTP hook returned a non-JSON body",
				blocked: handler.onFailure === "block",
				durationMs: Date.now() - started,
			};
		}
		try {
			return {
				output: normalizeOutput(JSON.parse(text)),
				blocked: false,
				durationMs: Date.now() - started,
			};
		} catch (error) {
			return {
				output: null,
				error: `invalid JSON in response: ${(error as Error).message}`,
				blocked: handler.onFailure === "block",
				durationMs: Date.now() - started,
			};
		}
	} catch (error) {
		const aborted = (error as Error).name === "AbortError";
		return {
			output: null,
			error: aborted
				? `HTTP hook timed out after ${options.timeoutMs}ms`
				: `HTTP hook failed: ${(error as Error).message}`,
			blocked: handler.onFailure === "block",
			durationMs: Date.now() - started,
		};
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
	}
}
