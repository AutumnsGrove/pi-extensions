/**
 * Pricing model for the Parallel Search and Extract APIs, used to estimate
 * month-to-date spend before a request is issued.
 *
 * See https://docs.parallel.ai/getting-started/pricing
 *   - Search:  $1 / 1,000 `turbo` or `fast` requests, $5 / 1,000 `basic`/`advanced`
 *              (10 results included; $1 / 1,000 additional results)
 *   - Extract: $1 / 1,000 URLs
 */
import type { QuotaCost } from "./quota.ts";

export const SEARCH_MODES = ["turbo", "fast", "basic", "advanced"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];

const SEARCH_REQUEST_USD: Record<SearchMode, number> = {
	turbo: 0.001,
	fast: 0.001,
	basic: 0.005,
	advanced: 0.005,
};

export const INCLUDED_SEARCH_RESULTS = 10;
export const EXTRA_SEARCH_RESULT_USD = 0.001;
export const EXTRACT_URL_USD = 0.001;

export const estimateSearchCost = (mode: SearchMode, maxResults = INCLUDED_SEARCH_RESULTS): QuotaCost => {
	const extraResults = Math.max(0, maxResults - INCLUDED_SEARCH_RESULTS);
	return {
		queries: 1,
		usd: SEARCH_REQUEST_USD[mode] + extraResults * EXTRA_SEARCH_RESULT_USD,
		searchRequests: 1,
	};
};

export const estimateExtractCost = (urlCount: number): QuotaCost => ({
	queries: urlCount,
	usd: urlCount * EXTRACT_URL_USD,
	extractUrls: urlCount,
});

/** Format a USD amount without ever collapsing a real cost to `$0.00`. */
export const formatUsd = (value: number): string => {
	if (!Number.isFinite(value) || value <= 0) {
		return "$0";
	}
	if (value < 0.01) {
		return `$${value.toFixed(4)}`;
	}
	return `$${value.toFixed(2)}`;
};
