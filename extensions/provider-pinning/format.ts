import type { Percentiles } from "./endpoints.ts";

/**
 * Prices from OpenRouter are strings in dollars per token. We render them in
 * dollars per million tokens, which is how humans compare them.
 */
export const pricePerMillion = (
	perToken: string | number | null | undefined
): number | undefined => {
	if (perToken === null || perToken === undefined) {
		return undefined;
	}
	if (typeof perToken === "string" && perToken.trim() === "") {
		return undefined;
	}
	const value = typeof perToken === "number" ? perToken : Number(perToken);
	if (!Number.isFinite(value) || value < 0) {
		return undefined;
	}
	return value * 1_000_000;
};

export const formatPrice = (
	perToken: string | number | null | undefined
): string => {
	const value = pricePerMillion(perToken);
	if (value === undefined) {
		return "—";
	}
	if (value === 0) {
		return "free";
	}
	const digits = value < 0.01 ? 4 : value < 1 ? 3 : 2;
	return `$${value.toFixed(digits)}`;
};

/**
 * `pricing.discount` is a fraction off the list price (0.3 = 30% off). Some
 * endpoints could report a percentage instead, so values above 1 are treated
 * as already-percent.
 */
export const formatDiscount = (discount: number | null | undefined): string => {
	if (
		typeof discount !== "number" ||
		!Number.isFinite(discount) ||
		discount <= 0
	) {
		return "—";
	}
	const percent = discount <= 1 ? discount * 100 : discount;
	const rounded = percent % 1 === 0 ? percent.toFixed(0) : percent.toFixed(1);
	return `${rounded}%`;
};

export const formatCount = (value: number | null | undefined): string => {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return "—";
	}
	if (value >= 1_000_000) {
		const millions = value / 1_000_000;
		return `${millions.toFixed(millions >= 10 ? 0 : 1)}M`;
	}
	if (value >= 1_000) {
		return `${Math.round(value / 1_000)}K`;
	}
	return String(Math.round(value));
};

export const formatLatency = (stats: Percentiles | undefined): string =>
	typeof stats?.p50 === "number" ? `${Math.round(stats.p50)}ms` : "—";

export const formatThroughput = (stats: Percentiles | undefined): string =>
	typeof stats?.p50 === "number" ? `${Math.round(stats.p50)}` : "—";

export const formatUptime = (value: number | null | undefined): string =>
	typeof value === "number" && Number.isFinite(value) ? value.toFixed(1) : "—";

export const formatPercentiles = (
	stats: Percentiles | undefined,
	unit: string
): string => {
	if (!stats) {
		return "—";
	}
	const parts = (["p50", "p75", "p90", "p99"] as const)
		.filter((key) => typeof stats[key] === "number")
		.map((key) => `${key} ${Math.round(stats[key] as number)}${unit}`);
	return parts.length > 0 ? parts.join("  ") : "—";
};
