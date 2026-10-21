/**
 * Event naming and matching.
 *
 * Config authors get Claude's names. Pi's own event names, and a few obvious
 * snake_case spellings, are accepted as aliases so a hook file can be written
 * either way.
 */

import {
	HOOK_EVENTS,
	SUPPORTED_EVENTS,
	type HookEventName,
	type PermissionRule,
} from "./types.ts";

const ALIASES: Record<string, HookEventName> = {
	// Claude names, normalized
	pre_tool_use: "PreToolUse",
	post_tool_use: "PostToolUse",
	post_tool_use_failure: "PostToolUseFailure",
	post_tool_batch: "PostToolBatch",
	permission_request: "PermissionRequest",
	permission_denied: "PermissionDenied",
	user_prompt_submit: "UserPromptSubmit",
	user_prompt_expansion: "UserPromptExpansion",
	session_start: "SessionStart",
	session_end: "SessionEnd",
	session_shutdown: "SessionEnd",
	pre_compact: "PreCompact",
	post_compact: "PostCompact",
	pre_model_switch: "PreModelSwitch",
	post_model_switch: "PostModelSwitch",
	subagent_start: "SubagentStart",
	subagent_stop: "SubagentStop",
	task_created: "TaskCreated",
	task_completed: "TaskCompleted",
	file_changed: "FileChanged",
	config_change: "ConfigChange",
	cwd_changed: "CwdChanged",
	directory_added: "DirectoryAdded",
	instructions_loaded: "InstructionsLoaded",
	worktree_create: "WorktreeCreate",
	worktree_remove: "WorktreeRemove",
	message_display: "MessageDisplay",
	stop_failure: "StopFailure",
	elicitation_result: "ElicitationResult",

	// Pi event names
	tool_call: "PreToolUse",
	tool_result: "PostToolUse",
	input: "UserPromptSubmit",
	before_agent_start: "UserPromptSubmit",
	agent_before_settle: "Stop",
	agent_settled: "AgentSettled",
	agent_start: "AgentStart",
	agent_end: "AgentEnd",
	turn_start: "TurnStart",
	turn_end: "TurnEnd",
	message_end: "MessageEnd",
	tool_execution_start: "ToolExecutionStart",
	tool_execution_end: "ToolExecutionEnd",
	session_before_compact: "PreCompact",
	session_compact: "PostCompact",
	session_compact_failed: "SessionCompactFailed",
	model_select: "PostModelSwitch",
	thinking_level_select: "ThinkingLevelSelect",
	user_bash: "UserBash",
	permission_prompt: "Notification",
	notification: "Notification",
	idle_prompt: "Notification",
};

const CANONICAL = new Map<string, HookEventName>();
for (const name of HOOK_EVENTS) CANONICAL.set(name.toLowerCase(), name);

/** Resolve a config key to a canonical event name, or `undefined`. */
export function canonicalEvent(name: string): HookEventName | undefined {
	const direct = CANONICAL.get(name.toLowerCase());
	if (direct) return direct;
	return ALIASES[name.toLowerCase()];
}

export function isSupported(event: HookEventName): boolean {
	return SUPPORTED_EVENTS.includes(event);
}

const EXACT_MATCHER = /^[A-Za-z0-9_\- ,|]+$/;

const TOOL_EVENTS = new Set<HookEventName>([
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
	"PermissionRequest",
	"PermissionDenied",
	"ToolExecutionStart",
	"ToolExecutionEnd",
]);

/** Tool names differ in case between Claude (`Bash`) and pi (`bash`). */
export function isToolEvent(event: HookEventName): boolean {
	return TOOL_EVENTS.has(event);
}

/**
 * Match a matcher string against a value.
 *
 * Claude semantics: omitted, `*`, or `""` matches all; a string made only of
 * letters, digits, `_`, `-`, space, `,`, and `|` is an exact list separated by
 * `|` or `,`; anything else is an unanchored regular expression.
 */
export function matchesMatcher(
	matcher: string | undefined,
	value: string,
	caseInsensitive = false,
): boolean {
	if (matcher === undefined) return true;
	const trimmed = matcher.trim();
	if (trimmed === "" || trimmed === "*") return true;
	if (EXACT_MATCHER.test(trimmed)) {
		const wanted = trimmed
			.split(/[|,]/)
			.map((part) => part.trim())
			.filter(Boolean);
		const actual = caseInsensitive ? value.toLowerCase() : value;
		return wanted.some((part) =>
			caseInsensitive ? part.toLowerCase() === actual : part === actual,
		);
	}
	try {
		return new RegExp(trimmed, caseInsensitive ? "i" : undefined).test(value);
	} catch {
		return false;
	}
}

/**
 * Parse a Claude permission rule.
 *
 * Accepts `Bash`, `Bash(*)`, `Bash(git *)`, `Edit(*.ts)`, and the MCP wildcard
 * form `mcp__server__tool`. Returns `undefined` when the rule is malformed.
 */
export function parsePermissionRule(rule: string): PermissionRule | undefined {
	const trimmed = rule.trim();
	if (trimmed === "") return undefined;
	const open = trimmed.indexOf("(");
	if (open === -1) {
		return { tool: trimmed };
	}
	if (!trimmed.endsWith(")")) return undefined;
	const tool = trimmed.slice(0, open).trim();
	const pattern = trimmed.slice(open + 1, -1);
	if (!tool) return undefined;
	return { tool, pattern: pattern === "" ? undefined : pattern };
}

/** Escape everything except `*` and `?`, then translate the wildcards. */
export function globToRegExp(glob: string): RegExp {
	let out = "";
	for (const char of glob) {
		if (char === "*") out += ".*";
		else if (char === "?") out += ".";
		else out += char.replace(/[\\^$.[\]{}()+|/]/g, "\\$&");
	}
	return new RegExp(`^${out}$`);
}

/** The string a permission rule should test for a given tool call. */
export function ruleSubject(toolName: string, input: Record<string, unknown>): string {
	const pick = (...keys: string[]): string | undefined => {
		for (const key of keys) {
			const value = input[key];
			if (typeof value === "string") return value;
		}
		return undefined;
	};

	switch (toolName) {
		case "bash":
		case "powershell":
			return pick("command") ?? "";
		case "read":
		case "write":
		case "edit":
		case "ls":
			return pick("file_path", "path") ?? "";
		case "grep":
		case "find":
			return pick("pattern", "path") ?? "";
		default:
			try {
				return JSON.stringify(input);
			} catch {
				return "";
			}
	}
}

/** Does a tool call satisfy a parsed rule? */
export function matchesPermissionRule(
	rule: PermissionRule,
	toolName: string,
	input: Record<string, unknown>,
): boolean {
	if (rule.tool !== "*" && rule.tool.toLowerCase() !== toolName.toLowerCase()) {
		const mcp = rule.tool.startsWith("mcp__") ? rule.tool : undefined;
		if (!mcp || !globToRegExp(mcp).test(toolName)) return false;
	}
	if (rule.pattern === undefined || rule.pattern === "*") return true;
	return globToRegExp(rule.pattern).test(ruleSubject(toolName, input));
}

/** The value an event's matcher filters on. */
export function matcherSubject(
	event: HookEventName,
	input: Record<string, unknown>,
): string | undefined {
	switch (event) {
		case "PreToolUse":
		case "PostToolUse":
		case "PostToolUseFailure":
		case "PermissionRequest":
		case "PermissionDenied":
		case "ToolExecutionStart":
		case "ToolExecutionEnd":
			return typeof input.tool_name === "string" ? input.tool_name : undefined;
		case "SessionStart":
			return typeof input.source === "string" ? input.source : undefined;
		case "SessionEnd":
			return typeof input.reason === "string" ? input.reason : undefined;
		case "PreCompact":
		case "PostCompact":
			return typeof input.trigger === "string" ? input.trigger : undefined;
		case "PostModelSwitch":
			return typeof input.model === "string" ? input.model : undefined;
		case "FileChanged":
			return typeof input.file_path === "string" ? input.file_path : undefined;
		case "Notification":
			return typeof input.notification_type === "string"
				? input.notification_type
				: undefined;
		case "UserBash":
			return typeof input.command === "string" ? input.command : undefined;
		default:
			return undefined;
	}
}
