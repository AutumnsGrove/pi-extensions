import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { EndpointCache } from "./cache.ts";
import {
	type PinsFile,
	type ProviderPin,
	loadPins,
	savePins,
} from "./config.ts";
import {
	deepseekBadge,
	isDeepseekProvider,
	nextDeepseekTransition,
} from "./deepseek.ts";
import { type EndpointCatalog, fetchEndpointCatalog } from "./endpoints.ts";
import {
	applyPin,
	extractServedProvider,
	pinForModel,
} from "./routing.ts";
import { type PinResult, createProviderTable } from "./table.ts";

const STATUS_KEY = "openrouter-pin";

const REGIONAL_HOSTS: Record<string, string> = {
	global: "openrouter.ai",
	us: "us.openrouter.ai",
	eu: "eu.openrouter.ai",
};

/** Honour Ori's region/base-url overrides; fall back to the public API. */
export const resolveBaseUrl = (
	env: NodeJS.ProcessEnv = globalThis.process.env
): string => {
	const explicit = env.ORI_OPENROUTER_BASE_URL?.trim() || env.ORI_OPENROUTER_ENDPOINT?.trim();
	if (explicit) {
		return explicit.includes("://") ? explicit : `https://${explicit}`;
	}
	const raw = (env.ORI_OPENROUTER_REGION ?? "global").trim().toLowerCase();
	const region =
		raw === "us" || raw === "usa"
			? "us"
			: raw === "eu" || raw === "europe"
				? "eu"
				: "global";
	return `https://${REGIONAL_HOSTS[region] ?? REGIONAL_HOSTS.global}/api/v1`;
};

const errorMessage = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

export default function providerPinning(pi: ExtensionAPI): void {
	const agentDir = getAgentDir();
	const pinsPath = join(agentDir, "provider-pins.json");
	const cachePath = join(agentDir, "provider-endpoints-cache.json");
	const cache = new EndpointCache(cachePath);
	const lastServed = new Map<string, string>();
	let pins: PinsFile = loadPins(pinsPath);
	let statusTimer: ReturnType<typeof setTimeout> | undefined;
	let activeContext: ExtensionContext | undefined;

	const isOpenRouter = (ctx: ExtensionContext): boolean =>
		ctx.model?.provider === "openrouter";

	/** True when the effective route is DeepSeek's own API, pinned or served. */
	const isDeepseekActive = (ctx: ExtensionContext): boolean => {
		if (!isOpenRouter(ctx) || !ctx.model) {
			return false;
		}
		const pin = pins.pins[ctx.model.id];
		const served = lastServed.get(ctx.model.id);
		return (
			isDeepseekProvider(pin?.providerName) ||
			isDeepseekProvider(pin?.tag) ||
			isDeepseekProvider(served)
		);
	};

	const statusFor = (ctx: ExtensionContext): void => {
		if (!isOpenRouter(ctx) || !ctx.model) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const pin = pins.pins[ctx.model.id];
		const served = lastServed.get(ctx.model.id);
		const parts: string[] = [];
		if (pin) {
			parts.push(`pin: ${pin.providerName}${pin.allowFallbacks ? " ↺" : ""}`);
		}
		if (served && (!pin || served !== pin.providerName)) {
			parts.push(`via ${served}`);
		}
		if (isDeepseekActive(ctx)) {
			parts.push(deepseekBadge());
		}
		ctx.ui.setStatus(STATUS_KEY, parts.length > 0 ? parts.join(" · ") : undefined);
	};

	const clearStatusTimer = (): void => {
		if (statusTimer !== undefined) {
			clearTimeout(statusTimer);
			statusTimer = undefined;
		}
	};

	/**
	 * Update the status text and arm the next refresh. The DeepSeek badge changes
	 * at window edges; while DeepSeek is active we also tick once a minute so the
	 * "time left" stays honest. No timer runs when DeepSeek is not the route.
	 */
	const refreshStatus = (ctx: ExtensionContext): void => {
		activeContext = ctx;
		statusFor(ctx);
		clearStatusTimer();
		if (!isDeepseekActive(ctx)) {
			return;
		}
		const now = new Date();
		const next = nextDeepseekTransition(now);
		const untilFlip = next ? next.getTime() - now.getTime() : 60_000;
		const delay = Math.max(1_000, Math.min(untilFlip + 500, 60_000));
		statusTimer = setTimeout(() => {
			statusTimer = undefined;
			if (activeContext) {
				refreshStatus(activeContext);
			}
		}, delay);
		statusTimer.unref?.();
	};

	const setPin = (
		ctx: ExtensionContext,
		modelId: string,
		pin: ProviderPin | undefined
	): void => {
		if (pin) {
			pins.pins[modelId] = pin;
		} else {
			delete pins.pins[modelId];
		}
		savePins(pinsPath, pins);
		refreshStatus(ctx);
		ctx.ui.notify(
			pin
				? `Pinned ${modelId} to ${pin.providerName} (${pin.tag})${pin.allowFallbacks ? ", fallbacks allowed" : ", no fallbacks"}`
				: `Cleared provider pin for ${modelId}`,
			"info"
		);
	};

	const pinFromTag = (
		ctx: ExtensionContext,
		modelId: string,
		tag: string
	): void => {
		const catalog = cache.get(modelId);
		const match =
			catalog?.endpoints.find((endpoint) => endpoint.tag === tag) ??
			catalog?.endpoints.find(
				(endpoint) => endpoint.providerName.toLowerCase() === tag.toLowerCase()
			);
		setPin(ctx, modelId, {
			tag: match?.tag ?? tag,
			providerName: match?.providerName ?? tag,
			allowFallbacks: false,
			quantizations:
				match?.quantization && match.quantization !== "unknown"
					? [match.quantization]
					: [],
			updatedAt: new Date().toISOString(),
		});
	};

	const openTable = async (
		ctx: ExtensionContext,
		modelId: string
	): Promise<void> => {
		const cached = cache.get(modelId);
		const apiKey = globalThis.process.env.OPENROUTER_API_KEY?.trim();
		const load = async (): Promise<EndpointCatalog> => {
			try {
				const catalog = await fetchEndpointCatalog(modelId, {
					baseUrl: resolveBaseUrl(),
					apiKey,
					signal: ctx.signal,
				});
				cache.set(catalog);
				return catalog;
			} catch (error) {
				if (cached) {
					ctx.ui.notify(
						`Showing cached providers: ${errorMessage(error)}`,
						"warning"
					);
					return cached;
				}
				throw error;
			}
		};

		const result = await ctx.ui.custom<PinResult | undefined>((tui, theme, _keybindings, done) =>
			createProviderTable({
				modelId,
				pin: pins.pins[modelId],
				lastServed: lastServed.get(modelId),
				load,
				initial: cached,
				theme,
				requestRender: () => tui.requestRender(),
				done,
			})
		);
		if (!result) {
			return;
		}
		if (result.action === "clear") {
			setPin(ctx, modelId, undefined);
			return;
		}
		setPin(ctx, modelId, {
			tag: result.tag,
			providerName: result.providerName,
			allowFallbacks: result.allowFallbacks,
			quantizations: result.quantizations,
			updatedAt: new Date().toISOString(),
		});
	};

	pi.on("session_start", (_event, ctx) => {
		pins = loadPins(pinsPath);
		refreshStatus(ctx);
	});

	pi.on("session_shutdown", () => {
		clearStatusTimer();
		activeContext = undefined;
	});

	pi.on("turn_start", (_event, ctx) => {
		refreshStatus(ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!isOpenRouter(ctx)) {
			return undefined;
		}
		return applyPin(event.payload, pinForModel(event.payload, pins.pins));
	});

	// OpenRouter names the provider that served the request in the stream body,
	// so scan chunks until we see it and remember it per model.
	pi.on("provider_stream_event", (event, ctx) => {
		if (!isOpenRouter(ctx) || !ctx.model) {
			return;
		}
		const providerName = extractServedProvider(event.data);
		if (!providerName || lastServed.get(ctx.model.id) === providerName) {
			return;
		}
		lastServed.set(ctx.model.id, providerName);
		refreshStatus(ctx);
	});

	// Bridge from the built-in `/models` picker: the API cannot add a button to
	// that component, so when a model is chosen without a pin we nudge.
	pi.on("model_select", (event, ctx) => {
		refreshStatus(ctx);
		if (event.source !== "set" || event.model.provider !== "openrouter") {
			return;
		}
		if (pins.pins[event.model.id]) {
			return;
		}
		ctx.ui.notify(
			`No provider pin for ${event.model.id} · /provider to pin`,
			"info"
		);
	});

	const pinCommand = async (
		args: string,
		ctx: ExtensionCommandContext
	): Promise<void> => {
		if (!ctx.model) {
			ctx.ui.notify("No active model.", "warning");
			return;
		}
		if (!isOpenRouter(ctx)) {
			ctx.ui.notify(
				"Provider pinning only applies to OpenRouter models.",
				"warning"
			);
			return;
		}
		const modelId = ctx.model.id;
		const argument = args.trim();
		if (
			argument === "off" ||
			argument === "clear" ||
			argument === "default"
		) {
			setPin(ctx, modelId, undefined);
			return;
		}
		if (argument.length > 0) {
			pinFromTag(ctx, modelId, argument);
			return;
		}
		if (!ctx.hasUI) {
			ctx.ui.notify("Usage: /provider <tag> or /provider off", "info");
			return;
		}
		await openTable(ctx, modelId);
	};

	pi.registerCommand("provider", {
		description:
			"Pin the current OpenRouter model to a provider so prompt caching stays warm: /provider [tag|off]",
		handler: pinCommand,
	});

	pi.registerCommand("pin", {
		description: "Alias of /provider",
		handler: pinCommand,
	});

	pi.registerShortcut("ctrl+shift+k", {
		description: "Open the OpenRouter provider picker",
		handler: async (ctx) => {
			if (!ctx.model || ctx.model.provider !== "openrouter") {
				ctx.ui.notify(
					"Provider pinning only applies to OpenRouter models.",
					"warning"
				);
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("Interactive UI is not available.", "info");
				return;
			}
			await openTable(ctx, ctx.model.id);
		},
	});

	pi.registerCommand("pins", {
		description: "List every OpenRouter provider pin",
		handler: async (_args, ctx) => {
			const entries = Object.entries(pins.pins);
			if (entries.length === 0) {
				ctx.ui.notify("No provider pins set.", "info");
				return;
			}
			const lines = entries.map(
				([model, pin]) =>
					`${model} → ${pin.providerName} (${pin.tag})${pin.allowFallbacks ? " +fallback" : ""}`
			);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
