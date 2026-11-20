/**
 * GitHub reads, through `gh`, with ETag caching.
 *
 * No token handling: a subscription reuses the user's `gh` login, which is the
 * same choice `pi-review` makes. Everything goes through an injected `Exec`
 * (`pi.exec` at runtime, a fake in tests) so the parser, the retry policy, and
 * the fixture tests share one path.
 *
 * Why REST and not GraphQL: `If-None-Match` on REST costs nothing on a 304, and
 * an idle PR is six cached requests per poll. GraphQL would bill points on
 * every poll. The spike confirmed `gh api --include` exposes the headers
 * cleanly, including a 304 with an empty body.
 */

import { spawn } from "node:child_process";
import type { ErrorKind } from "./diff.ts";
import { buildSnapshot, type CheckEntry, type Snapshot } from "./snapshot.ts";
import { prKey, type PrRef } from "./ref.ts";

export interface ExecResultLike {
	stdout: string;
	stderr?: string;
	code?: number;
}

export interface Exec {
	(command: string, args: string[], options?: { cwd?: string; timeout?: number }): Promise<ExecResultLike>;
}

export class GhApiError extends Error {
	readonly kind: ErrorKind;
	readonly status: number | undefined;
	readonly retryAfterMs: number | undefined;
	readonly path: string;

	constructor(kind: ErrorKind, message: string, path: string, status?: number, retryAfterMs?: number) {
		super(message);
		this.name = "GhApiError";
		this.kind = kind;
		this.status = status;
		this.retryAfterMs = retryAfterMs;
		this.path = path;
	}
}

export interface GhResponse {
	status: number;
	headers: Map<string, string>;
	body: unknown;
	text: string;
	etag?: string;
	/** True for a 304: `body` is the cached payload. */
	notModified: boolean;
}

interface CacheEntry {
	etag: string;
	body: unknown;
	text: string;
	status: number;
}

const STATUS_LINE = /^HTTP\/[\d.]+ (\d{3})/;

/** Split `gh api --include` output into status, headers, and body. */
export function parseIncludedResponse(raw: string): {
	status: number;
	headers: Map<string, string>;
	bodyText: string;
} {
	const text = raw.replace(/\r\n/g, "\n");
	const firstBreak = text.indexOf("\n\n");
	const head = firstBreak === -1 ? text : text.slice(0, firstBreak);
	const bodyText = firstBreak === -1 ? "" : text.slice(firstBreak + 2);
	const lines = head.split("\n");
	const statusMatch = STATUS_LINE.exec(lines[0] ?? "");
	const status = statusMatch?.[1] ? Number(statusMatch[1]) : 0;
	const headers = new Map<string, string>();
	for (const line of lines.slice(1)) {
		const index = line.indexOf(":");
		if (index <= 0) continue;
		headers.set(line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim());
	}
	return { status, headers, bodyText };
}

/** `x-ratelimit-reset` is seconds since the epoch; `retry-after` is seconds. */
export function retryDelayMs(headers: Map<string, string>, now = Date.now()): number | undefined {
	const retryAfter = Number(headers.get("retry-after"));
	if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
	if (headers.get("x-ratelimit-remaining") === "0") {
		const reset = Number(headers.get("x-ratelimit-reset"));
		if (Number.isFinite(reset) && reset > 0) return Math.max(1000, reset * 1000 - now);
	}
	return undefined;
}

function classify(status: number, message: string, headers: Map<string, string>): ErrorKind {
	if (status === 401) return "auth";
	if (status === 404) return "not-found";
	if (status === 403 || status === 429) {
		if (headers.get("x-ratelimit-remaining") === "0" || headers.has("retry-after")) return "rate-limit";
		return /rate limit|secondary/i.test(message) ? "rate-limit" : "auth";
	}
	if (status >= 500) return "server";
	if (status === 0) return "network";
	return "unknown";
}

/** Header value that survives a case change in GitHub's edge. */
const header = (headers: Map<string, string>, name: string): string | undefined => headers.get(name);

const linkPage = (headers: Map<string, string>, rel: string): number | undefined => {
	const link = header(headers, "link");
	if (!link) return undefined;
	for (const part of link.split(",")) {
		const match = /<([^>]+)>;\s*rel="([^"]+)"/.exec(part.trim());
		if (match?.[2] !== rel || !match[1]) continue;
		const page = /[?&]page=(\d+)/.exec(match[1]);
		if (page?.[1]) return Number(page[1]);
	}
	return undefined;
};

export interface GhApiOptions {
	exec: Exec;
	cwd: string;
	timeoutMs?: number;
	/** Injected for tests. */
	now?: () => number;
}

/**
 * One cached API client per poller. The cache lives as long as the poller, so a
 * `/reload` keeps the ETags (the poller object is the same one).
 */
export class GhApi {
	private readonly cache = new Map<string, CacheEntry>();
	/** Non-HTTP state that must live as long as the client (pagination cursors). */
	private readonly meta = new Map<string, unknown>();
	private readonly options: GhApiOptions;

	constructor(options: GhApiOptions) {
		this.options = options;
	}

	/** Forget one resource (or all) after a payload change we caused. */
	invalidate(key?: string): void {
		if (key === undefined) this.cache.clear();
		else this.cache.delete(key);
	}

	getMeta<T>(key: string): T | undefined {
		return this.meta.get(key) as T | undefined;
	}

	setMeta(key: string, value: unknown): void {
		this.meta.set(key, value);
	}

	async get(
		path: string,
		options: { etagKey?: string; accept?: string; timeoutMs?: number } = {}
	): Promise<GhResponse> {
		const key = options.etagKey;
		const cached = key ? this.cache.get(key) : undefined;
		const args = ["api", "--include", "-H", `Accept: ${options.accept ?? "application/vnd.github+json"}`];
		if (cached) args.push("-H", `If-None-Match: ${cached.etag}`);
		args.push(path);

		let result: ExecResultLike;
		try {
			result = await this.options.exec("gh", args, {
				cwd: this.options.cwd,
				timeout: options.timeoutMs ?? this.options.timeoutMs ?? 30_000,
			});
		} catch (error) {
			// `gh` exits 1 on a 304 and on every 4xx. `pi.exec` reports that as a
			// result, but a runner that throws on a non-zero exit still carries the
			// headers on the error; use them rather than turning a cached poll into
			// a network failure.
			const carried = error as { stdout?: unknown; stderr?: unknown; code?: unknown };
			if (typeof carried.stdout === "string" && carried.stdout.includes("HTTP/")) {
				result = {
					stdout: carried.stdout,
					...(typeof carried.stderr === "string" ? { stderr: carried.stderr } : {}),
					...(typeof carried.code === "number" ? { code: carried.code } : {}),
				};
			} else {
				throw new GhApiError(
					"network",
					error instanceof Error ? error.message : String(error),
					path
				);
			}
		}

		const parsed = parseIncludedResponse(result.stdout ?? "");
		if (parsed.status === 0) {
			const message = (result.stderr ?? "").trim() || `gh exited ${result.code ?? "?"} with no response`;
			throw new GhApiError(classify(0, message, parsed.headers), message, path);
		}

		if (parsed.status === 304) {
			if (!cached) {
				// Nothing to serve from cache: ask again without the conditional.
				if (key) this.cache.delete(key);
				throw new GhApiError("unknown", "304 without a cached body", path, 304);
			}
			return {
				status: 304,
				headers: parsed.headers,
				body: cached.body,
				text: cached.text,
				etag: cached.etag,
				notModified: true,
			};
		}

		let body: unknown = undefined;
		if (parsed.bodyText.trim()) {
			try {
				body = JSON.parse(parsed.bodyText);
			} catch {
				body = undefined;
			}
		}

		if (parsed.status >= 200 && parsed.status < 300) {
			const etag = header(parsed.headers, "etag");
			if (key && etag) this.cache.set(key, { etag, body, text: parsed.bodyText, status: parsed.status });
			return { status: parsed.status, headers: parsed.headers, body, text: parsed.bodyText, etag, notModified: false };
		}

		const message =
			(typeof body === "object" && body !== null && typeof (body as { message?: unknown }).message === "string"
				? (body as { message: string }).message
				: parsed.bodyText.trim()) || `HTTP ${parsed.status}`;
		throw new GhApiError(
			classify(parsed.status, message, parsed.headers),
			message,
			path,
			parsed.status,
			retryDelayMs(parsed.headers, this.options.now?.() ?? Date.now())
		);
	}
}

/**
 * The six resources one tick needs.
 *
 * Issue comments are listed ascending only — `sort` and `direction` are ignored
 * on `/issues/{n}/comments` — so they are read with a `since` watermark, and a
 * seed read pages to the newest before the cursor is built. Reviews are
 * ascending too, with no ordering parameter at all; `fetchReviews` keeps a page
 * cursor for them.
 */
export function snapshotPaths(
	ref: PrRef,
	headSha: string,
	options: { since?: string } = {}
): {
	pull: string;
	checkRuns: string;
	statuses: string;
	issueComments: string;
	reviewComments: string;
	reviews: string;
} {
	const base = `repos/${ref.owner}/${ref.repo}`;
	const since = options.since ? `&since=${encodeURIComponent(options.since)}` : "";
	return {
		pull: `${base}/pulls/${ref.number}`,
		checkRuns: `${base}/commits/${headSha}/check-runs?per_page=100&filter=latest`,
		statuses: `${base}/commits/${headSha}/status?per_page=100`,
		issueComments: `${base}/issues/${ref.number}/comments?per_page=100${since}`,
		reviewComments: `${base}/pulls/${ref.number}/comments?per_page=100&sort=created&direction=desc`,
		reviews: `${base}/pulls/${ref.number}/reviews?per_page=100`,
	};
}

export interface FetchSnapshotOptions {
	/** ISO timestamp for the issue-comments `since` parameter. */
	since?: string;
}

/** Read the PR first (the head SHA drives the check URLs), then the rest. */
export async function fetchSnapshot(
	api: GhApi,
	ref: PrRef,
	options: FetchSnapshotOptions = {}
): Promise<Snapshot> {
	const pullPath = `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
	const pullResponse = await api.get(pullPath, { etagKey: `pull:${ref.owner}/${ref.repo}#${ref.number}` });
	const pull = pullResponse.body as { head?: { sha?: unknown } } | undefined;
	const headSha = typeof pull?.head?.sha === "string" ? pull.head.sha : undefined;
	if (!headSha) throw new GhApiError("unknown", "the pull request payload had no head SHA", pullPath, pullResponse.status);

	const paths = snapshotPaths(ref, headSha, options);
	const [checkRuns, statuses, issueComments, reviewComments, reviews] = await Promise.all([
		api.get(paths.checkRuns, { etagKey: `checks:${headSha}` }),
		api.get(paths.statuses, { etagKey: `statuses:${headSha}` }),
		fetchIssueComments(api, ref, options.since),
		api.get(paths.reviewComments, { etagKey: `review-comments:${ref.number}` }),
		fetchReviews(api, ref),
	]);

	const snapshot = buildSnapshot({
		pull: pullResponse.body,
		checkRuns: checkRuns.body,
		statuses: statuses.body,
		issueComments,
		reviewComments: reviewComments.body,
		reviews: reviews.list,
	});
	if (!snapshot) throw new GhApiError("unknown", "could not read the pull request payload", pullPath);
	return snapshot;
}

const MAX_PAGES = 5;
const PAGE_SIZE = 100;

const items = (body: unknown): unknown[] => (Array.isArray(body) ? body : []);

/**
 * Issue comments, oldest page first by default.
 *
 * A seed (no `since`) pages to the **newest** page: the cursor must end at the
 * newest comment, or the first poll treats every comment the seed did not cover
 * as news. A poll (`since` set) starts at the oldest comment updated since the
 * watermark and follows `next` pages, so a burst wider than one page is not
 * truncated.
 */
async function fetchIssueComments(api: GhApi, ref: PrRef, since: string | undefined): Promise<unknown> {
	const base = `repos/${ref.owner}/${ref.repo}/issues/${ref.number}/comments?per_page=${PAGE_SIZE}`;
	if (!since) {
		// No conditional read here: a 304 carries no `Link`, so a warm cache would
		// silently reseed from the oldest page. A seed is one request.
		const first = await api.get(base);
		const last = linkPage(first.headers, "last");
		if (last === undefined || last <= 1) return first.body;
		const tail = await api.get(`${base}&page=${last}`, {
			etagKey: `issue-comments:${ref.number}:seed:page:${last}`,
		});
		return tail.body;
	}

	const url = `${base}&since=${encodeURIComponent(since)}`;
	const first = await api.get(url, { etagKey: `issue-comments:${ref.number}:${since}` });
	let collected = items(first.body);
	let next = linkPage(first.headers, "next");
	let pages = 1;
	while (next !== undefined && pages < MAX_PAGES) {
		const page = await api.get(`${url}&page=${next}`);
		collected = collected.concat(items(page.body));
		pages += 1;
		next = linkPage(page.headers, "next");
	}
	return collected;
}

interface ReviewPageState {
	page: number;
	full: boolean;
}

/**
 * Reviews, newest page only.
 *
 * Reviews page ascending with no ordering parameter, so page 1 stays identical
 * as reviews accumulate — an ETag on it would 304 forever while the newest
 * reviews moved to page 2. Instead the client remembers the last page it saw
 * and reads that page: a 304 there is safe, because a page with room left
 * changes whenever a review is appended. A page that was full is read without
 * `If-None-Match`, since the review that spills onto the next page would leave
 * it byte-identical.
 */
async function fetchReviews(api: GhApi, ref: PrRef): Promise<{ list: unknown }> {
	const base = `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews?per_page=${PAGE_SIZE}`;
	const key = `reviews:${prKey(ref)}`;
	const known = api.getMeta<ReviewPageState>(key);
	let page = known?.page ?? 1;
	let conditional = !known?.full;
	const collected: unknown[] = [];
	let lastPage = page;
	let lastWasFull = false;

	for (let reads = 0; reads < MAX_PAGES; reads += 1) {
		const response = await api.get(`${base}&page=${page}`, conditional ? { etagKey: `${key}:p${page}` } : {});
		conditional = false;
		const pageItems = items(response.body);

		if (pageItems.length === 0) {
			if (collected.length === 0 && page > 1) {
				// The remembered page is past the end (deletes moved the boundary).
				page = 1;
				lastPage = 1;
				lastWasFull = false;
				continue;
			}
			// A page with room after a full one: the previous page is the last.
			break;
		}

		// Keep every page read, not just the last: the review that fills a page can
		// arrive in the same read as the review that spills onto the next one.
		collected.push(...pageItems);
		lastPage = page;
		lastWasFull = pageItems.length >= PAGE_SIZE;
		if (!lastWasFull) break;
		page += 1;
	}

	api.setMeta(key, { page: lastPage, full: lastWasFull });
	return { list: collected };
}

/**
 * Branch-protection required checks, when the token can read them. Returns
 * undefined when it cannot, which makes "settled" mean every check on the head.
 */
export async function requiredChecks(api: GhApi, ref: PrRef, baseRef: string): Promise<string[] | undefined> {
	const base = `repos/${ref.owner}/${ref.repo}`;
	try {
		const response = await api.get(`${base}/branches/${encodeURIComponent(baseRef)}/protection/required_status_checks`);
		return contextsFromProtection(response.body);
	} catch (error) {
		if (!(error instanceof GhApiError) || (error.status !== 404 && error.status !== 403)) throw error;
	}
	try {
		const response = await api.get(`${base}/rules/branches/${encodeURIComponent(baseRef)}`);
		return contextsFromRules(response.body);
	} catch (error) {
		if (error instanceof GhApiError && (error.status === 404 || error.status === 403)) return undefined;
		throw error;
	}
}

export function contextsFromProtection(body: unknown): string[] | undefined {
	if (typeof body !== "object" || body === null) return undefined;
	const record = body as { contexts?: unknown; checks?: unknown };
	const contexts = new Set<string>();
	if (Array.isArray(record.contexts)) {
		for (const context of record.contexts) if (typeof context === "string") contexts.add(context);
	}
	if (Array.isArray(record.checks)) {
		for (const check of record.checks) {
			const context = (check as { context?: unknown } | null)?.context;
			if (typeof context === "string") contexts.add(context);
		}
	}
	return contexts.size > 0 ? [...contexts] : undefined;
}

export function contextsFromRules(body: unknown): string[] | undefined {
	if (!Array.isArray(body)) return undefined;
	const contexts = new Set<string>();
	for (const rule of body) {
		const record = rule as { type?: unknown; parameters?: unknown } | null;
		if (record?.type !== "required_status_checks") continue;
		const parameters = record.parameters as { required_status_checks?: unknown } | undefined;
		if (!Array.isArray(parameters?.required_status_checks)) continue;
		for (const check of parameters.required_status_checks) {
			const context = (check as { context?: unknown } | null)?.context;
			if (typeof context === "string") contexts.add(context);
		}
	}
	return contexts.size > 0 ? [...contexts] : undefined;
}

/** Last `maxBytes` of a command's stdout. Job logs are megabytes; pi.exec caps from the head. */
export function runTail(
	command: string,
	args: string[],
	options: { cwd: string; maxBytes?: number; timeoutMs?: number }
): Promise<{ text: string; code: number; stderr: string }> {
	const maxBytes = options.maxBytes ?? 256 * 1024;
	const timeoutMs = options.timeoutMs ?? 30_000;
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let stderr = "";
		let settled = false;
		const finish = (code: number): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			const buffer = Buffer.concat(chunks);
			resolve({ text: buffer.toString("utf8"), code, stderr });
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, args, { cwd: options.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			resolve({ text: "", code: 127, stderr: error instanceof Error ? error.message : String(error) });
			return;
		}
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(124);
		}, timeoutMs);
		timer.unref?.();
		child.stdout?.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
			size += chunk.length;
			while (size > maxBytes && chunks.length > 0) {
				const first = chunks[0];
				if (!first) break;
				if (size - first.length >= maxBytes) {
					chunks.shift();
					size -= first.length;
				} else {
					const drop = size - maxBytes;
					chunks[0] = first.subarray(drop);
					size -= drop;
				}
			}
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString("utf8")).slice(-8_192);
		});
		child.on("error", (error) => {
			stderr = error.message;
			finish(127);
		});
		child.on("close", (code) => finish(code ?? 0));
	});
}

const FAILURE_LOG_BYTES = 64 * 1024;

/** Best-effort tail of a failed Actions job. Undefined when the log is gone. */
export async function fetchJobLog(
	ref: PrRef,
	jobId: string,
	options: { cwd: string; timeoutMs?: number }
): Promise<string | undefined> {
	const result = await runTail(
		"gh",
		["api", `repos/${ref.owner}/${ref.repo}/actions/jobs/${jobId}/logs`],
		{ cwd: options.cwd, maxBytes: FAILURE_LOG_BYTES, timeoutMs: options.timeoutMs ?? 30_000 }
	);
	if (result.code !== 0 || !result.text.trim()) return undefined;
	return result.text;
}

