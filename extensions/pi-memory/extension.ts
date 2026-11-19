/**
 * pi-memory: automatic, file-based project memory.
 *
 * Three moving parts, in order of visibility:
 *
 *  1. The index (`MEMORY.md`) is a small, stable section in the system prompt.
 *     Bodies are not.
 *  2. `memory_save` / `memory_read` / `memory_search` / `memory_forget` let the
 *     model use the store while it works. Saving is immediate on a correction.
 *  3. After every third settled run, one model call reads only the messages
 *     since a cursor and returns JSON writes. Validation, secret screening, and
 *     dedupe happen here before anything reaches disk.
 *
 * Recall is deterministic and free: at most five bodies whose names,
 * descriptions, or text overlap the prompt, within a 4 KB budget, never the
 * same file twice in a session.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionToolContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { isBlocked } from "../_shared/blockers.ts";
import { stringEnum } from "../_shared/schema.ts";
import { loadConfig, type MemoryConfig } from "./config.ts";
import { loadEmbedder, type MemoryEmbedder } from "./embed.ts";
import {
	buildDreamPrompt,
	buildExtractPrompt,
	collectSlice,
	parseMemoryOps,
	validateOps,
	type SliceEntry,
} from "./extract.ts";
import {
	emptyExtractionEval,
	evaluateRecall,
	evalSummary,
	formatEvalReport,
	readSessionFiles,
	sessionSlice,
	addExtractionSample,
} from "./eval.ts";
import { applyImport, formatImportPlan, formatImportResult, planImport } from "./import.ts";
import {
	agentDir,
	claudeSourceDirFor,
	displayPath,
	scopePath,
	storeDirFor,
} from "./paths.ts";
import {
	RECALL_CUSTOM_TYPE,
	formatManifest,
	formatMemories,
	recallOptions,
	selectRecall,
} from "./recall.ts";
import {
	keywordSearch,
	mergeSearchHits,
	formatSearchResults,
	semanticSearch,
	type SearchMode,
	type SearchResult,
	type VectorCache,
} from "./search.ts";
import { MemoryStore, MemoryWriteError, readJsonFile, writeAtomic } from "./store.ts";
import { formatAge, normalizeName } from "./text.ts";
import { filenameFor, isoNow } from "./frontmatter.ts";
import { MEMORY_TYPES, type MemoryCandidate, type MemoryType } from "./types.ts";

const TOOL_PREFIX = "memory";
const COMMAND = "memory";
export const SAVE_NOTICE_TYPE = "pi-memory-saved";
export const INDEX_POINTER_TYPE = "pi-memory-index";

const EXTRACT_MAX_TOKENS = 1_500;
const DREAM_MAX_TOKENS = 5_000;
const EXTRACT_TIMEOUT_MS = 90_000;
const DREAM_TIMEOUT_MS = 180_000;
const EXTRACT_SLICE_MESSAGES = 60;
const EXTRACT_SLICE_CHARS = 24_000;

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

interface SavedNotice {
	saved: Array<{ name: string; file: string; type: MemoryType }>;
	rejected: number;
	cost: number;
	model: string;
	indexLines: number;
}

interface SessionState {
	id: string;
	cwd: string;
	scopeRoot: string;
	store: MemoryStore;
	config: MemoryConfig;
	configFile: string;
	configError?: string;
	stateError?: string;
	/** Rendered index frozen for this session's prompt section. */
	indexText: string;
	indexTruncated: boolean;
	indexTotal: number;
	/** Files whose bodies have been surfaced or read this session. */
	surfaced: Set<string>;
	paused: boolean;
	/** True once the main agent saved in the current run. */
	wroteThisRun: boolean;
	/** Settled runs since the last extraction attempt. */
	turnsSinceExtract: number;
	extracting: boolean;
	dreaming: boolean;
	dreamTimer?: ReturnType<typeof setTimeout>;
	vectors: VectorCache;
	vectorsLoaded: boolean;
	embedder?: MemoryEmbedder;
	semanticError?: string;
	recallCount: number;
	recallBytes: number;
	lastRecallBytes: number;
}

const sessions = new Map<string, SessionState>();
let startupConfig: ReturnType<typeof loadConfig> | undefined;

function configForStartup(): ReturnType<typeof loadConfig> {
	startupConfig ??= loadConfig();
	return startupConfig;
}

function sessionId(ctx: { sessionManager: { getSessionId(): string } }): string {
	return ctx.sessionManager.getSessionId() ?? "ephemeral";
}

function isChildSession(ctx: ExtensionContext): boolean {
	return !!ctx.sessionManager.getHeader()?.parentSession;
}

/**
 * Vector caches live in pi's agent directory, not the store. A shared Claude
 * Code store should stay exactly Claude's files, and a cache is not memory.
 */
function vectorPath(store: MemoryStore): string {
	const name = createHash("sha1").update(store.dir).digest("hex").slice(0, 16);
	return join(agentDir(), "memory-vectors", `${name}.json`);
}

function loadVectors(state: SessionState): VectorCache {
	if (!state.vectorsLoaded) {
		state.vectors = readJsonFile<VectorCache>(vectorPath(state.store), {});
		state.vectorsLoaded = true;
	}
	return state.vectors;
}

function persistVectors(state: SessionState): void {
	try {
		const path = vectorPath(state.store);
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeAtomic(path, `${JSON.stringify(state.vectors)}\n`);
	} catch (cause) {
		state.semanticError = `Could not write the vector cache: ${
			cause instanceof Error ? cause.message : String(cause)
		}`;
	}
}

function stateFor(ctx: ExtensionContext | ExtensionCommandContext | ExtensionToolContext): SessionState {
	const id = sessionId(ctx);
	const existing = sessions.get(id);
	if (existing) return existing;

	const loaded = loadConfig();
	const store = new MemoryStore(
		storeDirFor({
			cwd: ctx.cwd,
			scope: loaded.config.scope,
			store: loaded.config.store,
		}),
		loaded.config.limits
	);
	let stateError: string | undefined;
	let index = { text: "", lines: 0, bytes: 0, truncated: false, total: 0 };
	try {
		store.ensure();
		index = store.rewriteIndex();
	} catch (cause) {
		stateError = `memory store unavailable: ${cause instanceof Error ? cause.message : String(cause)}`;
	}
	const state: SessionState = {
		id,
		cwd: ctx.cwd,
		scopeRoot: scopePath(ctx.cwd, loaded.config.scope),
		store,
		config: loaded.config,
		configFile: loaded.file,
		configError: loaded.error,
		stateError,
		indexText: index.text,
		indexTruncated: index.truncated,
		indexTotal: index.total,
		surfaced: new Set(),
		paused: false,
		wroteThisRun: false,
		turnsSinceExtract: 0,
		extracting: false,
		dreaming: false,
		vectors: {},
		vectorsLoaded: false,
		recallCount: 0,
		recallBytes: 0,
		lastRecallBytes: 0,
	};
	sessions.set(id, state);
	return state;
}

// ---------------------------------------------------------------------------
// Prompt section
// ---------------------------------------------------------------------------

const MEMORY_RULES = `You have a persistent memory store for this project. It lives outside the repository and survives sessions. \`MEMORY.md\` below is an index of pointers; bodies are not loaded until recall or \`memory_read\`.

Save a memory immediately when the user corrects you, confirms a non-obvious choice, or asks you to remember something. Use \`memory_save\`, and include the why. A confirmation is as worth saving as a correction.

Only four types are allowed:
- user: a durable fact about the person — role, expertise, how they want explanations pitched.
- feedback: a correction or confirmation, with why it matters and when to apply it.
- project: ongoing work, goals, constraints, or the reason behind a decision that code and git cannot tell you.
- reference: where an external system lives (a board, dashboard, or queue).

Never save: code structure, paths, conventions, or architecture (read the tree); git history or authorship (\`git log\`/\`git blame\`); debugging recipes whose fix is in a commit; anything already in AGENTS.md or CLAUDE.md; ephemeral task state; secrets, keys, tokens, or passwords. If asked to save an activity log, ask what was surprising or non-obvious instead, and save that.

Prefer \`memory_search\` over opening every file. Treat memories as claims about when they were written: verify a named file, flag, or command before relying on it.`;

export function buildMemorySection(state: {
	store: MemoryStore;
	indexText: string;
	indexTotal: number;
	indexTruncated: boolean;
}): string {
	const index = state.indexText.trim();
	const listing =
		index === ""
			? "No memories yet. Save the first one when the user corrects or confirms something."
			: index;
	const truncated = state.indexTruncated
		? `\n\n(${state.indexTotal} memories exist; the index is truncated. Use \`memory_search\`.)`
		: "";
	return `${MEMORY_RULES}\n\nStore: ${displayPath(state.store.dir)}\n\nIndex (${state.indexTotal} ${state.indexTotal === 1 ? "memory" : "memories"}):\n${listing}${truncated}`;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const SaveParams = Type.Object({
	name: Type.String({ description: "Short title, 2–80 characters. Re-saving the same title updates it." }),
	description: Type.String({ description: "One line for the index: what this memory is about." }),
	type: stringEnum(MEMORY_TYPES, { description: "The memory's category." }),
	body: Type.String({
		description: "The rule or fact, one or two sentences, in plain Markdown. No secrets.",
	}),
	why: Type.Optional(Type.String({ description: "Why it matters. Expected for feedback and project." })),
	how_to_apply: Type.Optional(
		Type.String({ description: "When and how to apply it. Expected for feedback and project." })
	),
	replace: Type.Optional(
		Type.String({ description: "Existing memory filename to update instead of matching by title." })
	),
});

const ReadParams = Type.Object({
	id: Type.String({ description: "Memory filename (feedback_pnpm.md) or title (Use pnpm)." }),
});

const SearchParams = Type.Object({
	query: Type.String({ description: "What to look for, in natural language." }),
	limit: Type.Optional(
		Type.Integer({ minimum: 1, maximum: 20, description: "Max results (default 8)." })
	),
	mode: Type.Optional(
		stringEnum(["keyword", "semantic", "auto"] as const, {
			description: "keyword (default) needs nothing running; semantic uses the local embedding model; auto adds semantic when keyword is thin.",
		})
	),
});

const ForgetParams = Type.Object({
	id: Type.String({ description: "Memory filename or title to delete. Use only for a memory that is wrong or obsolete." }),
});

type SaveArgs = {
	name: string;
	description: string;
	type: MemoryType;
	body: string;
	why?: string;
	how_to_apply?: string;
	replace?: string;
};

interface SaveDetails {
	summary: string;
	file: string;
	name: string;
	created: boolean;
	total: number;
	indexLines: number;
}

interface SearchDetails {
	query: string;
	count: number;
	mode: SearchMode;
	note?: string;
}

const textResult = (text: string, details?: unknown) => ({
	content: [{ type: "text" as const, text }],
	details,
});

const errorResult = (text: string) => ({
	content: [{ type: "text" as const, text }],
	details: {},
	isError: true,
});

/** The first text block, for a compact tool renderer. */
function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const block = result.content.find((item) => item.type === "text");
	return block?.text ?? "";
}

function renderSaveResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
	options: { expanded: boolean },
	theme: Theme
) {
	if (result.isError) {
		return new Text(theme.fg("error", firstText(result)), 0, 0);
	}
	const details = result.details as SaveDetails | undefined;
	const summary = details?.summary ?? "Saved";
	const line = `${theme.fg("success", "●")} ${theme.fg("text", summary)}`;
	if (!options.expanded) {
		return new Text(`${line} ${theme.fg("dim", "Ctrl+O to expand")}`, 0, 0);
	}
	const parts = [
		line,
		theme.fg("dim", `  ${details?.file ?? ""} · ${details?.total ?? 0} memories in the index`),
	];
	return new Text(parts.join("\n"), 0, 0);
}

function registerTools(pi: ExtensionAPI, enabled: boolean): void {
	const active = enabled;
	pi.registerTool({
		name: `${TOOL_PREFIX}_save`,
		label: "Save memory",
		description:
			"Save a durable project memory: a correction, a confirmed decision, a preference, or the reason behind ongoing work. Re-saving the same title updates the existing memory. Never save secrets or anything already derivable from the repository.",
		promptSnippet: "Save a durable project memory (correction, preference, decision)",
		promptGuidelines: active
			? [
					"Use `memory_save` when corrected, when a non-obvious choice is confirmed, or when asked to remember; include the why.",
					"Never save code structure, git history, debugging recipes, AGENTS.md content, task state, or secrets.",
				]
			: undefined,
		defaultActive: active,
		parameters: SaveParams,
		async execute(_toolCallId, params: SaveArgs, _signal, _onUpdate, ctx) {
			const state = stateFor(ctx);
			if (!state.config.enabled) return errorResult("pi-memory is disabled by configuration.");
			if (state.paused) return errorResult("Memory is paused for this session (`/memory on` to resume).");
			try {
				const candidate: MemoryCandidate = {
					name: params.name,
					description: params.description,
					type: params.type,
					body: params.body,
					why: params.why,
					howToApply: params.how_to_apply,
				};
				const saved = state.store.save(candidate, { replace: params.replace });
				state.wroteThisRun = true;
				refreshIndex(state);
				const memory = state.store.find(saved.file);
				const summary = `${saved.created ? "Saved" : "Updated"} ${memory?.name ?? params.name}`;
				const details: SaveDetails = {
					summary,
					file: saved.file,
					name: memory?.name ?? params.name,
					created: saved.created,
					total: saved.index.total,
					indexLines: saved.index.lines,
				};
				// Keep the prompt section stable for cache reasons and surface the new
				// pointer as a hidden message instead.
				if (saved.created && state.config.inlineSave) {
					const title = (memory?.name ?? params.name).replace(/[[\]]/g, "");
					const pointer = `- [${title}](${saved.file}) — ${memory?.description ?? params.description}`;
					pi.sendMessage({
						customType: INDEX_POINTER_TYPE,
						content: `New memory (already saved; do not save it again):\n${pointer}`,
						display: false,
					});
				}
				const text = `${summary} (${saved.file}). The index has ${saved.index.total} ${
					saved.index.total === 1 ? "memory" : "memories"
				}.`;
				return textResult(text, details);
			} catch (cause) {
				if (cause instanceof MemoryWriteError) return errorResult(cause.message);
				return errorResult(cause instanceof Error ? cause.message : String(cause));
			}
		},
		renderResult: renderSaveResult,
	});

	pi.registerTool({
		name: `${TOOL_PREFIX}_read`,
		label: "Read memory",
		description: "Read the full body of one memory by filename or title.",
		promptSnippet: "Read the full body of a memory",
		defaultActive: active,
		parameters: ReadParams,
		async execute(_toolCallId, params: { id: string }, _signal, _onUpdate, ctx) {
			const state = stateFor(ctx);
			if (!state.config.enabled) return errorResult("pi-memory is disabled by configuration.");
			const memory = state.store.find(params.id);
			if (!memory) return errorResult(`No memory matches "${params.id}".`);
			state.surfaced.add(memory.file);
			return textResult(formatMemories([memory]), { file: memory.file, name: memory.name });
		},
	});

	pi.registerTool({
		name: `${TOOL_PREFIX}_search`,
		label: "Search memory",
		description:
			"Search saved memories. Keyword mode needs nothing running; semantic mode reuses the local embedding model from semantic-search; auto adds semantic hits when keyword results are thin.",
		promptSnippet: "Search saved project memories",
		promptGuidelines: active
			? ["Use `memory_search` before assuming there is no memory on a topic."]
			: undefined,
		defaultActive: active,
		parameters: SearchParams,
		async execute(
			_toolCallId,
			params: { query: string; limit?: number; mode?: SearchMode },
			_signal,
			_onUpdate,
			ctx
		) {
			const state = stateFor(ctx);
			if (!state.config.enabled) return errorResult("pi-memory is disabled by configuration.");
			const limit = params.limit ?? 8;
			const mode = params.mode ?? "keyword";
			const files = state.store.files();
			const result = await searchMemories(state, files, params.query, limit, mode);
			return textResult(formatSearchResults(result), {
				query: params.query,
				count: result.hits.length,
				mode,
				note: result.note,
			} satisfies SearchDetails);
		},
	});

	pi.registerTool({
		name: `${TOOL_PREFIX}_forget`,
		label: "Forget memory",
		description:
			"Delete a memory that is wrong, obsolete, or contradicted. This removes the file and its index line; it cannot be undone.",
		promptSnippet: "Delete a wrong or obsolete memory",
		defaultActive: active,
		parameters: ForgetParams,
		async execute(_toolCallId, params: { id: string }, _signal, _onUpdate, ctx) {
			const state = stateFor(ctx);
			if (!state.config.enabled) return errorResult("pi-memory is disabled by configuration.");
			if (state.paused) return errorResult("Memory is paused for this session (`/memory on` to resume).");
			const found = state.store.find(params.id);
			if (!found) return errorResult(`No memory matches "${params.id}".`);
			// Deleting is irreversible, so a fuzzy match is not enough: require
			// the filename or the exact title.
			const exact =
				found.file.toLowerCase() === params.id.trim().toLowerCase() ||
				found.file.toLowerCase() === `${params.id.trim().toLowerCase()}.md` ||
				normalizeName(found.name) === normalizeName(params.id);
			if (!exact) {
				return errorResult(
					`"${params.id}" is ambiguous; it matched ${found.file}. Pass the filename to delete it.`
				);
			}
			const removed = state.store.forget(found.file);
			if (!removed) return errorResult(`No memory matches "${params.id}".`);
			state.surfaced.delete(removed.file);
			refreshIndex(state);
			return textResult(`Removed ${removed.file}. The index has ${removed.index.total} memories.`, {
				file: removed.file,
			});
		},
	});
}

async function searchMemories(
	state: SessionState,
	files: ReturnType<MemoryStore["files"]>,
	query: string,
	limit: number,
	mode: SearchMode
): Promise<SearchResult> {
	const keyword = keywordSearch(files, query, limit);
	if (mode === "keyword") return { hits: keyword };
	if (!state.config.semantic) {
		return { hits: keyword, note: "Semantic search is turned off in settings." };
	}
	const embedder = await ensureEmbedder(state);
	if (!embedder) {
		return { hits: keyword, note: state.semanticError ?? "Semantic search is unavailable." };
	}
	try {
		const semantic = await semanticSearch(files, {
			query,
			limit,
			profile: `${embedder.model}:${embedder.dimensions}`,
			minScore: embedder.minScore,
			embed: (texts) => embedder.embed(texts),
			cache: loadVectors(state),
		});
		state.vectors = semantic.cache;
		if (semantic.embedded > 0) persistVectors(state);
		const hits =
			mode === "semantic"
				? mergeSearchHits(semantic.hits, keyword, limit)
				: mergeSearchHits(keyword, semantic.hits, limit);
		return { hits };
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		state.semanticError = `Semantic search failed (${message}); keyword results shown.`;
		return { hits: keyword, note: state.semanticError };
	}
}

async function ensureEmbedder(state: SessionState): Promise<MemoryEmbedder | undefined> {
	if (state.embedder) return state.embedder;
	if (state.semanticError) return undefined;
	const loaded = await loadEmbedder();
	if (loaded.embedder) {
		state.embedder = loaded.embedder;
		return loaded.embedder;
	}
	state.semanticError = loaded.error ?? "Semantic search is unavailable.";
	return undefined;
}

// ---------------------------------------------------------------------------
// Model calls
// ---------------------------------------------------------------------------

type AnyModel = NonNullable<ExtensionContext["model"]>;

function resolveModel(ctx: ExtensionContext, override: string | undefined): AnyModel | undefined {
	if (!override) return ctx.model;
	const slash = override.indexOf("/");
	if (slash > 0) {
		const found = ctx.modelRegistry.find(override.slice(0, slash), override.slice(slash + 1));
		if (found) return found as AnyModel;
	}
	return (
		(ctx.modelRegistry.getAll().find(
			(model) => `${model.provider}/${model.id}` === override || model.id === override
		) as AnyModel | undefined) ?? ctx.model
	);
}

function modelLabel(model: AnyModel): string {
	return `${model.provider}/${model.id}`;
}

interface ModelReply {
	text: string;
	cost: number;
}

async function callModel(
	ctx: ExtensionContext,
	model: AnyModel,
	prompt: string,
	maxTokens: number,
	timeoutMs: number
): Promise<ModelReply> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await ctx.modelRegistry.complete(
			model,
			{
				messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
			},
			{ maxTokens, signal: controller.signal, cacheRetention: "none" }
		);
		const text = response.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim();
		return { text, cost: response.usage?.cost?.total ?? 0 };
	} finally {
		clearTimeout(timer);
	}
}

/** AGENTS.md / CLAUDE.md from cwd upward, so extraction can avoid restating them. */
function readProjectInstructions(cwd: string): string | undefined {
	const files: string[] = [];
	let dir = cwd;
	for (let depth = 0; depth < 6; depth++) {
		for (const name of ["AGENTS.md", "CLAUDE.md"]) {
			const path = join(dir, name);
			try {
				files.push(`## ${path}\n${readFileSync(path, "utf8").slice(0, 6_000)}`);
			} catch {
				// absent at this level
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	if (files.length === 0) return undefined;
	return files.join("\n\n").slice(0, 12_000);
}

/** Keep the frozen prompt section in step with an on-disk save. */
function refreshIndex(state: SessionState): void {
	const index = state.store.renderIndex();
	state.indexText = index.text;
	state.indexTotal = index.total;
	state.indexTruncated = index.truncated;
}

/** Fire-and-forget work started at `agent_settled`, awaitable in tests. */
const pendingWork = new Set<Promise<unknown>>();

export async function flushMemoryWork(): Promise<void> {
	while (pendingWork.size > 0) {
		await Promise.allSettled([...pendingWork]);
	}
}

function noteError(state: SessionState, message: string): void {
	state.stateError = message;
	try {
		state.store.updateState((saved) => {
			saved.lastError = message;
		});
	} catch {
		// A failed log must not replace the real failure.
	}
}

// ---------------------------------------------------------------------------
// Background extraction
// ---------------------------------------------------------------------------

async function extractionTick(
	pi: ExtensionAPI,
	state: SessionState,
	ctx: ExtensionContext
): Promise<void> {
	state.turnsSinceExtract += 1;
	if (!state.config.extraction.enabled || state.paused) return;
	if (state.turnsSinceExtract < state.config.extraction.every) return;
	state.turnsSinceExtract = 0;
	if (state.wroteThisRun) return;
	if (state.extracting || state.dreaming) return;
	if (isChildSession(ctx)) return;
	// A question form owns the session; a background model call now would spend
	// money behind a prompt the user is still reading.
	if (isBlocked()) return;
	// Non-interactive runs have no settled UI to report into, and are often
	// scripted; memory capture there is noise.
	if (!ctx.hasUI) return;

	const persisted = state.store.readState();
	const cursor = persisted.sessions[state.id]?.cursor;
	const entries = ctx.sessionManager.getBranch() as unknown as SliceEntry[];
	const slice = collectSlice(entries, cursor, {
		maxMessages: EXTRACT_SLICE_MESSAGES,
		maxChars: EXTRACT_SLICE_CHARS,
	});
	if (slice.messages.length < state.config.extraction.minMessages) return;

	const release = state.store.acquireLock(Date.now(), EXTRACT_TIMEOUT_MS + 30_000);
	if (!release) return;
	state.extracting = true;
	try {
		const model = resolveModel(ctx, state.config.model);
		if (!model) {
			noteError(state, "no active model for extraction");
			return;
		}
		const manifest = state.store.manifest();
		const prompt = buildExtractPrompt({
			slice,
			manifest,
			maxWrites: state.config.extraction.maxWrites,
			projectInstructions: readProjectInstructions(ctx.cwd),
		});
		const reply = await callModel(ctx, model, prompt, EXTRACT_MAX_TOKENS, EXTRACT_TIMEOUT_MS);
		// The session may have been replaced while the model was answering; the
		// old state and its UI are no longer the right place to write or notify.
		if (sessionId(ctx) !== state.id) return;
		const parsed = parseMemoryOps(reply.text);
		if (!parsed.ops) {
			noteError(state, `extraction failed: ${parsed.error ?? "no JSON"}`);
			return;
		}
		const validated = validateOps(parsed.ops, {
			existing: manifest,
			maxWrites: state.config.extraction.maxWrites,
			maxNameChars: state.config.limits.maxNameChars,
			maxDescriptionChars: state.config.limits.maxDescriptionChars,
			maxBodyChars: state.config.limits.maxBodyChars,
			allowUpdate: false,
		});
		const saved: SavedNotice["saved"] = [];
		for (const write of validated.writes) {
			try {
				const result = state.store.save(write);
				saved.push({ name: write.name, file: result.file, type: write.type });
			} catch (cause) {
				validated.rejected.push({
					name: write.name,
					reason: cause instanceof Error ? cause.message : String(cause),
				});
			}
		}
		const index = state.store.rewriteIndex();
		refreshIndex(state);
		const now = isoNow();
		state.store.updateState((savedState) => {
			const session = savedState.sessions[state.id] ?? { turns: 0, lastSeenAt: Date.now() };
			session.cursor = slice.lastId;
			session.lastSeenAt = Date.now();
			savedState.sessions[state.id] = session;
			savedState.lastExtractAt = now;
			savedState.lastExtractCost = reply.cost;
			savedState.lastExtractCount = saved.length;
			savedState.totalExtractCost = (savedState.totalExtractCost ?? 0) + reply.cost;
			savedState.extractRuns = (savedState.extractRuns ?? 0) + 1;
			savedState.lastError = undefined;
		});
		state.stateError = undefined;
		if (saved.length > 0) {
			const label = `${saved.length} ${saved.length === 1 ? "memory" : "memories"}`;
			pi.sendMessage({
				customType: SAVE_NOTICE_TYPE,
				content: `Saved ${label} · /memory`,
				display: true,
				details: {
					saved,
					rejected: validated.rejected.length,
					cost: reply.cost,
					model: modelLabel(model),
					indexLines: index.lines,
				} satisfies SavedNotice,
			});
		}
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		noteError(state, `extraction failed: ${message}`);
	} finally {
		state.extracting = false;
		release();
	}
}

// ---------------------------------------------------------------------------
// Consolidation
// ---------------------------------------------------------------------------

async function runDream(
	state: SessionState,
	ctx: ExtensionContext | ExtensionCommandContext
): Promise<string> {
	if (state.dreaming) return "A consolidation is already running.";
	const files = state.store.files();
	if (files.length === 0) return "Nothing to consolidate: the store is empty.";
	const release = state.store.acquireLock(Date.now(), DREAM_TIMEOUT_MS + 30_000);
	if (!release) return "Another pi process is consolidating this store.";
	state.dreaming = true;
	try {
		const model = resolveModel(ctx as ExtensionContext, state.config.model);
		if (!model) return "No active model for consolidation.";
		const prompt = buildDreamPrompt({
			manifest: state.store.manifest(files),
			maxWrites: 60,
			maxPerFileChars: 2_000,
			projectInstructions: readProjectInstructions(ctx.cwd),
		});
		const reply = await callModel(
			ctx as ExtensionContext,
			model,
			prompt,
			DREAM_MAX_TOKENS,
			DREAM_TIMEOUT_MS
		);
		const parsed = parseMemoryOps(reply.text);
		if (!parsed.ops) {
			noteError(state, `consolidation failed: ${parsed.error ?? "no JSON"}`);
			return `Consolidation failed: ${parsed.error ?? "the model did not return JSON"}.`;
		}
		const existing = state.store.manifest(files);
		const validated = validateOps(parsed.ops, {
			existing,
			maxWrites: 60,
			maxNameChars: state.config.limits.maxNameChars,
			maxDescriptionChars: state.config.limits.maxDescriptionChars,
			maxBodyChars: state.config.limits.maxBodyChars,
			allowUpdate: true,
		});
		// Writes first, deletes second. A rejected write means the merge it was
		// meant to perform did not happen, so its source memories must survive;
		// deleting first would empty the store on a single bad candidate.
		let written = 0;
		const writtenFiles = new Set<string>();
		for (const write of validated.writes) {
			try {
				const result = state.store.save(write);
				written++;
				writtenFiles.add(result.file);
			} catch (cause) {
				validated.rejected.push({
					name: write.name,
					reason: cause instanceof Error ? cause.message : String(cause),
				});
			}
		}
		let removed = 0;
		const writesFailed = validated.rejected.length > 0;
		if (!writesFailed) {
			for (const file of validated.deletes) {
				if (writtenFiles.has(file)) continue;
				if (state.store.forget(file)) removed++;
			}
		}
		const index = state.store.rewriteIndex();
		refreshIndex(state);
		const now = isoNow();
		state.store.updateState((savedState) => {
			savedState.lastDreamAt = now;
			savedState.lastError = undefined;
			savedState.totalExtractCost = (savedState.totalExtractCost ?? 0) + reply.cost;
		});
		state.stateError = undefined;
		const summary = `${written} written · ${removed} removed · index ${index.lines} lines`;
		const rejected =
			validated.rejected.length > 0
				? ` · ${validated.rejected.length} rejected, deletes skipped`
				: "";
		const badDeletes =
			validated.rejectedDeletes.length > 0
				? ` · ${validated.rejectedDeletes.length} deletes ignored`
				: "";
		return `${summary}${rejected}${badDeletes}`;
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		noteError(state, `consolidation failed: ${message}`);
		return `Consolidation failed: ${message}`;
	} finally {
		state.dreaming = false;
		release();
	}
}

function autoDreamDue(state: SessionState): boolean {
	if (!state.config.dream.auto) return false;
	const saved = state.store.readState();
	if (!saved.lastDreamAt) return false; // the first consolidation is always manual
	const last = Date.parse(saved.lastDreamAt);
	if (!Number.isFinite(last)) return false;
	if (Date.now() - last < state.config.dream.afterHours * 3_600_000) return false;
	const sessions = Object.values(saved.sessions).filter((entry) => entry.lastSeenAt > last).length;
	return sessions >= state.config.dream.afterSessions;
}

// ---------------------------------------------------------------------------
// Status and commands
// ---------------------------------------------------------------------------

function kb(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	return `${(bytes / 1024).toFixed(1)} KB`;
}

export function formatStatus(state: SessionState, now: number = Date.now()): string {
	const saved = state.store.readState();
	const stats = state.store.stats();
	const lastExtract = saved.lastExtractAt ? formatAge(now - Date.parse(saved.lastExtractAt)) : "never";
	const lastDream = saved.lastDreamAt ? formatAge(now - Date.parse(saved.lastDreamAt)) : "never";
	const cost = saved.totalExtractCost ?? 0;
	const lines = [
		`Store     ${displayPath(state.store.dir)}`,
		`Scope     ${state.config.scope} (${displayPath(state.scopeRoot)})`,
		`Files     ${stats.files} · ${kb(stats.bytes)} · index ${stats.indexLines}/${state.config.index.maxLines} lines · ${kb(stats.indexBytes)}${stats.truncated ? " (truncated)" : ""}`,
		`Config    ${displayPath(state.configFile)}${state.configError ? ` (unreadable: ${state.configError})` : ""}`,
		`Layout    store ${state.config.store} · semantic ${state.config.semantic ? "on" : "off"}`,
		`Gates     inline ${state.config.inlineSave ? "on" : "off"} · recall ${state.config.recall.maxFiles}/${kb(state.config.recall.maxBytes)} · extraction every ${state.config.extraction.every} · auto-dream ${state.config.dream.auto ? "on" : "off"}`,
		`Extract   ${lastExtract} · ${saved.lastExtractCount ?? 0} saved · $${(saved.lastExtractCost ?? 0).toFixed(4)} last · $${cost.toFixed(4)} total`,
		`Dream     ${lastDream}`,
		`Session   ${state.paused ? "paused" : "active"} · recall ${state.recallCount} (${kb(state.recallBytes)}, last ${kb(state.lastRecallBytes)}) · cursor ${saved.sessions[state.id]?.cursor ? "set" : "new"}`,
	];
	if (state.stateError || saved.lastError) lines.push(`Last error ${state.stateError ?? saved.lastError}`);
	return lines.join("\n");
}

function importSourceFor(state: SessionState): string {
	return claudeSourceDirFor(state.cwd);
}

async function handleCommand(
	pi: ExtensionAPI,
	args: string,
	ctx: ExtensionCommandContext
): Promise<void> {
	const state = stateFor(ctx);
	const parts = args.trim().split(/\s+/).filter((part) => part !== "");
	const sub = parts[0] ?? "status";
	const rest = parts.slice(1);

	switch (sub) {
		case "status": {
			ctx.ui.notify(formatStatus(state), "info");
			return;
		}
		case "off": {
			state.paused = true;
			ctx.ui.notify("Memory paused for this session. `/memory on` resumes it.", "info");
			return;
		}
		case "on": {
			state.paused = false;
			ctx.ui.notify("Memory active for this session.", "info");
			return;
		}
		case "list": {
			ctx.ui.notify(formatManifest(state.store.files()), "info");
			return;
		}
		case "root": {
			const root = scopePath(ctx.cwd, "git-root");
			const dir = storeDirFor({
				cwd: root,
				scope: "cwd",
				store: state.config.store,
			});
			const other = new MemoryStore(dir, state.config.limits);
			const stats = other.stats();
			ctx.ui.notify(
				`Repository root: ${displayPath(root)}\nStore: ${displayPath(dir)}\n${stats.files} memories · index ${stats.indexLines} lines`,
				"info"
			);
			return;
		}
		case "dream": {
			ctx.ui.setStatus("pi-memory", "consolidating memory…");
			try {
				const result = await runDream(state, ctx);
				ctx.ui.notify(result, "info");
			} finally {
				ctx.ui.setStatus("pi-memory", undefined);
			}
			return;
		}
		case "import": {
			if (state.config.store === "claude") {
				ctx.ui.notify(
					"This store is already shared with Claude Code (`memory.store: \"claude\"`); nothing to import.",
					"info"
				);
				return;
			}
			const dryRun = rest.includes("--dry-run") || rest.includes("-n");
			try {
				const plan = planImport(importSourceFor(state), state.store);
				if (dryRun) {
					ctx.ui.notify(formatImportPlan(plan), "info");
					return;
				}
				const result = applyImport(plan, state.store);
				refreshIndex(state);
				ctx.ui.notify(formatImportResult(result), "info");
			} catch (cause) {
				ctx.ui.notify(cause instanceof Error ? cause.message : String(cause), "warning");
			}
			return;
		}
		case "promote": {
			const id = rest.join(" ");
			const memory = id ? state.store.find(id) : undefined;
			if (!memory) {
				ctx.ui.notify("Usage: /memory promote <name>. It drafts text; it never edits AGENTS.md.", "info");
				return;
			}
			ctx.ui.notify(
				`Proposed addition to AGENTS.md (not written):\n\n### ${memory.name}\n${memory.body}\n\nReview it, then paste it yourself if it belongs there.`,
				"info"
			);
			return;
		}
		case "eval": {
			const sessionsDir = ctx.sessionManager.getSessionDir();
			const sessions = readSessionFiles(sessionsDir, 20);
			if (sessions.length === 0) {
				ctx.ui.notify(`No saved sessions in ${displayPath(sessionsDir)} to replay.`, "info");
				return;
			}
			const memories = state.store.files();
			const recall = evaluateRecall(sessions, memories, { limits: state.config.limits });
			let extraction: ReturnType<typeof emptyExtractionEval> | undefined;
			const flag = rest.indexOf("--extract");
			if (flag >= 0) {
				ctx.ui.setStatus("pi-memory", "replaying sessions for the eval…");
				const requested = Number(rest[flag + 1]);
				const take = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 10) : 3;
				const model = resolveModel(ctx, state.config.model);
				if (!model) {
					ctx.ui.setStatus("pi-memory", undefined);
					ctx.ui.notify("No active model for the extraction eval.", "warning");
					return;
				}
				extraction = emptyExtractionEval();
				// Earlier accepted writes join the manifest, so a duplicate across
				// replayed sessions is caught instead of counted twice.
				const existing = [...state.store.manifest(memories)];
				for (const session of sessions.slice(0, take)) {
					const slice = sessionSlice(session, {
						maxMessages: EXTRACT_SLICE_MESSAGES,
						maxChars: EXTRACT_SLICE_CHARS,
					});
					if (slice.messages.length < state.config.extraction.minMessages) continue;
					const label = session.path.split("/").pop() ?? session.path;
					try {
						const reply = await callModel(
							ctx as ExtensionContext,
							model,
							buildExtractPrompt({
								slice,
								manifest: existing,
								maxWrites: state.config.extraction.maxWrites,
								projectInstructions: readProjectInstructions(ctx.cwd),
							}),
							EXTRACT_MAX_TOKENS,
							EXTRACT_TIMEOUT_MS
						);
						const parsed = parseMemoryOps(reply.text);
						if (!parsed.ops) {
							addExtractionSample(extraction, {
								session: label,
								proposed: 0,
								accepted: 0,
								rejected: [{ name: "-", reason: `model: ${parsed.error ?? "no JSON"}` }],
								writes: [],
							});
							continue;
						}
						const validated = validateOps(parsed.ops, {
							existing,
							maxWrites: state.config.extraction.maxWrites,
							maxNameChars: state.config.limits.maxNameChars,
							maxDescriptionChars: state.config.limits.maxDescriptionChars,
							maxBodyChars: state.config.limits.maxBodyChars,
							allowUpdate: false,
						});
						addExtractionSample(extraction, {
							session: label,
							proposed: parsed.ops.writes.length,
							accepted: validated.writes.length,
							rejected: validated.rejected.map((entry) => ({
								name: entry.name,
								reason: entry.reason,
							})),
							writes: validated.writes.map((write) => ({
								name: write.name,
								type: write.type,
								description: write.description,
							})),
						});
						for (const write of validated.writes) {
							existing.push({
								file: filenameFor(write.type, write.name),
								name: write.name,
								description: write.description,
								type: write.type,
								body: write.body,
							});
						}
					} catch (cause) {
						addExtractionSample(extraction, {
							session: label,
							proposed: 0,
							accepted: 0,
							rejected: [
								{
									name: "-",
									reason: `model: ${cause instanceof Error ? cause.message : String(cause)}`,
								},
							],
							writes: [],
						});
					}
				}
			}
			const report = formatEvalReport({
				recall,
				extraction,
				storeDir: state.store.dir,
				memories: memories.length,
				indexLines: state.indexText.split("\n").filter((line) => line.startsWith("- [")).length,
			});
			ctx.ui.setStatus("pi-memory", undefined);
			const reportDir = join(agentDir(), "memory-eval");
			mkdirSync(reportDir, { recursive: true, mode: 0o700 });
			const reportName = createHash("sha1").update(state.store.dir).digest("hex").slice(0, 16);
			const reportPath = join(reportDir, `${reportName}.md`);
			writeAtomic(reportPath, report);
			ctx.ui.notify(`${evalSummary(recall)}\nReport: ${displayPath(reportPath)}`, "info");
			return;
		}
		case "help": {
			ctx.ui.notify(
				[
					"/memory             status of this project's store",
					"/memory status      same as above",
					"/memory list        every memory, one line each",
					"/memory root        the repository-root store (for monorepos)",
					"/memory dream       merge, prune, and rewrite the store",
					"/memory import      copy from Claude Code's store (add --dry-run to preview)",
					"/memory eval        replay saved sessions; --extract dry-runs extraction",
					"/memory promote <n> draft an AGENTS.md entry; never writes it",
					"/memory off|on      pause or resume memory for this session",
				].join("\n"),
				"info"
			);
			return;
		}
		default:
			ctx.ui.notify(`Unknown /memory subcommand "${sub}". Try /memory help.`, "warning");
	}
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function createMemoryExtension(pi: ExtensionAPI): void {
	const startup = loadConfig();
	registerTools(pi, startup.config.enabled);
	registerMessageRenderer(pi);

	pi.on("session_start", async (_event, ctx) => {
		const state = stateFor(ctx);
		if (!state.config.enabled) return;
		try {
			state.store.updateState((saved) => {
				const session = saved.sessions[state.id] ?? { turns: 0, lastSeenAt: Date.now() };
				session.lastSeenAt = Date.now();
				saved.sessions[state.id] = session;
			});
		} catch {
			// A read-only store is reported by /memory status, not fatal here.
		}
		if (state.config.dream.auto && ctx.hasUI && autoDreamDue(state)) {
			state.dreamTimer = setTimeout(() => {
				void runDream(state, ctx).catch(() => {});
			}, 2_000);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const id = sessionId(ctx);
		const state = sessions.get(id);
		if (state?.dreamTimer) clearTimeout(state.dreamTimer);
		sessions.delete(id);
	});

	pi.on("agent_start", async (_event, ctx) => {
		stateFor(ctx).wroteThisRun = false;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const state = stateFor(ctx);
		if (!state.config.enabled || state.paused) return;
		if (state.config.inlineSave && event.systemPromptOptions) {
			event.systemPromptOptions.sections ??= {};
			event.systemPromptOptions.sections["pi-memory"] = buildMemorySection(state);
		}
		if (event.messageType !== "user" || !state.config.recall.enabled) return;
		if (isChildSession(ctx) || event.prompt.trim() === "") return;
		const selection = selectRecall(
			state.store.files(),
			event.prompt,
			recallOptions(state.config.limits),
			state.surfaced
		);
		if (selection.selected.length === 0) return;
		for (const memory of selection.selected) state.surfaced.add(memory.file);
		state.recallCount += 1;
		state.recallBytes += selection.bytes;
		state.lastRecallBytes = selection.bytes;
		return {
			message: {
				customType: RECALL_CUSTOM_TYPE,
				content: selection.text,
				display: false,
			},
		};
	});

	pi.on("agent_settled", (event, ctx) => {
		if (event.aborted) return;
		const state = stateFor(ctx);
		// Do not await: pi defers the next prompt until settled handlers finish,
		// and a model call here can take up to 90 seconds. Extraction is
		// background work with its own lock, re-entrancy guard, and cursor.
		const work = extractionTick(pi, state, ctx)
			.catch((cause) => {
				noteError(state, cause instanceof Error ? cause.message : String(cause));
			})
			.finally(() => {
				pendingWork.delete(work);
			});
		pendingWork.add(work);
	});

	pi.registerCommand(COMMAND, {
		description: "Persistent project memory: status, list, dream, import, pause",
		handler: async (args, ctx) => {
			await handleCommand(pi, args, ctx);
		},
	});
}

function registerMessageRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer(SAVE_NOTICE_TYPE, (message, options, theme) => {
		const details = message.details as SavedNotice | undefined;
		const content =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("\n");
		const line = `${theme.fg("success", "●")} ${theme.fg("text", content)}`;
		const box = new Box(options.outputPad, 1, (text) => theme.bg("customMessageBg", text));
		if (!options.expanded || !details) {
			box.addChild(new Text(`${line} ${theme.fg("dim", "Ctrl+O to expand")}`, 0, 0));
			return box;
		}
		const lines = [line];
		for (const memory of details.saved) {
			lines.push(theme.fg("dim", `  ${memory.type} · ${memory.name} (${memory.file})`));
		}
		if (details.rejected > 0) lines.push(theme.fg("dim", `  ${details.rejected} skipped by validation`));
		if (details.cost > 0) lines.push(theme.fg("dim", `  $${details.cost.toFixed(4)} · ${details.model}`));
		lines.push(theme.fg("dim", `  index ${details.indexLines} lines · /memory`));
		box.addChild(new Text(lines.join("\n"), 0, 0));
		return box;
	});
}

// ---------------------------------------------------------------------------
// Exports used by tests
// ---------------------------------------------------------------------------

