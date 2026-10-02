import type { SearchMode } from "./cost.ts";

export interface ParallelUsageItem {
	name: string;
	count: number;
}

export interface ParallelSearchResult {
	url: string;
	title?: string | null;
	publish_date?: string | null;
	excerpts: string[];
}

export interface ParallelExtractResult extends ParallelSearchResult {
	full_content?: string | null;
}

export interface ParallelSearchResponse {
	search_id: string;
	results: ParallelSearchResult[];
	warnings?: unknown;
	usage?: ParallelUsageItem[] | null;
	session_id?: string;
}

export interface ParallelExtractResponse {
	extract_id: string;
	results: ParallelExtractResult[];
	errors?: unknown[];
	warnings?: unknown;
	usage?: ParallelUsageItem[] | null;
	session_id?: string;
}

export interface ParallelSearchBody {
	objective?: string;
	search_queries: string[];
	mode?: SearchMode;
	max_chars_total?: number;
	session_id?: string;
	client_model?: string;
	advanced_settings?: { max_results?: number };
}

export interface ParallelExtractBody {
	urls: string[];
	objective?: string;
	search_queries?: string[];
	max_chars_total?: number;
	session_id?: string;
	client_model?: string;
	advanced_settings?: { full_content?: boolean };
}

export class ParallelApiError extends Error {
	readonly status?: number;

	constructor(message: string, status?: number) {
		super(message);
		this.name = "ParallelApiError";
		this.status = status;
	}
}

export const isParallelAuthError = (error: unknown): boolean =>
	error instanceof ParallelApiError && (error.status === 401 || error.status === 403);

const REQUEST_TIMEOUT_MS = 120_000;
export const TOOL_CALLING_PACKAGE = "pi-extensions/parallel";

const describeError = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

const extractErrorMessage = (status: number, statusText: string, body: string): string => {
	const trimmed = body.trim();
	if (trimmed.length === 0) {
		return `${status} ${statusText}`.trim();
	}
	try {
		const parsed = JSON.parse(trimmed) as { error?: unknown; detail?: unknown; message?: unknown };
		const candidate = parsed.error ?? parsed.detail ?? parsed.message;
		if (typeof candidate === "string" && candidate.length > 0) {
			return candidate;
		}
		if (candidate !== undefined) {
			return JSON.stringify(candidate);
		}
	} catch {
		// Not JSON; fall through to the raw body.
	}
	return trimmed;
};

const postJson = async <T>(
	baseUrl: string,
	path: string,
	apiKey: string,
	body: unknown,
	signal: AbortSignal | undefined
): Promise<T> => {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

	let response: Response;
	try {
		response = await fetch(`${baseUrl}${path}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": apiKey,
				"X-Tool-Calling-Package": TOOL_CALLING_PACKAGE,
			},
			body: JSON.stringify(body),
			signal: requestSignal,
		});
	} catch (error) {
		if (signal?.aborted) {
			throw new ParallelApiError(`Parallel ${path} request was cancelled.`);
		}
		if (timeout.aborted) {
			throw new ParallelApiError(
				`Parallel ${path} request timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s.`
			);
		}
		throw new ParallelApiError(`Parallel ${path} request failed: ${describeError(error)}`);
	}

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new ParallelApiError(
			`Parallel ${path} failed (${response.status}): ${extractErrorMessage(response.status, response.statusText, body)}`,
			response.status
		);
	}

	try {
		return (await response.json()) as T;
	} catch (error) {
		throw new ParallelApiError(`Parallel ${path} returned invalid JSON: ${describeError(error)}`);
	}
};

export const searchParallel = (
	baseUrl: string,
	apiKey: string,
	body: ParallelSearchBody,
	signal?: AbortSignal
): Promise<ParallelSearchResponse> => postJson<ParallelSearchResponse>(baseUrl, "/v1/search", apiKey, body, signal);

export const extractParallel = (
	baseUrl: string,
	apiKey: string,
	body: ParallelExtractBody,
	signal?: AbortSignal
): Promise<ParallelExtractResponse> => postJson<ParallelExtractResponse>(baseUrl, "/v1/extract", apiKey, body, signal);
