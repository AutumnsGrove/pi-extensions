/**
 * permissions — a rules + classifier permission model for pi.
 *
 * Pipeline for every tool call:
 *   1. an explicit session grant
 *   2. deny / ask / allow rules (bash is split into segments)
 *   3. the active mode:
 *        default     — ask for anything risky
 *        acceptEdits — auto-allow edits inside the project
 *        auto        — classifier (JEV, LLM fallback), fail closed
 *        dontAsk     — deny anything unmatched, never prompt
 *        bypass      — allow unless a deny rule matched
 *   4. an interactive dialog, or a deny when no UI is available
 *
 * The extension registers a `PreToolUse` handler on the hooks bus. If the
 * hooks engine is not loaded it falls back to pi's `tool_call` event, so it
 * works standalone without double-gating.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { callKey, evaluateRules, ruleForCall, stableStringify } from "./rules.ts";
import { describeConfig, normalizePermissionsConfig, readPermissionsConfig } from "./config.ts";
import { VerdictCache } from "./cache.ts";
import { Grants } from "./grants.ts";
import { modeInfo, modeStatus, nextMode, parseMode } from "./modes.ts";
import { appendDecision, formatRecord, readDecisions, redactRecord, redactValue } from "./log.ts";
import { createReviewer } from "./verdict/index.ts";
import type {
	Decision,
	DecisionRecord,
	GateResult,
	PermissionMode,
	PermissionsConfig,
	ReviewState,
	RuleVerdict,
	Verdict,
} from "./types.ts";
import type { HookInput } from "../hooks/types.ts";

const DEBUG = process.env.PI_PERMISSIONS_DEBUG === "1";

function debug(message: string): void {
	if (DEBUG) console.error(`[permissions] ${message}`);
}

const SHORTCUTS = ["alt+m", "ctrl+shift+m"] as const;

export default function permissions(pi: ExtensionAPI): void {
	// Settings are not readable during extension loading; `session_start`
	// performs the first real load.
	let loaded = normalizePermissionsConfig(undefined);
	let mode: PermissionMode = loaded.config.mode;
	const cache = new VerdictCache(true);
	const grants = new Grants();
	let userIntent: string | undefined;
	let recentCommands: string[] = [];
	let hooksReady = Boolean((globalThis as Record<string, unknown>).__piHooksReady);
	let statusCtx: ExtensionContext | undefined;

	const reload = (): void => {
		try {
			loaded = normalizePermissionsConfig(
				readPermissionsConfig(pi.getSettings()),
				"settings.json",
			);
		} catch (error) {
			debug(`could not read settings: ${(error as Error).message}`);
		}
	};

	const setStatus = (ctx: ExtensionContext): void => {
		statusCtx = ctx;
		if (!ctx.hasUI) return;
		try {
			ctx.ui.setStatus("permissions", modeStatus(mode));
		} catch {
			// Cosmetic only.
		}
	};

	const setMode = (next: PermissionMode, ctx: ExtensionContext): void => {
		const previous = mode;
		mode = next;
		setStatus(ctx);
		debug(`mode ${previous} -> ${next}`);
		if (ctx.hasUI) {
			const info = modeInfo(next);
			ctx.ui.notify(`${info.icon} Permission mode: ${info.label} — ${info.description}`, "info");
		}
	};

	// ------------------------------------------------------------------
	// Risk classification
	// ------------------------------------------------------------------

	const isRisky = (tool: string): boolean => {
		if (loaded.config.reviewTools.includes(tool)) return true;
		const info = pi.getAllTools().find((entry) => entry.name === tool);
		if (!info) return tool.startsWith("mcp__");
		const hints = info.annotations;
		if (hints?.readOnlyHint === true) return false;
		if (hints?.destructiveHint === true) return true;
		if (hints?.openWorldHint === true) return true;
		// Missing hints: MCP's default is "not read-only".
		return true;
	};

	const insideCwd = (ctx: ExtensionContext, input: Record<string, unknown>): boolean => {
		const path =
			typeof input.file_path === "string"
				? input.file_path
				: typeof input.path === "string"
					? input.path
					: undefined;
		if (!path) return false;
		const root = resolve(ctx.cwd);
		const target = isAbsolute(path) ? resolve(path) : resolve(root, path);
		return target === root || target.startsWith(`${root}${sep}`);
	};

	// ------------------------------------------------------------------
	// Reviewing
	// ------------------------------------------------------------------

	const review = async (
		state: ReviewState,
		ctx: ExtensionContext,
		key: string,
	): Promise<{ verdict?: Verdict; cached: boolean }> => {
		if (loaded.config.reviewer.cache) {
			const hit = cache.get(key);
			if (hit) return { verdict: hit, cached: true };
		}
		const reviewer = createReviewer(ctx, loaded.config.reviewer);
		if (!reviewer) return { cached: false };
		const verdict = await reviewer.review(state, ctx.signal);
		cache.set(key, verdict);
		return { verdict, cached: false };
	};

	// ------------------------------------------------------------------
	// Human approval
	// ------------------------------------------------------------------

	const askHuman = async (
		ctx: ExtensionContext,
		tool: string,
		input: Record<string, unknown>,
		reason: string | undefined,
		key: string,
	): Promise<GateResult> => {
		if (!ctx.hasUI) {
			return {
				decision: "deny",
				source: "mode",
				reason: `${reason ?? "permission required"}, and no UI is available to ask`,
			};
		}
		const detail = describeCall(tool, input);
		const title = `${reason ?? "Permission required"} · ${detail}`.slice(0, 180);
		pi.events.emit("pi-permissions:prompt", { tool, reason: reason ?? "permission required" });
		let choice: string | undefined;
		try {
			choice = await ctx.ui.select(
				title,
				[
					"Allow once",
					"Allow for this session",
					"Always allow (write a rule)",
					"Deny",
				],
				{},
			);
		} catch (error) {
			debug(`dialog failed: ${(error as Error).message}`);
			choice = undefined;
		}
		if (!choice || choice === "Deny") {
			return {
				decision: "deny",
				source: "user",
				reason: "denied at the permission prompt",
				userChoice: "deny",
			};
		}
		const rule = ruleForCall(tool, input);
		if (choice === "Allow once") {
			return {
				decision: "allow",
				source: "user",
				reason: "allowed once",
				userChoice: "allow-once",
			};
		}
		if (choice === "Allow for this session") {
			grants.add(key, rule ?? `${tool}`);
			return {
				decision: "allow",
				source: "user",
				reason: "allowed for this session",
				grant: rule ?? `${tool}`,
				userChoice: "allow-session",
			};
		}
		// Always allow.
		if (rule) {
			grants.add(key, rule);
			const persisted = await persistRule(ctx, rule);
			return {
				decision: "allow",
				source: "user",
				reason: persisted
					? `always allowed (${rule})`
					: `allowed for this session (could not persist ${rule})`,
				grant: rule,
				userChoice: persisted ? "always" : "allow-session",
			};
		}
		grants.add(key, tool);
		return {
			decision: "allow",
			source: "user",
			reason: "allowed for this session",
			grant: tool,
			userChoice: "allow-session",
		};
	};

	const persistRule = async (ctx: ExtensionContext, rule: string): Promise<boolean> => {
		if (!loaded.config.persistGrants) return false;
		if (!ctx.isProjectTrusted()) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					"Not writing the rule: project settings require a trusted project.",
					"warning",
				);
			}
			return false;
		}
		const path = join(ctx.cwd, ".pi", "settings.json");
		try {
			let settings: Record<string, unknown> = {};
			try {
				const text = await readFile(path, "utf8");
				const parsed = JSON.parse(text);
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					settings = parsed as Record<string, unknown>;
				}
			} catch {
				// Missing or invalid settings: start from a clean object.
			}
			const permissionsRaw =
				settings.permissions && typeof settings.permissions === "object"
					? (settings.permissions as Record<string, unknown>)
					: {};
			const allow = Array.isArray(permissionsRaw.allow)
				? permissionsRaw.allow.filter((entry): entry is string => typeof entry === "string")
				: [];
			if (!allow.includes(rule)) allow.push(rule);
			settings.permissions = { ...permissionsRaw, allow };
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
			loaded.config.allow.push({ rule, source: "project" });
			return true;
		} catch (error) {
			debug(`could not persist rule: ${(error as Error).message}`);
			if (ctx.hasUI) {
				ctx.ui.notify(`Could not write ${rule} to .pi/settings.json`, "warning");
			}
			return false;
		}
	};

	// ------------------------------------------------------------------
	// The gate
	// ------------------------------------------------------------------

	const finish = async (
		ctx: ExtensionContext,
		input: HookInput,
		result: GateResult,
		started: number,
		rule?: RuleVerdict,
		reviewer?: Verdict,
		userChoice?: string,
	): Promise<GateResult> => {
		const cfg = loaded.config;
		const record: DecisionRecord = {
			v: 1,
			ts: new Date().toISOString(),
			session_id: ctx.sessionManager.getSessionId(),
			cwd: ctx.cwd,
			mode,
			tool: String(input.tool_name ?? "unknown"),
			input: (input.tool_input as Record<string, unknown>) ?? {},
			rule: rule ? { ...rule, decision: rule.decision } : undefined,
			reviewer: reviewer
				? { ...reviewer, durationMs: reviewer.durationMs, cached: reviewer.cached }
				: undefined,
			decision: result.decision,
			source: result.source,
			reason: result.reason,
			grant: result.grant,
			user_choice: userChoice ?? result.userChoice,
			cached: reviewer?.cached,
			latency_ms: Date.now() - started,
		};
		if (cfg.log.enabled) {
			await appendDecision(ctx, record, cfg.log.fullState).catch((error) => {
				debug(`log write failed: ${(error as Error).message}`);
			});
			pi.appendEntry("permissions-decision", {
				tool: record.tool,
				decision: record.decision,
				source: record.source,
				reason: record.reason,
				mode: record.mode,
				ts: record.ts,
			});
		}
		debug(formatRecord(redactRecord(record, false)));
		return {
			...result,
			rule,
			reviewer,
			userChoice: userChoice ?? result.userChoice,
		};
	};

	const gate = async (input: HookInput, ctx: ExtensionContext): Promise<GateResult> => {
		const started = Date.now();
		const tool = typeof input.tool_name === "string" ? input.tool_name : "";
		const toolInput =
			input.tool_input && typeof input.tool_input === "object"
				? (input.tool_input as Record<string, unknown>)
				: {};
		if (!tool) return { decision: "allow", source: "mode", reason: "no tool name" };

		const cfg = loaded.config;
		const key = callKey(tool, toolInput, input.cwd);

		// 1. A prior "allow for this session".
		const grant = grants.get(key);
		if (grant) {
			return finish(ctx, input, {
				decision: "allow",
				source: "grant",
				reason: `session grant: ${grant.rule}`,
				grant: grant.rule,
			}, started);
		}

		// 2. Rules.
		const rule = evaluateRules(tool, toolInput, {
			allow: cfg.allow,
			ask: cfg.ask,
			deny: cfg.deny,
		});
		if (rule.decision === "deny") {
			return finish(ctx, input, {
				decision: "deny",
				source: "rule",
				reason: rule.reasons[0] ?? `denied by ${rule.matched[0] ?? "rule"}`,
			}, started, rule);
		}
		if (rule.decision === "allow") {
			return finish(ctx, input, {
				decision: "allow",
				source: "rule",
				reason: rule.reasons[0] ?? "allowed by rule",
			}, started, rule);
		}

		const risky = isRisky(tool);

		// 3a. A rule that asks still goes to a human, never to the classifier.
		if (rule.decision === "ask") {
			const result = await askHuman(
				ctx,
				tool,
				toolInput,
				rule.reasons[0] ?? "an ask rule matched",
				key,
			);
			return finish(ctx, input, result, started, rule);
		}

		// 3b. Read-only tools with no rule are harmless in every mode.
		if (!risky) {
			return finish(ctx, input, {
				decision: "allow",
				source: "mode",
				reason: "read-only tool",
			}, started, rule);
		}

		switch (mode) {
			case "bypass":
				return finish(ctx, input, {
					decision: "allow",
					source: "mode",
					reason: "bypass mode",
				}, started, rule);

			case "dontAsk":
				return finish(ctx, input, {
					decision: "deny",
					source: "mode",
					reason: "no matching rule in dontAsk mode",
				}, started, rule);

			case "acceptEdits":
				if ((tool === "write" || tool === "edit") && insideCwd(ctx, toolInput)) {
					return finish(ctx, input, {
						decision: "allow",
						source: "mode",
						reason: "acceptEdits: edit inside the project",
					}, started, rule);
				}
				break;

			case "auto": {
				const state: ReviewState = {
					tool,
					input: toolInput,
					cwd: ctx.cwd,
					mode,
					userIntent,
					recentCommands,
				};
				const { verdict, cached } = await review(state, ctx, key);
				if (!verdict) {
					const result = await askHuman(
						ctx,
						tool,
						toolInput,
						"auto mode needs a reviewer, but none is configured",
						key,
					);
					return finish(ctx, input, result, started, rule);
				}
				if (verdict.error && verdict.decision === "deny") {
					return finish(ctx, input, {
						decision: "deny",
						source: "reviewer",
						reason: `reviewer unavailable: ${verdict.reasons[0] ?? "error"}`,
					}, started, rule, { ...verdict, cached });
				}
				if (verdict.decision === "deny") {
					return finish(ctx, input, {
						decision: "deny",
						source: "reviewer",
						reason: verdict.reasons[0] ?? "reviewer denied the call",
					}, started, rule, { ...verdict, cached });
				}
				if (verdict.decision === "allow") {
					return finish(ctx, input, {
						decision: "allow",
						source: cached ? "cache" : "reviewer",
						reason: verdict.reasons[0] ?? "reviewer allowed the call",
					}, started, rule, { ...verdict, cached });
				}
				const result = await askHuman(
					ctx,
					tool,
					toolInput,
					verdict.reasons[0] ?? "the reviewer was unsure",
					key,
				);
				return finish(ctx, input, result, started, rule, { ...verdict, cached });
			}

			case "default":
				break;
		}

		// 3c. Default behaviour: ask.
		const result = await askHuman(
			ctx,
			tool,
			toolInput,
			"this action is not covered by a rule",
			key,
		);
		return finish(ctx, input, result, started, rule);
	};

	// ------------------------------------------------------------------
	// Hook bus + standalone fallback
	// ------------------------------------------------------------------

	const registerBus = (): void => {
		hooksReady = true;
		pi.events.emit("pi-hooks:register", {
			event: "PreToolUse",
			source: "permissions",
			handler: async (input: HookInput, ctx: ExtensionContext) => {
				const result = await gate(input, ctx);
				return {
					decision: result.decision,
					reason: result.reason,
				};
			},
		});
	};

	if (hooksReady) {
		registerBus();
	} else {
		pi.events.on("pi-hooks:ready", () => registerBus());
	}

	// Standalone fallback. It stays inert when the hooks engine is present.
	pi.on("tool_call", async (event, ctx) => {
		if (hooksReady) return undefined;
		const toolCall = event as ToolCallEvent;
		const input: HookInput = {
			session_id: ctx.sessionManager.getSessionId(),
			transcript_path: ctx.sessionManager.getSessionFile() ?? null,
			cwd: ctx.cwd,
			hook_event_name: "PreToolUse",
			tool_name: toolCall.toolName,
			tool_input: toolCall.input as Record<string, unknown>,
			tool_use_id: toolCall.toolCallId,
		};
		const result = await gate(input, ctx);
		return result.decision === "deny"
			? { block: true, reason: result.reason ?? "denied by permissions" }
			: undefined;
	});

	// ------------------------------------------------------------------
	// Session state
	// ------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		reload();
		const flagMode = pi.getFlag("permission-mode");
		const yolo = pi.getFlag("yolo");
		if (yolo === true) mode = "bypass";
		else if (typeof flagMode === "string") mode = parseMode(flagMode) ?? mode;
		else mode = loaded.config.mode;
		userIntent = undefined;
		recentCommands = [];
		cache.clear();
		grants.clear();
		setStatus(ctx);
		if (!hooksReady) {
			hooksReady = Boolean((globalThis as Record<string, unknown>).__piHooksReady);
			if (hooksReady) registerBus();
		}
		for (const warning of loaded.warnings) debug(warning);
	});

	pi.on("input", async (event) => {
		userIntent = event.text.slice(0, 2000);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) {
			try {
				ctx.ui.setStatus("permissions", undefined);
			} catch {
				// ignore
			}
		}
	});

	// ------------------------------------------------------------------
	// Mode switching
	// ------------------------------------------------------------------

	for (const shortcut of SHORTCUTS) {
		pi.registerShortcut(shortcut, {
			description: "Cycle permission mode",
			handler: async (ctx) => {
				setMode(nextMode(mode), ctx);
			},
		});
	}

	pi.registerShortcut("alt+shift+m", {
		description: "Show the current permission mode",
		handler: async (ctx) => {
			const info = modeInfo(mode);
			ctx.ui.notify(
				`${info.icon} ${info.label} — ${info.description}\n` +
					`Shortcuts: ${SHORTCUTS.join(", ")}. /permissions for details.`,
				"info",
			);
		},
	});

	pi.registerFlag("permission-mode", {
		description: "Start in a permission mode: default, acceptEdits, auto, dontAsk, bypass",
		type: "string",
	});
	pi.registerFlag("yolo", {
		description: "Start in bypass permission mode",
		type: "boolean",
	});

	// ------------------------------------------------------------------
	// Commands
	// ------------------------------------------------------------------

	pi.registerCommand("permissions", {
		description: "Show or change the permission mode, rules, and recent decisions",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const trimmed = args.trim();
			const [sub, ...rest] = trimmed.split(/\s+/);
			const tail = rest.join(" ").trim();

			if (!trimmed) {
				const lines = [
					`${modeInfo(mode).icon} ${modeInfo(mode).label} — ${modeInfo(mode).description}`,
					...describeConfig({ ...loaded.config, mode }),
					`Session grants: ${grants.size} · cached verdicts: ${cache.size}`,
					"",
					`/permissions mode <${["default", "acceptEdits", "auto", "dontAsk", "bypass"].join("|")}>`,
					"/permissions allow|ask|deny <rule>",
					"/permissions review <jev|llm|off>",
					"/permissions log [n] · /permissions clear · /permissions test <tool> <json>",
				];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (sub === "mode") {
				const next = parseMode(tail);
				if (!next) {
					ctx.ui.notify(`Unknown mode "${tail}".`, "warning");
					return;
				}
				setMode(next, ctx);
				return;
			}

			if (sub === "allow" || sub === "ask" || sub === "deny") {
				if (!tail) {
					ctx.ui.notify(`Usage: /permissions ${sub} <rule>`, "warning");
					return;
				}
				const key = sub === "allow" ? "allow" : sub === "ask" ? "ask" : "deny";
				const ok = await persistRule(ctx, tail);
				if (!ok) {
					loaded.config[key].push({ rule: tail, source: "global" });
				}
				ctx.ui.notify(
					`${ok ? "Saved" : "Added for this session"}: ${tail} → ${sub}`,
					"info",
				);
				return;
			}

			if (sub === "review") {
				if (tail === "off" || tail === "jev" || tail === "llm") {
					loaded.config.reviewer.provider = tail;
					ctx.ui.notify(`Reviewer: ${tail}`, "info");
					return;
				}
				ctx.ui.notify("Usage: /permissions review <jev|llm|off>", "warning");
				return;
			}

			if (sub === "log") {
				const limit = Number.parseInt(tail || "10", 10);
				const records = await readDecisions(ctx.cwd, Number.isFinite(limit) ? limit : 10);
				if (records.length === 0) {
					ctx.ui.notify("No permission decisions logged yet.", "info");
					return;
				}
				ctx.ui.notify(records.map(formatRecord).join("\n"), "info");
				return;
			}

			if (sub === "clear") {
				grants.clear();
				cache.clear();
				ctx.ui.notify("Cleared session grants and cached verdicts.", "info");
				return;
			}

			if (sub === "test") {
				const [tool, json] = splitOnce(tail, " ");
				if (!tool) {
					ctx.ui.notify("Usage: /permissions test <tool> '<json>'", "warning");
					return;
				}
				let input: Record<string, unknown> = {};
				if (json) {
					const unquoted =
						(json.startsWith("'") && json.endsWith("'")) ||
						(json.startsWith('"') && json.endsWith('"'))
							? json.slice(1, -1)
							: json;
					try {
						const parsed = JSON.parse(unquoted);
						if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
							input = parsed as Record<string, unknown>;
						}
					} catch (error) {
						ctx.ui.notify(`Invalid JSON: ${(error as Error).message}`, "warning");
						return;
					}
				}
				const rule = evaluateRules(tool, input, loaded.config);
				const risky = isRisky(tool);
				ctx.ui.notify(
					[
						`tool: ${tool}${risky ? " (risky)" : " (read-only)"}`,
						`rule: ${rule.decision}${rule.matched.length ? ` (${rule.matched.join(", ")})` : ""}`,
						`mode: ${mode}`,
					].join("\n"),
					"info",
				);
				return;
			}

			ctx.ui.notify(`Unknown subcommand "${sub}".`, "warning");
		},
	});
}

function describeCall(tool: string, input: Record<string, unknown>): string {
	if (tool === "bash" || tool === "powershell") {
		return String(redactValue(String(input.command ?? ""))).slice(0, 120);
	}
	const subject =
		typeof input.file_path === "string"
			? input.file_path
			: typeof input.path === "string"
				? input.path
				: typeof input.pattern === "string"
					? input.pattern
					: stableStringify(input).slice(0, 80);
	return `${tool} ${subject}`.slice(0, 120);
}

function splitOnce(value: string, separator: string): [string, string] {
	const index = value.indexOf(separator);
	if (index === -1) return [value, ""];
	return [value.slice(0, index), value.slice(index + separator.length)];
}
