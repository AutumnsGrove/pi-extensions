/**
 * opencode-go — native OpenCode Go provider for pi.
 *
 * Reuses pi's built-in `opencode-go` catalog and streaming code (per-model wire
 * API, base URLs, `x-opencode-session` header) and only replaces the login: the
 * built-in `OPENCODE_API_KEY` path stays, and `/login opencode-go` signs in to
 * the OpenCode Console with the OAuth device grant, then provisions a
 * per-machine Go API key and stores it.
 *
 *   /login opencode-go   device sign-in + auto-provision a Go API key
 *   /usage               rolling 5h / weekly / monthly meters vs. the plan
 *
 * The model list is the built-in catalog plus a live overlay from
 * `https://opencode.ai/zen/go/v1/models` (cached), so `/model` tracks OpenCode's
 * current Go list.
 */

import { join } from "node:path";
import { createProvider, type Api, type Model, type Provider } from "@earendil-works/pi-ai";
import {
	anthropicMessagesApi,
	openAICompletionsApi,
	openAIResponsesApi,
} from "@earendil-works/pi-ai/compat";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { withOpenCodeSessionHeader } from "@earendil-works/pi-ai/providers/opencode-headers";
import {
	getAgentDir,
	readStoredCredential,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { PROVIDER_ID, resolveServer } from "./config.ts";
import { loadModelCache, refreshGoModels } from "./discovery.ts";
import { connectOpenCodeGo } from "./oauth.ts";
import { UsagePanel } from "./panel.ts";
import {
	describeUsageError,
	fetchGoUsage,
	formatMeterRow,
	formatPercent,
	type UsageMeter,
} from "./usage.ts";

const STATUS_KEY = "opencode-go";
const REFRESH_MS = 5 * 60_000;
const USAGE = "Usage: /usage [refresh]";
const DISCOVERY_TIMEOUT_MS = 6_000;

const api = {
	"anthropic-messages": withOpenCodeSessionHeader(anthropicMessagesApi()),
	"openai-completions": withOpenCodeSessionHeader(openAICompletionsApi()),
	"openai-responses": withOpenCodeSessionHeader(openAIResponsesApi()),
};

const readStoredKey = (): string | undefined => {
	const credential = readStoredCredential(PROVIDER_ID, join(getAgentDir(), "auth.json")) as
		| { type?: string; key?: string }
		| undefined;
	return credential?.type === "api_key" && typeof credential.key === "string"
		? credential.key
		: undefined;
};

/** Built-in OpenCode Go catalog/streaming + live overlay + a provisioning login. */
export function buildOpenCodeGoProvider(discovered: readonly Model<Api>[] = []): Provider {
	const base = opencodeGoProvider() as Provider;
	const apiKey = base.auth.apiKey;
	if (!apiKey) {
		throw new Error("OpenCode Go provider is missing api-key auth.");
	}
	const baseline = base.getAllModels?.() ?? base.getModels();
	return createProvider({
		id: PROVIDER_ID,
		name: "OpenCode Go",
		auth: {
			apiKey: {
				...apiKey,
				name: "OpenCode Go account",
				login: (interaction) => connectOpenCodeGo(interaction),
			},
		},
		models: [...baseline, ...discovered],
		api,
	});
}

/** Use the cached overlay when present; refresh when stale or missing. */
async function discoverGoModels(baselineIds: ReadonlySet<string>): Promise<Model<Api>[]> {
	const cached = loadModelCache();
	if (cached) {
		if (!cached.fresh) {
			// Refresh for next launch without blocking startup.
			void refreshGoModels(
				baselineIds,
				readStoredKey(),
				AbortSignal.timeout(DISCOVERY_TIMEOUT_MS * 2)
			).catch(() => undefined);
		}
		return cached.models;
	}
	return refreshGoModels(
		baselineIds,
		readStoredKey(),
		AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
	).catch(() => []);
}

export default async function opencodeGoExtension(pi: ExtensionAPI): Promise<void> {
	const base = opencodeGoProvider() as Provider;
	const baseline = base.getAllModels?.() ?? base.getModels();
	const baselineIds = new Set(baseline.map((model) => model.id));
	const discovered = await discoverGoModels(baselineIds);
	pi.registerProvider(buildOpenCodeGoProvider(discovered));

	let latestCtx: ExtensionContext | undefined;
	let meters: UsageMeter[] = [];
	let lastError: string | undefined;
	let updatedAt: number | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;

	const renderStatus = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		if (meters.length === 0) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const parts = meters.map((meter) => `${meter.short} ${formatPercent(meter.percent)}`);
		ctx.ui.setStatus(STATUS_KEY, `go ${parts.join(" · ")}`);
	};

	const refresh = async (ctx: ExtensionContext): Promise<void> => {
		latestCtx = ctx;
		let token: string | undefined;
		try {
			token = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER_ID);
		} catch {
			token = undefined;
		}
		if (!token) {
			meters = [];
			lastError = "Not signed in. Run /login opencode-go.";
			renderStatus(ctx);
			return;
		}
		try {
			meters = await fetchGoUsage(resolveServer(), token, undefined);
			lastError = undefined;
			updatedAt = Date.now();
		} catch (error) {
			meters = [];
			lastError = describeUsageError(error);
		}
		renderStatus(ctx);
	};

	pi.on("session_start", (_event, ctx) => {
		latestCtx = ctx;
		void refresh(ctx);
		if (timer) clearInterval(timer);
		timer = setInterval(() => {
			if (latestCtx) void refresh(latestCtx);
		}, REFRESH_MS);
		timer.unref?.();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	const showUsage = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		void args;
		await refresh(ctx);
		if (!ctx.hasUI) {
			const lines = ["OpenCode Go — usage"];
			if (lastError) lines.push(lastError);
			else if (meters.length === 0) lines.push("No usage data.");
			else for (const meter of meters) lines.push(formatMeterRow(meter));
			ctx.ui.notify(lines.join("\n"), lastError ? "warning" : "info");
			return;
		}
		await ctx.ui.custom<undefined>((_tui, theme, _keybindings, done) =>
			new UsagePanel({
				meters,
				updatedAt,
				theme,
				done,
				...(lastError ? { error: lastError } : {}),
			})
		);
	};

	pi.registerCommand("usage", {
		description: "Show OpenCode Go usage (rolling 5h / weekly / monthly) against your plan",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			if (parts.length > 0 && parts[0] !== "refresh") {
				ctx.ui.notify(USAGE, "info");
				return;
			}
			await showUsage(args, ctx);
		},
	});
}
