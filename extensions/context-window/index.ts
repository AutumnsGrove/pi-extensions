/**
 * context-window — inspect and cap the effective context window.
 *
 * Pi compacts when `contextTokens > model.contextWindow - reserveTokens`. A
 * 1M-token model therefore stays uncompacted until quality has already
 * degraded. This extension lets you lower the *effective* window by
 * materializing a real derived model (`deepseek-v4.1-flash-400k`) that pi
 * treats exactly like any other model, so auto-compaction, the footer
 * percentage, and `getContextUsage()` all follow the reduced limit.
 *
 * `/context`          breakdown of where the context went
 * `/context set 400k` derive a 400k-window model and switch to it
 * `/context reset`    switch back to the native model and drop the derived one
 * `/context list`     show configured limits
 *
 * Chosen limits live in `<agent-dir>/context-window.json`; the derived model
 * definitions they produce live in `<agent-dir>/models.json`. On session start
 * a configured limit is re-applied automatically, so new sessions inherit it.
 */

import {
	DEFAULT_COMPACTION_SETTINGS,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { formatPercent, renderBar } from "./bar.ts";
import { analyzeContext, breakdownRows } from "./breakdown.ts";
import {
	getLimit,
	listLimits,
	modelKey,
	readLimitConfig,
	removeLimit,
	setLimit,
	writeLimitConfig,
	type LimitConfig,
	type LimitEntry,
} from "./config.ts";
import { formatTokenCount, parseTokenCount } from "./format.ts";
import { readJsonFile, writeJsonFile } from "./json.ts";
import {
	buildVariantDefinition,
	findVariant,
	modelsJsonPath,
	removeVariant,
	upsertVariant,
	variantIdFor,
	variantName,
	type ModelsJson,
} from "./variant.ts";

const COMMAND_NAME = "context";
const VIRTUAL_API = "pi-virtual";
/** Below this a reduced window mostly fights the reserve + keep-recent budgets. */
const MIN_LIMIT = 32_000;

const USAGE = [
	"Usage: /context [set <size> | reset | list]",
	"",
	"  /context              Show the context breakdown",
	"  /context set 400k     Derive a 400k-window model and switch to it",
	"  /context reset        Switch back to the native model",
	"  /context list         Show configured limits",
].join("\n");

type BaseModel = Model<any>;
type SettingsSnapshot = ReturnType<ExtensionAPI["getSettings"]>;

interface ActiveLimit {
	provider: string;
	baseId: string;
	entry: LimitEntry;
	/** True when the current model is the derived model rather than the base. */
	isVariant: boolean;
}

interface ResolvedBase {
	base: BaseModel;
	provider: string;
	baseId: string;
	active?: ActiveLimit;
}

function notify(
	ctx: ExtensionContext,
	message: string,
	kind: "info" | "warning" | "error" = "info"
): void {
	ctx.ui.notify(message, kind);
}

function pad(label: string, width: number): string {
	return label.length >= width ? label : label + " ".repeat(width - label.length);
}

/** Find the configured limit behind the current model, if any. */
function findActiveLimit(
	config: LimitConfig,
	provider: string,
	modelId: string
): ActiveLimit | undefined {
	const direct = getLimit(config, provider, modelId);
	if (direct) {
		return { provider, baseId: modelId, entry: direct, isVariant: false };
	}
	for (const { provider: entryProvider, entry } of listLimits(config)) {
		if (entryProvider === provider && entry.variantId === modelId) {
			return { provider, baseId: entry.baseId, entry, isVariant: true };
		}
	}
	return undefined;
}

/** Resolve the real model a limit applies to, plus any active configuration. */
function resolveBase(ctx: ExtensionContext, config: LimitConfig): ResolvedBase | undefined {
	const model = ctx.model;
	if (!model) {
		return undefined;
	}
	const provider = model.provider;
	const active = findActiveLimit(config, provider, model.id);
	if (active?.isVariant) {
		const base = ctx.modelRegistry.find(provider, active.baseId) ?? model;
		return { base, provider, baseId: active.baseId, active };
	}
	return { base: model, provider, baseId: model.id, active };
}

function readModels(): ModelsJson {
	return readJsonFile<ModelsJson>(modelsJsonPath()) ?? {};
}

/**
 * Derived model id -> base model id, keyed by `provider/variantId`.
 *
 * The derived id is local only: pi sends `model.id` to the provider, so a
 * variant would be rejected as an unknown slug (`...-400k` does not exist on
 * OpenRouter). We rewrite outgoing requests back to the real base id. Because
 * this extension loads before `provider-pinning` (package entries are sorted by
 * path), that extension then sees the base id and applies the base model's pin.
 */
const variantBases = new Map<string, string>();

function variantKey(provider: string, modelId: string): string {
	return `${provider}/${modelId}`;
}

function reloadVariantBases(config: LimitConfig): void {
	variantBases.clear();
	for (const { provider, entry } of listLimits(config)) {
		variantBases.set(variantKey(provider, entry.variantId), entry.baseId);
	}
}

function writeModels(models: ModelsJson): void {
	writeJsonFile(modelsJsonPath(), models);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Look up the derived model by index first, then by scanning the catalog. Some
 * registry builds do not surface freshly reloaded models through `find`.
 */
function findRegisteredVariant(
	ctx: ExtensionContext,
	provider: string,
	variantId: string
): BaseModel | undefined {
	const direct = ctx.modelRegistry.find(provider, variantId);
	if (direct) {
		return direct;
	}
	return ctx.modelRegistry
		.getAll()
		.find((entry) => entry.provider === provider && entry.id === variantId);
}

/** A plain copy of the base with a lower window, used when registration fails. */
function shadowVariant(base: BaseModel, tokens: number, variantId: string): BaseModel {
	return { ...base, id: variantId, name: variantName(base.name, tokens), contextWindow: tokens };
}

/** Combine refresh and registry errors into one line for the fallback notice. */
function describeRegistryError(
	ctx: ExtensionContext,
	refresh: { errors?: ReadonlyMap<string, Error> }
): string | undefined {
	const parts: string[] = [];
	for (const [provider, error] of refresh.errors ?? []) {
		parts.push(`${provider}: ${error.message}`);
	}
	const registryError = ctx.modelRegistry.getError?.();
	if (registryError) {
		parts.push(registryError);
	}
	return parts.join("; ") || undefined;
}

/** Reserve for the model that governs compaction, honouring per-model overrides. */
function resolveReserve(model: BaseModel | undefined, settings: SettingsSnapshot | undefined): number {
	const ordinary = settings?.compaction?.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens;
	if (!model) {
		return ordinary;
	}
	const override = settings?.compaction?.modelOverrides?.[modelKey(model.provider, model.id)];
	return override?.reserveTokens ?? ordinary;
}

/** Render the context panel. */
function showContext(
	ctx: ExtensionContext,
	config: LimitConfig,
	settings: SettingsSnapshot | undefined
): void {
	const model = ctx.model;
	const usage = ctx.getContextUsage();
	const resolved = resolveBase(ctx, config);
	const base = resolved?.base ?? model;
	const window = usage?.contextWindow ?? model?.contextWindow ?? 0;
	const native = base?.contextWindow ?? window;
	const projection = ctx.sessionManager.buildSessionProjection();
	const breakdown = analyzeContext(projection.messages);
	const used = usage?.tokens ?? breakdown.total;
	const percent = window > 0 ? (used / window) * 100 : null;
	const reserve = resolveReserve(model, settings);
	const compactAt = Math.max(0, window - reserve);

	const active = resolved?.active;
	const limitEntry = active?.entry;
	const lines: string[] = ["Context usage", ""];
	lines.push(
		`${pad("Window", 11)} ${formatTokenCount(window)}${
			limitEntry ? `  (native ${formatTokenCount(native)})` : ""
		}`
	);
	lines.push(
		`${pad("Used", 11)} ${renderBar(window > 0 ? used / window : 0, 18)}  ${formatTokenCount(used).padStart(
			7
		)}${percent !== null ? `  ${formatPercent(percent / 100)}` : ""}`
	);
	lines.push(
		`${pad("Compact at", 11)} ${formatTokenCount(compactAt)}${
			window > 0 ? `  (${formatPercent(compactAt / window)})` : ""
		}`
	);
	lines.push(`${pad("Reserve", 11)} ${formatTokenCount(reserve)}`);

	lines.push("", "Breakdown (estimated)");
	const total = breakdown.total;
	const rows = breakdownRows(breakdown).sort((a, b) => b.tokens - a.tokens);
	for (const row of rows) {
		const share = total > 0 ? row.tokens / total : 0;
		lines.push(
			`  ${pad(row.label, 16)} ${renderBar(share, 18)}  ${formatTokenCount(row.tokens).padStart(
				7
			)}  ${formatPercent(share)}`
		);
	}
	if (breakdown.images > 0) {
		lines.push(`  ${pad("Images", 16)} ${" ".repeat(18)}  ${String(breakdown.images).padStart(7)}`);
	}
	lines.push(`  ${pad("Total", 16)} ${" ".repeat(18)}  ${formatTokenCount(total).padStart(7)}`);

	lines.push("");
	if (limitEntry) {
		lines.push(
			`Limit ${formatTokenCount(limitEntry.limit)} via ${limitEntry.variantId}. /context reset to clear.`
		);
	} else {
		lines.push("No custom limit. /context set <size> to cap the window.");
	}
	notify(ctx, lines.join("\n"), "info");
}

/** Materialize a derived model and switch to it. */
async function handleSet(
	pi: ExtensionAPI,
	args: string,
	ctx: ExtensionCommandContext,
	config: LimitConfig,
	settings: SettingsSnapshot | undefined
): Promise<void> {
	const tokens = parseTokenCount(args);
	if (!tokens) {
		notify(ctx, `Expected a size like 400k or 1m.\n\n${USAGE}`, "warning");
		return;
	}
	const resolved = resolveBase(ctx, config);
	if (!resolved) {
		notify(ctx, "No active model to cap.", "warning");
		return;
	}
	const { base, provider, baseId, active } = resolved;
	if (base.api === VIRTUAL_API) {
		notify(
			ctx,
			"Virtual models route to a physical model; set the limit on the physical model instead.",
			"warning"
		);
		return;
	}
	if (tokens >= base.contextWindow) {
		notify(
			ctx,
			`Limit ${formatTokenCount(tokens)} must be below the native window ${formatTokenCount(base.contextWindow)}.`,
			"warning"
		);
		return;
	}
	if (tokens < MIN_LIMIT) {
		notify(
			ctx,
			`Limit ${formatTokenCount(tokens)} is below the ${formatTokenCount(MIN_LIMIT)} floor.`,
			"warning"
		);
		return;
	}

	const variantId = variantIdFor(baseId, tokens);
	const models = readModels();
	const existingEntry = findVariant(models, provider, variantId);
	const registered = findRegisteredVariant(ctx, provider, variantId);
	if (registered && (!existingEntry || existingEntry.contextWindow !== tokens)) {
		notify(
			ctx,
			`A model named ${variantId} already exists and is not managed by /context. Pick a different size.`,
			"warning"
		);
		return;
	}

	let nextModels = models;
	if (active && active.entry.variantId !== variantId) {
		nextModels = removeVariant(nextModels, provider, active.entry.variantId);
	}
	nextModels = upsertVariant(nextModels, provider, buildVariantDefinition(base, tokens, variantId));
	writeModels(nextModels);

	const refresh = await ctx.modelRegistry.refresh({ allowNetwork: false, providers: [provider] });
	let variant = findRegisteredVariant(ctx, provider, variantId);
	if (!variant) {
		// A registry recompose triggered by another extension can land a tick later.
		await delay(75);
		variant = findRegisteredVariant(ctx, provider, variantId);
	}
	const registryMiss = variant === undefined;
	if (!variant) {
		variant = shadowVariant(base, tokens, variantId);
	}
	const refreshError = registryMiss ? describeRegistryError(ctx, refresh) : undefined;

	const nextConfig = setLimit(config, provider, { baseId, limit: tokens, variantId });
	writeLimitConfig(nextConfig);
	reloadVariantBases(nextConfig);

	try {
		const ok = await pi.setModel(variant);
		if (!ok) {
			writeLimitConfig(config);
			reloadVariantBases(config);
			notify(ctx, `Could not switch to ${variantId}; check provider authentication.`, "error");
			return;
		}
	} catch (error) {
		writeLimitConfig(config);
		reloadVariantBases(config);
		const message = error instanceof Error ? error.message : String(error);
		notify(ctx, `Could not switch to ${variantId}: ${message}`, "error");
		return;
	}

	const compactAt = formatTokenCount(Math.max(0, tokens - resolveReserve(variant, settings)));
	if (registryMiss) {
		notify(
			ctx,
			`Context window capped at ${formatTokenCount(tokens)} via a session override for ${variantId}. ` +
				`models.json was updated but the running registry did not reload it${
					refreshError ? ` (${refreshError})` : ""
				}; restart pi to register it permanently. Auto-compaction fires at ${compactAt}.`,
			"warning"
		);
		return;
	}
	notify(
		ctx,
		`Context window capped at ${formatTokenCount(tokens)} (native ${formatTokenCount(base.contextWindow)}). ` +
			`Now using ${variantId}; auto-compaction fires at ${compactAt}.`,
		"info"
	);
}

/** Drop the derived model and switch back to the native one. */
async function handleReset(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	config: LimitConfig
): Promise<void> {
	const model = ctx.model;
	const active = model ? findActiveLimit(config, model.provider, model.id) : undefined;
	if (!model || !active) {
		notify(ctx, "No custom context window is configured for this model.", "info");
		return;
	}

	if (active.isVariant) {
		const base = ctx.modelRegistry.find(active.provider, active.baseId);
		if (!base) {
			notify(ctx, `Could not find the base model ${active.baseId}; leaving the model unchanged.`, "error");
			return;
		}
		try {
			await pi.setModel(base);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			notify(ctx, `Could not switch back to ${active.baseId}: ${message}`, "error");
			return;
		}
	}

	writeModels(removeVariant(readModels(), active.provider, active.entry.variantId));
	await ctx.modelRegistry.refresh({ allowNetwork: false, providers: [active.provider] });
	const nextConfig = removeLimit(config, active.provider, active.baseId);
	writeLimitConfig(nextConfig);
	reloadVariantBases(nextConfig);
	notify(
		ctx,
		`Removed ${active.entry.variantId}; back to the native ${formatTokenCount(
			ctx.model?.contextWindow ?? 0
		)} window.`,
		"info"
	);
}

function handleList(ctx: ExtensionContext, config: LimitConfig): void {
	const entries = listLimits(config);
	if (entries.length === 0) {
		notify(ctx, "No custom context windows configured.", "info");
		return;
	}
	notify(
		ctx,
		entries
			.map(({ key, entry }) => `${key}  ->  ${formatTokenCount(entry.limit)}  (model ${entry.variantId})`)
			.join("\n"),
		"info"
	);
}

/**
 * Re-apply a configured limit when the session opens on the base model, so a
 * new session inherits the cap without a manual `/model` pick.
 */
async function applyConfiguredLimit(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	config: LimitConfig
): Promise<void> {
	const model = ctx.model;
	if (!model) {
		return;
	}
	const active = findActiveLimit(config, model.provider, model.id);
	if (!active || active.isVariant) {
		return;
	}
	await ctx.modelRegistry.refresh({ allowNetwork: false, providers: [active.provider] });
	let variant = findRegisteredVariant(ctx, active.provider, active.entry.variantId);
	if (!variant) {
		variant = shadowVariant(model, active.entry.limit, active.entry.variantId);
	}
	try {
		await pi.setModel(variant);
	} catch {
		// Leave the native model in place; `/context set` can rebuild the variant.
	}
}

export default function contextWindow(pi: ExtensionAPI): void {
	reloadVariantBases(readLimitConfig());

	pi.on("session_start", async (_event, ctx) => {
		const config = readLimitConfig();
		reloadVariantBases(config);
		await applyConfiguredLimit(pi, ctx, config);
	});

	// Keep derived ids local: providers must receive the real base model slug.
	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		if (!model) {
			return undefined;
		}
		const baseId = variantBases.get(variantKey(model.provider, model.id));
		if (!baseId || !event.payload || typeof event.payload !== "object") {
			return undefined;
		}
		const payload = event.payload as Record<string, unknown>;
		if (payload.model === baseId) {
			return undefined;
		}
		return { ...payload, model: baseId };
	});

	pi.registerCommand(COMMAND_NAME, {
		description: "Inspect and cap the effective context window",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = parts[0] ?? "";
			const rest = parts.slice(1).join(" ");
			const config = readLimitConfig();
			const settings = pi.getSettings();
			switch (sub) {
				case "":
				case "show":
					showContext(ctx, config, settings);
					return;
				case "set":
					await handleSet(pi, rest, ctx, config, settings);
					return;
				case "reset":
					await handleReset(pi, ctx, config);
					return;
				case "list":
					handleList(ctx, config);
					return;
				default:
					notify(ctx, USAGE, "info");
			}
		},
	});
}
