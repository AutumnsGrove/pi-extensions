/** Percentile object OpenRouter returns for latency and throughput stats. */
export interface Percentiles {
	p50?: number;
	p75?: number;
	p90?: number;
	p99?: number;
}

export interface EndpointPricing {
	/** Dollars per prompt token, as a string. */
	prompt?: string;
	/** Dollars per completion token, as a string. */
	completion?: string;
	/** Dollars per cached (read) token. */
	cacheRead?: string;
	/** Dollars per cache-write token. */
	cacheWrite?: string;
	/** Fraction off the list price (0.3 = 30% off). */
	discount?: number;
}

export interface ProviderEndpoint {
	name: string;
	providerName: string;
	tag: string;
	quantization?: string;
	contextLength?: number;
	maxCompletionTokens?: number;
	pricing: EndpointPricing;
	supportedParameters: string[];
	supportsImplicitCaching: boolean;
	uptime?: number;
	latency?: Percentiles;
	throughput?: Percentiles;
}

export interface EndpointCatalog {
	/** The model id the caller asked about (pin key). */
	modelId: string;
	/** Epoch ms when this catalog was fetched. */
	fetchedAt: number;
	endpoints: ProviderEndpoint[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const asNumber = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

const asString = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const asPrice = (value: unknown): string | undefined => {
	if (typeof value === "string" && value.trim().length > 0) {
		return value.trim();
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return String(value);
	}
	return undefined;
};

export const parsePercentiles = (value: unknown): Percentiles | undefined => {
	if (typeof value === "number" && Number.isFinite(value)) {
		return { p50: value };
	}
	if (!isRecord(value)) {
		return undefined;
	}
	const stats: Percentiles = {};
	for (const key of ["p50", "p75", "p90", "p99"] as const) {
		const number = asNumber(value[key]);
		if (number !== undefined) {
			stats[key] = number;
		}
	}
	return Object.keys(stats).length > 0 ? stats : undefined;
};

export const parseEndpoint = (
	raw: unknown
): ProviderEndpoint | undefined => {
	if (!isRecord(raw)) {
		return undefined;
	}
	const tag = asString(raw.tag);
	const providerName = asString(raw.provider_name);
	if (!tag || !providerName) {
		return undefined;
	}
	const pricingRaw = isRecord(raw.pricing) ? raw.pricing : {};
	const supportedParameters = Array.isArray(raw.supported_parameters)
		? raw.supported_parameters.filter(
				(item): item is string => typeof item === "string"
			)
		: [];
	return {
		name: asString(raw.name) ?? `${providerName} | ${tag}`,
		providerName,
		tag,
		quantization: asString(raw.quantization),
		contextLength: asNumber(raw.context_length),
		maxCompletionTokens: asNumber(raw.max_completion_tokens),
		pricing: {
			prompt: asPrice(pricingRaw.prompt),
			completion: asPrice(pricingRaw.completion),
			cacheRead: asPrice(pricingRaw.input_cache_read),
			cacheWrite: asPrice(pricingRaw.input_cache_write),
			discount: asNumber(pricingRaw.discount),
		},
		supportedParameters,
		supportsImplicitCaching: raw.supports_implicit_caching === true,
		uptime: asNumber(raw.uptime_last_30m),
		latency: parsePercentiles(raw.latency_last_30m),
		throughput: parsePercentiles(raw.throughput_last_30m),
	};
};

export const parseEndpointCatalog = (
	modelId: string,
	payload: unknown
): EndpointCatalog => {
	const root =
		isRecord(payload) && isRecord(payload.data) ? payload.data : payload;
	const list = isRecord(root) && Array.isArray(root.endpoints)
		? root.endpoints
		: [];
	const endpoints = list
		.map(parseEndpoint)
		.filter((endpoint): endpoint is ProviderEndpoint => endpoint !== undefined);
	return { modelId, fetchedAt: Date.now(), endpoints };
};

/**
 * OpenRouter model ids may carry a `~` vendor alias or a `:variant` suffix that
 * the endpoints route does not accept. Try the canonical forms in order.
 */
export const modelIdVariants = (modelId: string): string[] => {
	const variants: string[] = [];
	const push = (value: string): void => {
		if (value.length > 0 && !variants.includes(value)) {
			variants.push(value);
		}
	};
	const withoutAlias = modelId.replace(/^~/, "");
	push(modelId);
	push(withoutAlias);
	const colon = withoutAlias.indexOf(":");
	if (colon > 0) {
		push(withoutAlias.slice(0, colon));
	}
	return variants;
};

export const endpointUrl = (baseUrl: string, modelId: string): string =>
	`${baseUrl.replace(/\/+$/, "")}/models/${modelId
		.split("/")
		.map(encodeURIComponent)
		.join("/")}/endpoints`;

export interface FetchEndpointsOptions {
	baseUrl: string;
	apiKey?: string;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
}

/**
 * Latency and throughput percentiles only come back when the request is
 * authenticated, so always send the key when we have one.
 */
export const fetchEndpointCatalog = async (
	modelId: string,
	options: FetchEndpointsOptions
): Promise<EndpointCatalog> => {
	const doFetch = options.fetchImpl ?? fetch;
	const headers: Record<string, string> = { Accept: "application/json" };
	if (options.apiKey) {
		headers.Authorization = `Bearer ${options.apiKey}`;
	}
	let lastError: unknown;
	for (const variant of modelIdVariants(modelId)) {
		const response = await doFetch(endpointUrl(options.baseUrl, variant), {
			headers,
			signal: options.signal,
		});
		if (response.status === 404) {
			lastError = new Error(`No endpoints route for ${variant}`);
			continue;
		}
		if (!response.ok) {
			throw new Error(
				`OpenRouter endpoints request failed with status ${response.status}`
			);
		}
		const catalog = parseEndpointCatalog(modelId, await response.json());
		if (catalog.endpoints.length === 0) {
			lastError = new Error(`No endpoints returned for ${variant}`);
			continue;
		}
		return catalog;
	}
	throw lastError instanceof Error
		? lastError
		: new Error("No provider endpoints available");
};
