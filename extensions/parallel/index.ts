import { randomUUID } from "node:crypto";
import { Type, type Static } from "typebox";
import type { Provider } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import {
	API_KEY_ENV_VAR,
	PARALLEL_PROVIDER,
	clearParallelApiKey,
	loginWithParallel,
	parallelProviderLogin,
	readParallelApiKey,
	storeParallelApiKey,
} from "./auth.ts";
import {
	extractParallel,
	isParallelAuthError,
	searchParallel,
	type ParallelExtractResponse,
	type ParallelSearchResponse,
} from "./client.ts";
import { configPath, loadConfig, quotaPath, type ParallelConfig } from "./config.ts";
import { estimateExtractCost, estimateSearchCost, formatUsd } from "./cost.ts";
import { formatExtractResults, formatSearchResults, pageContents, truncateForModel } from "./format.ts";
import { QuotaExceededError, QuotaStore, type QuotaCost, type QuotaLedger, type QuotaLimits } from "./quota.ts";
import { resolveSummaryModel, summarizePages } from "./summarize.ts";

const STATUS_KEY = "parallel";
const SOFT_WARNING_PREFIX = "⚠ Parallel monthly soft limit exceeded";

interface QuotaSnapshot {
	month: string;
	queries: number;
	usd: number;
	softLimitQueries: number;
	hardLimitQueries: number;
	hardLimitUsd: number;
}

interface WebSearchDetails {
	searchId?: string;
	resultCount?: number;
	mode?: string;
	quota?: QuotaSnapshot;
}

interface WebFetchDetails {
	phase?: "fetching" | "summarizing" | "done";
	extractId?: string;
	urls?: number;
	summarized?: boolean;
	summaryModel?: string;
	quota?: QuotaSnapshot;
}

const WebSearchParams = Type.Object({
	objective: Type.String({
		description: "Natural-language description of the goal driving the search.",
	}),
	search_queries: Type.Array(Type.String(), {
		minItems: 1,
		description: "2-3 concise keyword queries of 3-6 words each.",
	}),
	mode: Type.Optional(
		Type.Union(
			[Type.Literal("turbo"), Type.Literal("fast"), Type.Literal("basic"), Type.Literal("advanced")],
			{ description: "Search mode. Defaults to the configured mode (fast)." }
		)
	),
	max_results: Type.Optional(
		Type.Integer({ minimum: 1, maximum: 50, description: "Maximum results (default 10)." })
	),
});

const WebFetchParams = Type.Object({
	urls: Type.Array(Type.String(), {
		minItems: 1,
		maxItems: 20,
		description: "URLs to fetch (up to 20).",
	}),
	objective: Type.Optional(
		Type.String({ description: "What to extract from the pages. Focuses the returned excerpts." })
	),
	search_queries: Type.Optional(
		Type.Array(Type.String(), { description: "Optional keyword queries to focus extraction." })
	),
	prompt: Type.Optional(
		Type.String({
			description:
				"If set, feed the fetched page content to the active pi model with this prompt and return its answer instead of the raw page. The model's token cost is added to this session.",
		})
	),
	full_content: Type.Optional(
		Type.Boolean({ description: "Return full page content. Defaults to true when `prompt` is set, else false." })
	),
	model: Type.Optional(
		Type.String({ description: "Summarizer model as `provider/id`. Defaults to the active model." })
	),
});

type WebSearchArgs = Static<typeof WebSearchParams>;
type WebFetchArgs = Static<typeof WebFetchParams>;

const createParallelProvider = (): Provider => ({
	id: PARALLEL_PROVIDER,
	name: "Parallel",
	auth: {
		apiKey: {
			name: "Parallel API key",
			login: parallelProviderLogin,
			resolve: async (input) => {
				const stored = input.credential?.key;
				if (stored) {
					return { auth: { apiKey: stored }, source: "stored credential" };
				}
				const env = await input.ctx.env(API_KEY_ENV_VAR);
				return env ? { auth: { apiKey: env }, source: API_KEY_ENV_VAR } : undefined;
			},
		},
	},
	getModels: () => [],
	stream: () => {
		throw new Error("The Parallel provider does not serve models.");
	},
	streamSimple: () => {
		throw new Error("The Parallel provider does not serve models.");
	},
});

export default function parallelExtension(pi: ExtensionAPI): void {
	let config: ParallelConfig = loadConfig();
	const sessionId = randomUUID();

	const limits = (): QuotaLimits => ({
		softLimitQueries: config.softLimitQueries,
		hardLimitQueries: config.hardLimitQueries,
		hardLimitUsd: config.hardLimitUsd,
	});
	const quota = (): QuotaStore => new QuotaStore(quotaPath(), limits());

	const snapshot = (ledger: QuotaLedger): QuotaSnapshot => ({
		month: ledger.month,
		queries: ledger.queries,
		usd: ledger.usd,
		softLimitQueries: config.softLimitQueries,
		hardLimitQueries: config.hardLimitQueries,
		hardLimitUsd: config.hardLimitUsd,
	});

	const refreshStatus = (ctx: ExtensionContext): void => {
		try {
			const ledger = quota().read();
			const suffix = ledger.queries > config.softLimitQueries ? " ⚠" : "";
			ctx.ui.setStatus(
				STATUS_KEY,
				`parallel ${ledger.queries.toLocaleString()}/${config.hardLimitQueries.toLocaleString()} · ${formatUsd(ledger.usd)}${suffix}`
			);
		} catch {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
	};

	const softWarning = (ledger: QuotaLedger): string | undefined =>
		ledger.queries > config.softLimitQueries
			? `${SOFT_WARNING_PREFIX}: ${ledger.queries.toLocaleString()}/${config.softLimitQueries.toLocaleString()} requests (hard ceiling ${config.hardLimitQueries.toLocaleString()}).`
			: undefined;

	const withWarning = (text: string, ledger: QuotaLedger): string => {
		const warning = softWarning(ledger);
		return warning ? `${warning}\n\n${text}` : text;
	};

	const reserve = (cost: QuotaCost) => {
		try {
			return quota().reserve(cost);
		} catch (error) {
			if (error instanceof QuotaExceededError) {
				throw new Error(
					`${error.reason} Adjust the limits in ${configPath()} or wait for the month to roll over.`
				);
			}
			throw error;
		}
	};

	const getApiKey = async (ctx: ExtensionToolContext): Promise<string> => {
		const key = await ctx.modelRegistry.getApiKeyForProvider(PARALLEL_PROVIDER);
		if (key) {
			return key;
		}
		throw new Error(
			`Parallel is not authenticated. Run /parallel-login, or set ${API_KEY_ENV_VAR}.`
		);
	};

	const describeApiError = (error: unknown): Error => {
		if (isParallelAuthError(error)) {
			return new Error(
				"Parallel rejected the stored credential (401/403). Run /parallel-login to sign in again."
			);
		}
		return error instanceof Error ? error : new Error(String(error));
	};

	const clientModel = (ctx: ExtensionContext): string | undefined =>
		ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;

	pi.registerProvider(createParallelProvider());

	pi.registerCommand("parallel-login", {
		description: "Sign in to Parallel (OAuth + PKCE) and store the API key in pi's auth store",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			if (readParallelApiKey()) {
				const replace = await ctx.ui.confirm(
					"Parallel is already connected",
					"Sign in again and replace the stored API key?"
				);
				if (!replace) {
					return;
				}
			}
			ctx.ui.notify("Opening Parallel sign-in in your browser…", "info");
			const key = await loginWithParallel({
				openBrowser: true,
				onAuthUrl: (url, opened) => {
					if (!opened) {
						ctx.ui.notify(`Open this URL to sign in to Parallel:\n${url}`, "info");
					}
				},
				promptForCallback: async (authUrl, signal) => {
					const pasted = await ctx.ui.input(
						"Paste the Parallel callback URL if the browser cannot reach this machine",
						authUrl,
						{ signal }
					);
					return pasted?.trim() || undefined;
				},
			});
			storeParallelApiKey(key);
			const visible = await ctx.modelRegistry.getApiKeyForProvider(PARALLEL_PROVIDER);
			ctx.ui.notify(
				visible
					? "Parallel connected. API key stored in pi's auth store."
					: "Parallel key stored, but pi has not loaded it yet. Try /reload if tools report missing auth.",
				visible ? "info" : "warning"
			);
			refreshStatus(ctx);
		},
	});

	pi.registerCommand("parallel-logout", {
		description: "Remove the stored Parallel API key",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			clearParallelApiKey();
			ctx.ui.notify("Removed the stored Parallel API key.", "info");
			refreshStatus(ctx);
		},
	});

	pi.registerCommand("parallel", {
		description: "Show Parallel authentication and monthly quota status",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			config = loadConfig();
			const key = await ctx.modelRegistry.getApiKeyForProvider(PARALLEL_PROVIDER);
			const ledger = quota().read();
			const authLine = key
				? liveEnvKey()
					? `Auth: connected via ${API_KEY_ENV_VAR}`
					: "Auth: connected (stored key)"
				: "Auth: not connected — run /parallel-login";
			const lines = [
				authLine,
				`Month: ${ledger.month}`,
				`Queries: ${ledger.queries.toLocaleString()} / ${config.hardLimitQueries.toLocaleString()} (soft ${config.softLimitQueries.toLocaleString()})`,
				`Search requests: ${ledger.searchRequests.toLocaleString()} · Extract URLs: ${ledger.extractUrls.toLocaleString()}`,
				`Estimated spend: ${formatUsd(ledger.usd)} / ${formatUsd(config.hardLimitUsd)}`,
				`Config: ${configPath()}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
			refreshStatus(ctx);
		},
	});

	pi.registerCommand("parallel-reset-quota", {
		description: "Clear this month's locally tracked Parallel usage (use only if the ledger drifted)",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			const confirmed = await ctx.ui.confirm(
				"Reset Parallel quota ledger?",
				"This only clears the local counter; it does not change your Parallel account usage."
			);
			if (!confirmed) {
				return;
			}
			quota().reset();
			ctx.ui.notify("Parallel quota ledger reset.", "info");
			refreshStatus(ctx);
		},
	});

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the live web with Parallel and return ranked results with LLM-optimized excerpts. Use for current information or source discovery, then use web_fetch to read a result in depth. Counts against the local Parallel monthly request budget.",
		promptSnippet: "Search the web with Parallel (ranked URLs + excerpts)",
		promptGuidelines: [
			"Prefer web_search when an answer depends on current or external information; then web_fetch the most relevant URLs.",
			"Keep search_queries to 2-3 focused keyword queries of 3-6 words each.",
		],
		parameters: WebSearchParams,
		annotations: { readOnlyHint: true, openWorldHint: true },
		namespace: { name: "parallel", description: "Parallel web search and extraction" },
		execute: async (_toolCallId, params: WebSearchArgs, signal, _onUpdate, ctx) => {
			const apiKey = await getApiKey(ctx);
			const mode = params.mode ?? config.searchMode;
			const maxResults = params.max_results ?? config.defaultMaxResults;
			const cost = estimateSearchCost(mode, maxResults);
			const decision = reserve(cost);

			let response: ParallelSearchResponse;
			try {
				response = await searchParallel(
					config.apiBaseUrl,
					apiKey,
					{
						objective: params.objective,
						search_queries: params.search_queries,
						mode,
						session_id: sessionId,
						client_model: clientModel(ctx),
						advanced_settings: { max_results: maxResults },
					},
					signal
				);
			} catch (error) {
				quota().refund(cost);
				throw describeApiError(error);
			}

			refreshStatus(ctx);
			const ledger = quota().read();
			return {
				content: [{ type: "text", text: withWarning(truncateForModel(formatSearchResults(response)), ledger) }],
				details: {
					searchId: response.search_id,
					resultCount: response.results.length,
					mode,
					quota: snapshot(ledger),
				} satisfies WebSearchDetails,
			};
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch page content from specific URLs with Parallel. Pass `prompt` to have the active pi model read the pages and answer it (instead of dumping raw page text into context); the model's token cost is added to the session. Counts against the local Parallel monthly request budget (one per URL).",
		promptSnippet: "Fetch specific URLs with Parallel, optionally summarized by a pi model",
		promptGuidelines: [
			"Use web_fetch when you already have a URL, or when you want a model to read and summarize pages: pass the question as `prompt`.",
			"Prefer `prompt` over full raw content to keep context small and costs predictable.",
		],
		parameters: WebFetchParams,
		annotations: { readOnlyHint: true, openWorldHint: true },
		namespace: { name: "parallel", description: "Parallel web search and extraction" },
		execute: async (_toolCallId, params: WebFetchArgs, signal, onUpdate, ctx) => {
			const apiKey = await getApiKey(ctx);
			const prompt = params.prompt?.trim();
			const shouldSummarize = Boolean(prompt && prompt.length > 0);
			const fullContent = params.full_content ?? shouldSummarize;
			const cost = estimateExtractCost(params.urls.length);
			const decision = reserve(cost);

			onUpdate?.({
				content: [{ type: "text", text: `Fetching ${params.urls.length} URL(s) with Parallel…` }],
				details: { phase: "fetching", urls: params.urls.length } satisfies WebFetchDetails,
			});

			let response: ParallelExtractResponse;
			try {
				response = await extractParallel(
					config.apiBaseUrl,
					apiKey,
					{
						urls: params.urls,
						objective: params.objective,
						search_queries: params.search_queries,
						session_id: sessionId,
						client_model: clientModel(ctx),
						advanced_settings: { full_content: fullContent },
					},
					signal
				);
			} catch (error) {
				quota().refund(cost);
				throw describeApiError(error);
			}

			refreshStatus(ctx);
			const pages = pageContents(response, fullContent);

			if (shouldSummarize && prompt) {
				onUpdate?.({
					content: [
						{ type: "text", text: `Summarizing ${pages.length} page(s) with the active model…` },
					],
					details: { phase: "summarizing", urls: params.urls.length } satisfies WebFetchDetails,
				});
				const summary = await summarizePages({
					ctx,
					prompt,
					pages,
					model: resolveSummaryModel(ctx, params.model),
					maxChars: config.maxSummaryChars,
				});
				const ledger = quota().read();
				return {
					content: [
						{
							type: "text",
							text: withWarning(`${summary.text}\n\n— summarized with ${summary.modelLabel}`, ledger),
						},
					],
					details: {
						phase: "done",
						extractId: response.extract_id,
						urls: params.urls.length,
						summarized: true,
						summaryModel: summary.modelLabel,
						quota: snapshot(ledger),
					} satisfies WebFetchDetails,
					usage: summary.usage,
				};
			}

			const ledger = quota().read();
			return {
				content: [{ type: "text", text: withWarning(truncateForModel(formatExtractResults(response)), ledger) }],
				details: {
					phase: "done",
					extractId: response.extract_id,
					urls: params.urls.length,
					summarized: false,
					quota: snapshot(ledger),
				} satisfies WebFetchDetails,
			};
		},
	});

	pi.on("session_start", (_event, ctx) => {
		config = loadConfig();
		refreshStatus(ctx);
	});

	pi.on("session_shutdown", () => {
		// No long-lived resources are held; the quota ledger is written per request.
	});
}

const liveEnvKey = (): boolean => {
	const envKey = process.env[API_KEY_ENV_VAR];
	return typeof envKey === "string" && envKey.trim().length > 0 && !readParallelApiKey();
};
