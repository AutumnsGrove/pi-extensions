/**
 * pi integration for semantic-search.
 *
 * Replaces lumen's MCP server + Claude hooks with native pi primitives:
 *  - `registerTool` for `semantic_search` and `index_status`
 *  - `promptGuidelines` so the model prefers semantic search over grep/read
 *  - `session_start` kicks off background indexing and shows status
 *  - `/semsearch` for status and forced re-index
 */

import { isAbsolute, relative } from "node:path";
import { Type, type Static } from "typebox";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { SemanticSearchManager, type SearchManager } from "./src/manager.ts";
import { writeModelConfig } from "./src/config.ts";
import { listKnownModels, modelDimensions } from "./src/embed/registry.ts";
import { formatIndexStatus } from "./src/search/format.ts";

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
		Type.Integer({ minimum: 1, description: "Max results to return (default 8)." })
	),
	min_score: Type.Optional(
		Type.Number({
			description: "Minimum score threshold (-1 to 1). Use -1 to return all results.",
		})
	),
	summary: Type.Optional(
		Type.Boolean({
			description: "Return only path, symbol, kind, line range, and score — no code.",
		})
	),
	max_lines: Type.Optional(
		Type.Integer({ minimum: 1, description: "Truncate each code snippet to this many lines." })
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
	if (!path || path === projectDir) {
		return "";
	}
	if (isAbsolute(path)) {
		const rel = relative(projectDir, path);
		return rel.startsWith("..") ? "" : rel;
	}
	return path;
}

export function createSemanticSearchExtension(
	createManager: () => SearchManager = () => new SemanticSearchManager()
): (pi: ExtensionAPI) => void {
	return function semanticSearch(pi: ExtensionAPI): void {
		let manager = createManager();

		const resetManager = (): void => {
			manager.close();
			manager = createManager();
		};

		pi.on("session_start", (_event, ctx) => {
			void (async () => {
				try {
					ctx.ui.setStatus(STATUS_KEY, "semsearch: indexing…");
					const { store, indexer } = await manager.ensure(ctx.cwd);
					const fresh = await indexer.ensureFresh();
					const { totalChunks } = store.stats();
					ctx.ui.setStatus(
						STATUS_KEY,
						`semsearch: ${totalChunks} chunks${fresh.reindexed ? " (updated)" : ""}`
					);
				} catch {
					ctx.ui.setStatus(STATUS_KEY, undefined);
				}
			})();
		});

		pi.on("session_shutdown", () => manager.close());

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
			async execute(_id, params: SearchArgs, _signal, _onUpdate, ctx) {
				const projectDir = projectRoot(ctx, params);
				const { output, text } = await manager.search(projectDir, {
					query: params.query,
					limit: params.limit,
					minScore: params.min_score,
					summary: params.summary,
					maxLines: params.max_lines,
					pathPrefix: pathPrefixFor(projectDir, params.path),
				});
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
					const dimsArg = parts[2] ? Number.parseInt(parts[2], 10) : undefined;
					const dims = dimsArg ?? modelDimensions(name);
					if (dims === undefined) {
						ctx.ui.notify(
							`Unknown model "${name}"; provide its dimensions: /semsearch model ${name} <dims>`,
							"warning"
						);
						return;
					}
					const path = writeModelConfig(name, dimsArg);
					resetManager();
					ctx.ui.notify(
						`Embedding model set to ${name} (${dims} dims); saved to ${path}. ` +
							"A new index is built on the next search.",
						"info"
					);
					return;
				}

				const { store, indexer } = await manager.ensure(ctx.cwd);
				if (sub === "reindex") {
					ctx.ui.notify("Re-indexing…", "info");
					const stats = await indexer.index(true);
					ctx.ui.setStatus(
						STATUS_KEY,
						`semsearch: ${store.stats().totalChunks} chunks`
					);
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
