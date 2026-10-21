/**
 * hooks — a Claude Code-compatible hook engine for pi.
 *
 * Hooks live under the `"hooks"` key in `~/.pi/agent/settings.json` and
 * `.pi/settings.json`, using Claude's event names and nesting
 * (`event → matcher → hooks[]`). Handlers can be `command` (stdin JSON, exit
 * codes, stdout JSON), `http` (POST), or `prompt` (a model verdict). Other
 * extensions can register in-process handlers over `pi.events`.
 *
 * This extension only dispatches. Permissions, sounds, and anything else are
 * separate consumers; see `extensions/permissions` and `extensions/sounds`.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolCallEvent,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { readHooksConfig, normalizeHooks, type LoadedHooks } from "./config.ts";
import {
	createDispatchState,
	dispatchHooks,
	type DispatchState,
} from "./dispatch.ts";
import {
	baseInput,
	sessionEndReason,
	sessionStartSource,
	toolInput,
} from "./input.ts";
import { canonicalEvent } from "./events.ts";
import type {
	HookEventName,
	HookInput,
	InProcessHookHandler,
	NormalizedHook,
} from "./types.ts";

const DEBUG = process.env.PI_HOOKS_DEBUG === "1";

function debug(message: string): void {
	if (DEBUG) console.error(`[hooks] ${message}`);
}

/** SessionEnd hooks share a short budget, like Claude's 1.5s. */
const SESSION_END_BUDGET_MS = 1500;

function statusHandler(ctx: ExtensionContext) {
	return (message: string | undefined): void => {
		if (!ctx.hasUI) return;
		try {
			ctx.ui.setStatus("hooks", message);
		} catch {
			// Status is cosmetic; never fail a hook over it.
		}
	};
}

function coerceContent(
	value: unknown,
): { content: { type: "text"; text: string }[] } | undefined {
	if (typeof value === "string") {
		return { content: [{ type: "text", text: value }] };
	}
	if (Array.isArray(value)) {
		const content = value.filter(
			(entry): entry is { type: "text"; text: string } =>
				!!entry &&
				typeof entry === "object" &&
				(entry as { type?: unknown }).type === "text" &&
				typeof (entry as { text?: unknown }).text === "string",
		);
		if (content.length === value.length && content.length > 0) return { content };
	}
	return undefined;
}

function contextBlock(text: string): { type: "text"; text: string } {
	return { type: "text", text: `\n\n<hook-context>\n${text}\n</hook-context>` };
}

export default function hooks(pi: ExtensionAPI): void {
	let loaded: LoadedHooks = { hooks: [], warnings: [] };
	const state: DispatchState = createDispatchState();
	const bus = new Map<string, InProcessHookHandler>();

	const reload = (): LoadedHooks => {
		try {
			const normalized = normalizeHooks(
				readHooksConfig(pi.getSettings()),
				"settings.json",
			);
			loaded = normalized;
			for (const warning of normalized.warnings) debug(warning);
		} catch (error) {
			debug(`could not read settings: ${(error as Error).message}`);
			loaded = { hooks: [], warnings: [] };
		}
		return loaded;
	};
	reload();

	const dispatch = (
		event: HookEventName,
		input: HookInput,
		ctx: ExtensionContext,
		options: Parameters<typeof dispatchHooks>[4] = {},
	) =>
		dispatchHooks(
			event,
			input,
			ctx,
			loaded.hooks,
			{
				...options,
				bus: [...bus.values()],
				debug,
				onStatus: options.onStatus ?? statusHandler(ctx),
			},
			state,
		);

	// ---------------------------------------------------------------------
	// In-process bus: other extensions register handlers on pi.events.
	// ---------------------------------------------------------------------

	pi.events.on("pi-hooks:register", (data) => {
		if (!data || typeof data !== "object") return;
		const registration = data as {
			event?: unknown;
			matcher?: unknown;
			handler?: unknown;
			source?: unknown;
		};
		const event =
			typeof registration.event === "string"
				? canonicalEvent(registration.event)
				: undefined;
		if (!event || typeof registration.handler !== "function") {
			debug("ignored an invalid pi-hooks:register payload");
			return;
		}
		const source =
			typeof registration.source === "string" ? registration.source : "extension";
		const key = `${source}:${event}:${bus.size}`;
		bus.set(key, {
			event,
			matcher:
				typeof registration.matcher === "string"
					? registration.matcher
					: undefined,
			handler: registration.handler as InProcessHookHandler["handler"],
			source,
		});
	});

	pi.events.on("pi-hooks:unregister", (data) => {
		if (!data || typeof data !== "object") return;
		const source = (data as { source?: unknown }).source;
		if (typeof source !== "string") return;
		for (const [key, handler] of bus) {
			if (handler.source === source) bus.delete(key);
		}
	});

	// Signals that the bus exists so late-loading consumers can register.
	pi.events.emit("pi-hooks:ready", {});

	// ---------------------------------------------------------------------
	// Session lifecycle
	// ---------------------------------------------------------------------

	pi.on("session_start", async (event, ctx) => {
		// Project settings are merged once trust is established, so reload here.
		reload();
		const input: HookInput = {
			...baseInput("SessionStart", ctx),
			source: sessionStartSource(event.reason),
		};
		const outcome = await dispatch("SessionStart", input, ctx);
		if (outcome.additionalContext.length > 0 && ctx.hasUI) {
			ctx.ui.notify(outcome.additionalContext.join("\n"), "info");
		}
	});

	pi.on("session_shutdown", async (event, ctx) => {
		const input: HookInput = {
			...baseInput("SessionEnd", ctx),
			reason: sessionEndReason(event.reason),
		};
		await dispatch("SessionEnd", input, ctx, {
			signal: AbortSignal.timeout(SESSION_END_BUDGET_MS),
		});
	});

	// ---------------------------------------------------------------------
	// Prompt submission
	// ---------------------------------------------------------------------

	pi.on("input", async (event, ctx) => {
		const input: HookInput = {
			...baseInput("UserPromptSubmit", ctx),
			prompt: event.text,
		};
		const outcome = await dispatch("UserPromptSubmit", input, ctx);
		if (outcome.stop) {
			ctx.ui.notify(
				outcome.stopReason ?? "A UserPromptSubmit hook stopped this prompt.",
				"warning",
			);
			return { action: "handled" };
		}
		if (outcome.decision === "deny") {
			ctx.ui.notify(outcome.reason ?? "A hook denied this prompt.", "warning");
			return { action: "handled" };
		}
		if (outcome.additionalContext.length > 0) {
			return {
				action: "transform",
				text: `${event.text}\n\n<hook-context>\n${outcome.additionalContext.join("\n\n")}\n</hook-context>`,
			};
		}
		return undefined;
	});

	// ---------------------------------------------------------------------
	// Tool lifecycle
	// ---------------------------------------------------------------------

	pi.on("tool_call", async (event, ctx) => {
		const toolCall = event as ToolCallEvent;
		const input = toolInput(
			"PreToolUse",
			ctx,
			toolCall.toolName,
			toolCall.input as Record<string, unknown>,
			toolCall.toolCallId,
			{ parent_tool_use_id: toolCall.parentToolCallId ?? null },
		);
		const outcome = await dispatch("PreToolUse", input, ctx);

		if (outcome.stop) {
			return {
				block: true,
				reason: outcome.stopReason ?? "A PreToolUse hook stopped this run.",
			};
		}

		if (outcome.decision === "deny") {
			return {
				block: true,
				reason: outcome.reason ?? `A hook denied ${toolCall.toolName}.`,
			};
		}

		if (outcome.decision === "ask") {
			const reason = outcome.reason ?? `Allow ${toolCall.toolName}?`;
			const allowed = ctx.hasUI
				? await ctx.ui.confirm("Hook approval", reason)
				: false;
			if (!allowed) {
				return {
					block: true,
					reason: ctx.hasUI
						? `User declined: ${reason}`
						: "A hook requested approval, but no UI is available.",
				};
			}
		}

		if (outcome.updatedInput) {
			Object.assign(toolCall.input as Record<string, unknown>, outcome.updatedInput);
		}
		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		const toolResult = event as ToolResultEvent;
		const postEvent: HookEventName = toolResult.isError
			? "PostToolUseFailure"
			: "PostToolUse";
		const input: HookInput = {
			...toolInput(
				postEvent,
				ctx,
				toolResult.toolName,
				toolResult.input,
				toolResult.toolCallId,
			),
			tool_response: {
				content: toolResult.content,
				details: toolResult.details,
				is_error: toolResult.isError,
			},
			error: toolResult.isError
				? toolResult.content
						.filter((block) => block.type === "text")
						.map((block) => (block as { text: string }).text)
						.join("\n")
				: undefined,
		};
		const outcome = await dispatch(postEvent, input, ctx);

		// Synthesize file.changed from successful mutations.
		if (!toolResult.isError && (toolResult.toolName === "write" || toolResult.toolName === "edit")) {
			const path =
				typeof toolResult.input.file_path === "string"
					? toolResult.input.file_path
					: typeof toolResult.input.path === "string"
						? toolResult.input.path
						: undefined;
			if (path) {
				await dispatch(
					"FileChanged",
					{
						...baseInput("FileChanged", ctx),
						file_path: path,
						change_type: toolResult.toolName,
						tool_name: toolResult.toolName,
					},
					ctx,
				);
			}
		}

		const next: {
			content?: typeof toolResult.content;
			structuredContent?: undefined;
		} = {};
		const replacement = coerceContent(outcome.updatedToolOutput);
		if (replacement) {
			next.content = replacement.content;
			next.structuredContent = undefined;
		}
		if (outcome.additionalContext.length > 0) {
			next.content = [
				...(next.content ?? toolResult.content),
				contextBlock(outcome.additionalContext.join("\n\n")),
			];
		}
		return Object.keys(next).length > 0 ? next : undefined;
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		await dispatch(
			"ToolExecutionStart",
			{
				...baseInput("ToolExecutionStart", ctx),
				tool_name: event.toolName,
				tool_input: event.args,
				tool_use_id: event.toolCallId,
			},
			ctx,
		);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		await dispatch(
			"ToolExecutionEnd",
			{
				...baseInput("ToolExecutionEnd", ctx),
				tool_name: event.toolName,
				tool_use_id: event.toolCallId,
				is_error: event.isError,
			},
			ctx,
		);
	});

	// ---------------------------------------------------------------------
	// Agent and turn lifecycle (observe-only in v1)
	// ---------------------------------------------------------------------

	pi.on("agent_start", async (_event, ctx) => {
		await dispatch("AgentStart", baseInput("AgentStart", ctx), ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		await dispatch("AgentEnd", baseInput("AgentEnd", ctx), ctx);
	});

	pi.on("agent_settled", async (event, ctx) => {
		await dispatch("AgentSettled", {
			...baseInput("AgentSettled", ctx),
			aborted: event.aborted,
		}, ctx);
	});

	pi.on("turn_start", async (event, ctx) => {
		await dispatch("TurnStart", {
			...baseInput("TurnStart", ctx),
			turn_index: event.turnIndex,
		}, ctx);
	});

	pi.on("turn_end", async (event, ctx) => {
		await dispatch("TurnEnd", {
			...baseInput("TurnEnd", ctx),
			turn_index: event.turnIndex,
			tool_results: event.toolResults.map((result) => ({
				tool_use_id: result.toolCallId,
				tool_name: result.toolName,
				is_error: result.isError,
			})),
		}, ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		await dispatch("MessageEnd", {
			...baseInput("MessageEnd", ctx),
			message_role: event.message.role,
		}, ctx);
	});

	/**
	 * `Stop` fires before settlement. Blocking a stop would require a
	 * continuation prompt, which is a permissions-policy decision, not a hook
	 * side effect. v1 observes only.
	 */
	pi.on("agent_before_settle", async (_event, ctx) => {
		await dispatch("Stop", baseInput("Stop", ctx), ctx);
	});

	// ---------------------------------------------------------------------
	// Context and model
	// ---------------------------------------------------------------------

	pi.on("session_before_compact", async (event, ctx) => {
		const outcome = await dispatch(
			"PreCompact",
			{
				...baseInput("PreCompact", ctx),
				trigger: event.reason === "manual" ? "manual" : "auto",
			},
			ctx,
			{ signal: event.signal },
		);
		if (outcome.decision === "deny") {
			return { cancel: true };
		}
		return undefined;
	});

	pi.on("session_compact", async (event, ctx) => {
		await dispatch(
			"PostCompact",
			{
				...baseInput("PostCompact", ctx),
				trigger: event.reason === "manual" ? "manual" : "auto",
			},
			ctx,
		);
	});

	pi.on("session_compact_failed", async (event, ctx) => {
		await dispatch(
			"SessionCompactFailed",
			{
				...baseInput("SessionCompactFailed", ctx),
				trigger: event.reason === "manual" ? "manual" : "auto",
				error: event.errorMessage,
				aborted: event.aborted,
			},
			ctx,
		);
	});

	pi.on("model_select", async (event, ctx) => {
		await dispatch(
			"PostModelSwitch",
			{
				...baseInput("PostModelSwitch", ctx),
				model: `${event.model.provider}/${event.model.id}`,
				previous_model: event.previousModel
					? `${event.previousModel.provider}/${event.previousModel.id}`
					: null,
				source: event.source,
			},
			ctx,
		);
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		await dispatch("ThinkingLevelSelect", {
			...baseInput("ThinkingLevelSelect", ctx),
			level: event.level,
			previous_level: event.previousLevel,
		}, ctx);
	});

	pi.on("user_bash", async (event, ctx) => {
		await dispatch(
			"UserBash",
			{
				...baseInput("UserBash", ctx),
				command: event.command,
				exclude_from_context: event.excludeFromContext,
			},
			ctx,
		);
		return undefined;
	});

	// ---------------------------------------------------------------------
	// Commands
	// ---------------------------------------------------------------------

	pi.registerCommand("hooks", {
		description: "List, reload, or validate the configured hooks",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const sub = args.trim().toLowerCase();
			if (sub === "reload") {
				const next = reload();
				ctx.ui.notify(
					`Reloaded ${next.hooks.length} hook${next.hooks.length === 1 ? "" : "s"}${next.warnings.length ? ` with ${next.warnings.length} warning(s)` : ""}.`,
					next.warnings.length ? "warning" : "info",
				);
				return;
			}
			if (sub === "validate") {
				const next = reload();
				if (next.warnings.length === 0) {
					ctx.ui.notify(`Valid: ${next.hooks.length} hook(s).`, "info");
					return;
				}
				ctx.ui.notify(next.warnings.join("\n"), "warning");
				return;
			}
			if (sub === "debug") {
				ctx.ui.notify(
					`Debug ${DEBUG ? "is on" : "is off"}. Set PI_HOOKS_DEBUG=1 and restart pi to see handler logs.`,
					"info",
				);
				return;
			}

			const next = reload();
			const lines = describeHooks(next.hooks, bus.size);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

/** `/hooks` output: one line per hook, grouped by event. */
export function describeHooks(hooks: NormalizedHook[], busCount: number): string[] {
	const lines: string[] = [];
	const byEvent = new Map<string, NormalizedHook[]>();
	for (const hook of hooks) {
		const list = byEvent.get(hook.event) ?? [];
		list.push(hook);
		byEvent.set(hook.event, list);
	}
	for (const [event, list] of [...byEvent.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		lines.push(`${event}`);
		for (const hook of list) {
			const handler = hook.handler;
			const detail =
				handler.type === "command"
					? handler.command
					: handler.type === "http"
						? handler.url
						: handler.type === "prompt"
							? (handler.model ?? "session model")
							: "agent";
			const matcher = hook.matcher ? ` [${hook.matcher}]` : "";
			const flags = handler.async ? " async" : handler.once ? " once" : "";
			lines.push(`  ${handler.type}${matcher}: ${detail}${flags}`);
		}
	}
	if (busCount > 0) lines.push(`in-process: ${busCount} handler(s)`);
	if (lines.length === 0) {
		lines.push("No hooks configured. Add a \"hooks\" key to settings.json.");
	}
	return lines;
}
