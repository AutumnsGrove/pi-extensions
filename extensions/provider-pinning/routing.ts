import type { ProviderPin } from "./config.ts";

export interface PinRouting {
	tag: string;
	allowFallbacks: boolean;
	quantizations?: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Merge a pin into the OpenRouter request body.
 *
 * `only` is a hard allowlist, so a pin cannot be undone by another extension's
 * `provider.sort` (sorting one eligible provider is a no-op). Locally owned
 * fields such as `zdr` or `data_collection` are preserved. Returns the original
 * payload untouched when there is no pin.
 */
export const applyPin = (
	payload: unknown,
	pin: PinRouting | undefined
): unknown => {
	if (!pin || !isRecord(payload)) {
		return payload;
	}
	const current = isRecord(payload.provider) ? payload.provider : {};
	const provider: Record<string, unknown> = {
		...current,
		only: [pin.tag],
		allow_fallbacks: pin.allowFallbacks,
	};
	if (pin.quantizations && pin.quantizations.length > 0) {
		provider.quantizations = [...pin.quantizations];
	}
	// A pin means "do not re-sort across providers".
	delete provider.sort;
	return { ...payload, provider };
};

export const pinForModel = (
	payload: unknown,
	pins: Record<string, ProviderPin>
): ProviderPin | undefined => {
	if (!isRecord(payload) || typeof payload.model !== "string") {
		return undefined;
	}
	return pins[payload.model];
};

/**
 * OpenRouter reports the provider that actually served a request in the stream
 * body (`provider: "DeepSeek"`), not in a response header.
 */
export const extractServedProvider = (data: unknown): string | undefined => {
	if (!isRecord(data)) {
		return undefined;
	}
	for (const key of ["provider", "provider_name"] as const) {
		const value = data[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}
	return undefined;
};

export const headerLookup = (
	headers: Record<string, string>,
	name: string
): string | undefined => {
	const wanted = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === wanted) {
			return value;
		}
	}
	return undefined;
};
