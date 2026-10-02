import { describe, expect, it, vi } from "vitest";
import {
	endpointUrl,
	fetchEndpointCatalog,
	modelIdVariants,
	parseEndpointCatalog,
	parsePercentiles,
} from "./endpoints.ts";

const payload = (endpoints: unknown[]): unknown => ({
	data: {
		id: "deepseek/deepseek-v4.1-flash",
		endpoints,
	},
});

const morph = {
	name: "Morph | deepseek/deepseek-v4.1-flash",
	provider_name: "Morph",
	tag: "morph/fp8",
	quantization: "fp8",
	context_length: 1_048_576,
	max_completion_tokens: 943_718,
	pricing: {
		prompt: "0.000000021",
		completion: "0.000000383",
		input_cache_read: "0.000000008",
		input_cache_write: null,
		discount: 0.3,
	},
	supported_parameters: ["reasoning", "tools", "reasoning_effort"],
	supports_implicit_caching: false,
	uptime_last_30m: 99.87,
	latency_last_30m: { p50: 636, p75: 745, p90: 1022, p99: 3045 },
	throughput_last_30m: { p50: 73, p75: 92, p90: 120, p99: 167 },
};

describe("parsePercentiles", () => {
	it("accepts objects and bare numbers", () => {
		expect(parsePercentiles({ p50: 10, p90: 30 })).toEqual({ p50: 10, p90: 30 });
		expect(parsePercentiles(12)).toEqual({ p50: 12 });
		expect(parsePercentiles(null)).toBeUndefined();
		expect(parsePercentiles({})).toBeUndefined();
	});
});

describe("parseEndpointCatalog", () => {
	it("parses endpoints and keeps the requested model id", () => {
		const catalog = parseEndpointCatalog(
			"deepseek/deepseek-v4.1-flash",
			payload([morph])
		);
		expect(catalog.modelId).toBe("deepseek/deepseek-v4.1-flash");
		expect(catalog.endpoints).toHaveLength(1);
		const endpoint = catalog.endpoints[0];
		expect(endpoint).toMatchObject({
			providerName: "Morph",
			tag: "morph/fp8",
			quantization: "fp8",
			supportsImplicitCaching: false,
			contextLength: 1_048_576,
		});
		expect(endpoint?.pricing.cacheRead).toBe("0.000000008");
		expect(endpoint?.pricing.cacheWrite).toBeUndefined();
		expect(endpoint?.pricing.discount).toBe(0.3);
		expect(endpoint?.latency?.p50).toBe(636);
		expect(endpoint?.throughput?.p50).toBe(73);
	});

	it("drops entries without a tag or provider name", () => {
		const catalog = parseEndpointCatalog("m", payload([morph, {}, { tag: "x" }]));
		expect(catalog.endpoints).toHaveLength(1);
	});

	it("tolerates a missing endpoints array", () => {
		expect(parseEndpointCatalog("m", { data: {} }).endpoints).toEqual([]);
		expect(parseEndpointCatalog("m", null).endpoints).toEqual([]);
	});
});

describe("modelIdVariants", () => {
	it("expands aliases and variants", () => {
		expect(modelIdVariants("~deepseek/deepseek-flash-latest")).toEqual([
			"~deepseek/deepseek-flash-latest",
			"deepseek/deepseek-flash-latest",
		]);
		expect(modelIdVariants("deepseek/deepseek-v4.1-flash:free")).toEqual([
			"deepseek/deepseek-v4.1-flash:free",
			"deepseek/deepseek-v4.1-flash",
		]);
		expect(modelIdVariants("deepseek/deepseek-v4.1-flash")).toEqual([
			"deepseek/deepseek-v4.1-flash",
		]);
	});
});

describe("endpointUrl", () => {
	it("trims the base and encodes path segments", () => {
		expect(endpointUrl("https://openrouter.ai/api/v1/", "deepseek/deepseek-v4.1-flash")).toBe(
			"https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints"
		);
		expect(endpointUrl("https://x", "deepseek/a:free")).toContain("a%3Afree");
	});
});

describe("fetchEndpointCatalog", () => {
	it("retries the next variant after a 404", async () => {
		const fetchImpl = vi.fn(async (url: string | URL) => {
			if (String(url).includes("~")) {
				return new Response("not found", { status: 404 });
			}
			return new Response(JSON.stringify(payload([morph])), { status: 200 });
		}) as unknown as typeof fetch;

		const catalog = await fetchEndpointCatalog("~deepseek/deepseek-flash-latest", {
			baseUrl: "https://openrouter.ai/api/v1",
			apiKey: "test",
			fetchImpl,
		});
		expect(catalog.endpoints).toHaveLength(1);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("sends the API key so latency and throughput populate", async () => {
		let authorization: string | undefined;
		const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
			authorization = new Headers(init?.headers).get("authorization") ?? undefined;
			return new Response(JSON.stringify(payload([morph])), { status: 200 });
		}) as unknown as typeof fetch;

		await fetchEndpointCatalog("deepseek/deepseek-v4.1-flash", {
			baseUrl: "https://openrouter.ai/api/v1",
			apiKey: "secret",
			fetchImpl,
		});
		expect(authorization).toBe("Bearer secret");
	});

	it("throws a useful error when nothing works", async () => {
		const fetchImpl = (async () =>
			new Response("nope", { status: 500 })) as unknown as typeof fetch;
		await expect(
			fetchEndpointCatalog("deepseek/deepseek-v4.1-flash", {
				baseUrl: "https://openrouter.ai/api/v1",
				fetchImpl,
			})
		).rejects.toThrow(/status 500/);
	});
});
