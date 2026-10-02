import { describe, expect, it } from "vitest";
import {
	applyPin,
	extractServedProvider,
	headerLookup,
	pinForModel,
} from "./routing.ts";
import type { ProviderPin } from "./config.ts";

const pin = (overrides: Partial<ProviderPin> = {}): ProviderPin => ({
	tag: "deepseek",
	providerName: "DeepSeek",
	allowFallbacks: false,
	quantizations: [],
	updatedAt: "2026-10-02T00:00:00.000Z",
	...overrides,
});

describe("applyPin", () => {
	it("sets only and disables fallbacks", () => {
		const result = applyPin(
			{ model: "deepseek/deepseek-v4.1-flash" },
			pin()
		) as Record<string, unknown>;
		expect(result.provider).toEqual({ only: ["deepseek"], allow_fallbacks: false });
	});

	it("keeps existing provider preferences and drops sort", () => {
		const result = applyPin(
			{ model: "m", provider: { zdr: true, sort: "throughput" } },
			pin()
		) as Record<string, unknown>;
		expect(result.provider).toEqual({
			zdr: true,
			only: ["deepseek"],
			allow_fallbacks: false,
		});
	});

	it("adds a quantization constraint when known", () => {
		const result = applyPin({ model: "m" }, pin({ quantizations: ["fp8"] })) as Record<
			string,
			unknown
		>;
		expect(result.provider).toMatchObject({ quantizations: ["fp8"] });
	});

	it("does not mutate the input payload", () => {
		const payload = { model: "m", provider: { zdr: true } };
		applyPin(payload, pin());
		expect(payload.provider).toEqual({ zdr: true });
	});

	it("returns the payload untouched without a pin or for non-objects", () => {
		const payload = { model: "m" };
		expect(applyPin(payload, undefined)).toBe(payload);
		expect(applyPin(null, pin())).toBeNull();
		expect(applyPin("nope", pin())).toBe("nope");
	});
});

describe("pinForModel", () => {
	it("matches the exact model id", () => {
		const pins = { "deepseek/deepseek-v4.1-flash": pin() };
		expect(pinForModel({ model: "deepseek/deepseek-v4.1-flash" }, pins)?.tag).toBe(
			"deepseek"
		);
		expect(pinForModel({ model: "other/model" }, pins)).toBeUndefined();
		expect(pinForModel(null, pins)).toBeUndefined();
	});
});

describe("extractServedProvider", () => {
	it("reads the provider from an OpenRouter stream chunk", () => {
		expect(extractServedProvider({ provider: "DeepSeek" })).toBe("DeepSeek");
		expect(extractServedProvider({ provider_name: "Morph" })).toBe("Morph");
		expect(extractServedProvider({ provider: "  " })).toBeUndefined();
		expect(extractServedProvider(null)).toBeUndefined();
		expect(extractServedProvider({ choices: [] })).toBeUndefined();
	});
});

describe("headerLookup", () => {
	it("is case-insensitive", () => {
		expect(headerLookup({ "X-Provider-Name": "DeepSeek" }, "x-provider-name")).toBe(
			"DeepSeek"
		);
		expect(headerLookup({}, "x-provider-name")).toBeUndefined();
	});
});
