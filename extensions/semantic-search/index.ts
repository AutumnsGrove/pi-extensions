/**
 * pi integration for semantic-search.
 *
 * Replaces lumen's MCP server + Claude hooks with native pi primitives:
 *  - `registerTool` for `semantic_search` and `index_status`
 *  - `promptGuidelines` so the model prefers semantic search over grep/read
 *  - `session_start` kicks off background indexing and shows status
 *  - `/semsearch` for status and forced re-index
 */

import { isAbsolute, join, relative, sep } from "node:path";
import { Type, type Static } from "typebox";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { SemanticSearchManager, type SearchManager } from "./src/manager.ts";
import { writeModelConfig } from "./src/config.ts";
import { listKnownModels, modelDimensions } from "./src/embed/registry.ts";
import { isRootUnindexable } from "./src/index/ignore.ts";
import type { ProgressFunc } from "./src/index/indexer.ts";
import { MAX_SEARCH_LIMIT } from "./src/search/service.ts";
import { describeSearchError, formatIndexStatus } from "./src/search/format.ts";

const STATUS_KEY = "semsearch";

const SearchParams = Type.Object({
	query: Type.String({ description: "Natural language search query." }),
	path: Type.Optional(
		Type.String({
			description:
				"Absolute path to search in. Defaults to the session working directory; a subdirectory filters results to that subtree.",
		})
	),
	cwd: Type.Optional(
		Type.String({ description: "Project root. Defaults to the session working directory." })
	),
	limit: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: MAX_SEARCH_LIMIT,
			description: `Max results to return (default 8, max ${MAX_SEARCH_LIMIT}).`,
		})
	),
	min_score: Type.Optional(
		Type.Number({
			minimum: -1,
			maximum: 1,
			description: "Minimum cosine similarity (-1 to 1). Use -1 to return all results.",
		})
	),
	summary: Type.Optional(
		Type.Boolean({
			description: "Return only path, symbol, kind, line range, and score — no code.",
		})
	),
	max_lines: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 2000,
			description: "Truncate each code snippet to this many lines.",
		})
	),
});
type SearchArgs = Static<typeof SearchParams>;

const StatusParams = Type.Object({
	path: Type.Optional(Type.String()),
	cwd: Type.Optional(Type.String()),
});
type StatusArgs = Static<typeof StatusParams>;

function projectRoot(ctx: ExtensionContext, args: { cwd?: string }): string {
	return args.cwd ?? ctx.cwd;
}

function pathPrefixFor(projectDir: string, path: string | undefined): string {
	if (!path) {
		return "";
	}
	// Resolve relative to the project root, then normalise to the store's
	// posix-relative form. Handles "./src", "src/", absolute paths, and
	// platform separators; anything outside the root means "no restriction".
	const abs = isAbsolute(path) ? path : join(projectDir, path);
	const rel = relative(projectDir, abs);
	if (rel === "" || rel === ".") {
		return "";
	}
	if (rel === ".." || rel.startsWith(`..${sep}`)) {
		return "";
	}
	return rel.split(sep).join("/");
}

/**
 * Reason the given root must not be indexed, or undefined when it is fine.
 * Refuses filesystem/system roots, the user's home directory, and roots with a
 * `.pi-searchignore` catch-all so a stray session cannot walk the whole disk.
 */
function rootRefusal(projectDir: string): string | undefined {
	const { unindexable, reason } = isRootUnindexable(projectDir);
	return unindexable ? reason : undefined;
}

export function createSemanticSearchExtension(
	createManager: () => SearchManager = () => new SemanticSearchManager()
): (pi: ExtensionAPI) => void {
	return function semanticSearch(pi: ExtensionAPI): void {
		let manager = createManager();

		const resetManager = async (): Promise<void> => {
			await manager.close();
			manager = createManager();
		};

		// The only ctx whose UI we may touch. Background indexing outlives the
		// session that started it, and pi invalidates a captured ctx after a
		// reload or session replacement. Tracking the live ctx keeps a late
		// completion from writing status to a dead one.
		let activeCtx: ExtensionContext | undefined;

		// Join the shared extension status line. pi can only place widgets above
		// or below the editor, never below the footer, so a separate bottom line
		// would require owning the footer (which extension-divider already does).
		const setIndexStatus = (ctx: ExtensionContext, text: string | undefined): void => {
			if (ctx !== activeCtx) {
				return;
			}
			try {
				ctx.ui.setStatus(STATUS_KEY, text);
			} catch {
				// The runtime can invalidate the ctx between the identity check and
				// the call. A missed status update is never worth crashing pi over.
			}
		};

		pi.on("session_start", (_event, ctx) => {
			activeCtx = ctx;
			const refusal = rootRefusal(ctx.cwd);
			if (refusal) {
				setIndexStatus(ctx, `semsearch: off (${refusal})`);
				return;
			}
			void (async () => {
				try {
					setIndexStatus(ctx, "semsearch: indexing…");
					const { store, indexer } = await manager.ensure(ctx.cwd);
					const fresh = await indexer.ensureFresh();
					const { totalChunks } = store.stats();
					setIndexStatus(
						ctx,
						`semsearch: ${totalChunks} chunks${fresh.reindexed ? " (updated)" : ""}`
					);
				} catch {
					setIndexStatus(ctx, "semsearch: unavailable");
				}
			})();
		});

		pi.on("session_shutdown", async () => {
			activeCtx = undefined;
			await manager.close();
		});

		pi.registerTool({
			name: "semantic_search",
			label: "Semantic Code Search",
			description: `Search the indexed codebase by meaning instead of by literal string.

Use semantic_search FIRST for code discovery:
- understanding how a system or feature works
- finding where functionality is implemented
- discovering what calls what, or how components connect
- locating code related to a concept or domain term

Use grep, find, or read only when you already know the exact literal string (a specific symbol name, import path, or error message). The index auto-refreshes before each search. If a search returns nothing, retry with min_score=-1 before changing the query.`,
			promptSnippet: "Search indexed code by meaning",
			promptGuidelines: [
				"Use semantic_search first for code discovery: understanding how something works, finding where it is implemented, or how components connect.",
				"Use grep, find, or read for exact literal strings you already know, such as a specific symbol, import path, or error message.",
			],
			parameters: SearchParams,
			annotations: { readOnlyHint: true },
			async execute(_id, params: SearchArgs, signal, onUpdate, ctx) {
				const projectDir = projectRoot(ctx, params);
				const refusal = rootRefusal(projectDir);
				if (refusal) {
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: `Semantic search is disabled for this root (${refusal}). Use grep, find, or read instead.`,
							},
						],
						details: { resultCount: 0, reindexed: false, results: [] },
					};
				}
				// Stream indexing progress so a first search on a large repo does not
				// look hung. Throttled because the indexer reports per file.
				let lastProgressAt = 0;
				let lastProgressText = "";
				const onProgress: ProgressFunc | undefined = onUpdate
					? (_current, _total, message) => {
							const now = Date.now();
							if (
								message === lastProgressText &&
								now - lastProgressAt < 500
							) {
								return;
							}
							lastProgressAt = now;
							lastProgressText = message;
							void onUpdate({
								content: [{ type: "text", text: message }],
								details: undefined,
							});
						}
					: undefined;
				let search: Awaited<ReturnType<SearchManager["search"]>>;
				try {
					search = await manager.search(
						projectDir,
						{
							query: params.query,
							limit: params.limit,
							minScore: params.min_score,
							summary: params.summary,
							maxLines: params.max_lines,
							pathPrefix: pathPrefixFor(projectDir, params.path),
						},
						signal,
						onProgress
					);
				} catch (error) {
					// Ollama down, model not pulled, aborted, or the store failed. The
					// model is told to reach for this tool first, so answer with an
					// actionable error instead of a raw stack trace.
					return {
						isError: true,
						content: [
							{ type: "text", text: describeSearchError(error, manager.config) },
						],
						details: { resultCount: 0, reindexed: false, results: [] },
					};
				}
				const { output, text } = search;
				return {
					content: [{ type: "text", text }],
					details: {
						resultCount: output.results.length,
						reindexed: output.reindexed,
						results: output.results.map((r) => ({
							filePath: r.filePath,
							symbol: r.symbol,
							kind: r.kind,
							startLine: r.startLine,
							endLine: r.endLine,
							score: r.score,
						})),
					},
				};
			},
		});

		pi.registerTool({
			name: "index_status",
			label: "Code Index Status",
			description:
				"Report the semantic index status for a project: file and chunk counts, embedding model, and freshness.",
			parameters: StatusParams,
			exposure: "deferred",
			annotations: { readOnlyHint: true },
			async execute(_id, params: StatusArgs, _signal, _onUpdate, ctx) {
				const projectDir = projectRoot(ctx, params);
				const refusal = rootRefusal(projectDir);
				if (refusal) {
					return {
						content: [
							{ type: "text", text: `Index disabled for this root: ${refusal}.` },
						],
						details: { stale: false },
					};
				}
				const { store, indexer } = await manager.ensure(projectDir);
				const status = indexer.status();
				const stale = !(await indexer.isFresh());
				const text = formatIndexStatus({
					projectPath: projectDir,
					totalFiles: store.stats().totalFiles,
					totalChunks: status.totalChunks,
					embeddingModel: status.embeddingModel,
					lastIndexedAt: status.lastIndexedAt,
					stale,
					lastIndexError: status.lastIndexError,
					configError: manager.configError,
				});
				return { content: [{ type: "text", text }], details: { stale, ...status } };
			},
		});

		pi.registerCommand("semsearch", {
			description: "Semantic search index: status | reindex | model [name] [dims]",
			handler: async (args, ctx) => {
				const parts = args.trim().split(/\s+/).filter(Boolean);
				const sub = parts[0] ?? "";

				if (sub === "model") {
					const name = parts[1];
					if (!name) {
						ctx.ui.notify(
							`Current model: ${manager.config.model} (${manager.config.dimensions} dims)\n` +
								`Known models: ${listKnownModels().join(", ")}\n` +
								`Usage: /semsearch model <name> [dimensions]`,
							"info"
						);
						return;
					}
					// Validate explicit dimensions before touching the config file. A
					// NaN/0/negative value used to be persisted (JSON.stringify(NaN) ->
					// null) and then bricked loadConfig on every later start.
					let providedDims: number | undefined;
					const rawDims = parts[2];
					if (rawDims !== undefined) {
						providedDims = Number.parseInt(rawDims, 10);
						if (!Number.isInteger(providedDims) || providedDims <= 0) {
							ctx.ui.notify(
								`Invalid dimensions "${rawDims}"; expected a positive integer.`,
								"warning"
							);
							return;
						}
					}
					const dims = providedDims ?? modelDimensions(name);
					if (dims === undefined) {
						ctx.ui.notify(
							`Unknown model "${name}"; provide its dimensions: /semsearch model ${name} <dims>`,
							"warning"
						);
						return;
					}
					let path: string;
					try {
						path = writeModelConfig(name, providedDims);
					} catch (error) {
						ctx.ui.notify(
							`Could not save the model config: ${
								error instanceof Error ? error.message : String(error)
							}`,
							"error"
						);
						return;
					}
					await resetManager();
					const envOverride = process.env.PI_SEMSEARCH_MODEL;
					const envNote =
						envOverride && envOverride !== name
							? ` Note: PI_SEMSEARCH_MODEL=${envOverride} overrides the saved value.`
							: "";
					const fallbackNote = manager.configError
						? ` Warning: config unreadable (${manager.configError}); using ${manager.config.model}.`
						: "";
					ctx.ui.notify(
						`Embedding model set to ${name} (${dims} dims); saved to ${path}. ` +
							`A new index is built on the next search.${envNote}${fallbackNote}`,
						"info"
					);
					return;
				}

				const refusal = rootRefusal(ctx.cwd);
				if (refusal) {
					ctx.ui.notify(
						`Semantic search is disabled for this root (${refusal}).`,
						"warning"
					);
					return;
				}

				const { store, indexer } = await manager.ensure(ctx.cwd);
				if (sub === "reindex") {
					ctx.ui.notify("Re-indexing…", "info");
					const stats = await indexer.index(true, undefined, ctx.signal);
					setIndexStatus(ctx, `semsearch: ${store.stats().totalChunks} chunks`);
					ctx.ui.notify(
						`Re-indexed ${stats.indexedFiles} files (${stats.chunksCreated} chunks).`,
						"info"
					);
					return;
				}
				const status = indexer.status();
				ctx.ui.notify(
					`Index: ${status.totalFiles} files, ${status.totalChunks} chunks, model ${
						status.embeddingModel ?? "unknown"
					}, last indexed ${status.lastIndexedAt ?? "never"}.`,
					"info"
				);
			},
		});

		// Opt-in: block grep/find to force semantic search. Off by default so
		// exact-string lookups still work.
		if (process.env.PI_SEMSEARCH_BLOCK_GREP === "1") {
			pi.on("tool_call", (event) => {
				if (event.toolName === "grep" || event.toolName === "find") {
					return {
						block: true,
						reason:
							"Use semantic_search for code discovery; grep/find are for exact literal strings you already know.",
					};
				}
				return undefined;
			});
		}
	};
}

export default createSemanticSearchExtension();
