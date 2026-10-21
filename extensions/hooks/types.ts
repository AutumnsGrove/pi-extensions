/**
 * Shared shapes for the hooks engine.
 *
 * The config-facing event names are Claude Code's (`PreToolUse`, `SessionStart`,
 * …). Pi's own snake_case event names are accepted as aliases; see `events.ts`.
 * Everything that crosses the process boundary (stdin JSON, HTTP bodies) uses
 * the Claude-compatible snake_case field names so existing hook scripts keep
 * working.
 */

/** Every event the engine knows about, including ones not wired yet. */
export const HOOK_EVENTS = [
	// Session
	"SessionStart",
	"SessionEnd",
	"Setup",
	// Prompt
	"UserPromptSubmit",
	"UserPromptExpansion",
	// Tool
	"PreToolUse",
	"PermissionRequest",
	"PermissionDenied",
	"PostToolUse",
	"PostToolUseFailure",
	"PostToolBatch",
	// Agent / turn
	"Stop",
	"StopFailure",
	"SubagentStart",
	"SubagentStop",
	"TaskCreated",
	"TaskCompleted",
	// Display
	"Notification",
	"MessageDisplay",
	"Elicitation",
	"ElicitationResult",
	// Config / environment
	"ConfigChange",
	"CwdChanged",
	"DirectoryAdded",
	"FileChanged",
	"InstructionsLoaded",
	// Worktree
	"WorktreeCreate",
	"WorktreeRemove",
	// Context / model
	"PreCompact",
	"PostCompact",
	"PreModelSwitch",
	"PostModelSwitch",
	// Pi-native events without a Claude counterpart
	"UserBash",
	"TurnStart",
	"TurnEnd",
	"AgentStart",
	"AgentEnd",
	"AgentSettled",
	"MessageEnd",
	"ToolExecutionStart",
	"ToolExecutionEnd",
	"SessionCompactFailed",
	"ThinkingLevelSelect",
] as const;

export type HookEventName = (typeof HOOK_EVENTS)[number];

/**
 * Events v1 actually dispatches. A config may mention others; they load with a
 * warning instead of silently doing nothing.
 */
export const SUPPORTED_EVENTS: readonly HookEventName[] = [
	"SessionStart",
	"SessionEnd",
	"UserPromptSubmit",
	"PreToolUse",
	"PermissionRequest",
	"PermissionDenied",
	"PostToolUse",
	"PostToolUseFailure",
	"Stop",
	"PreCompact",
	"PostCompact",
	"PostModelSwitch",
	"FileChanged",
	"UserBash",
	"TurnStart",
	"TurnEnd",
	"AgentStart",
	"AgentEnd",
	"AgentSettled",
	"MessageEnd",
	"ToolExecutionStart",
	"ToolExecutionEnd",
	"SessionCompactFailed",
	"ThinkingLevelSelect",
];

export type HookHandlerType = "command" | "http" | "prompt" | "agent";

/** Claude's decision vocabulary. `defer` folds into `ask` for pi. */
export type HookDecision = "allow" | "deny" | "ask";

/** A permission rule, e.g. `Bash(git *)` or `Edit(*.ts)`. */
export interface PermissionRule {
	tool: string;
	pattern?: string;
}

interface BaseHandlerConfig {
	/** Only run when the tool call matches this permission rule. Tool events only. */
	if?: string;
	/** Seconds. Defaults follow Claude: 600 command/http, 30 prompt, 60 agent. */
	timeout?: number;
	/** Run in the background; the decision is discarded. */
	async?: boolean;
	/** Run in the background, and surface exit code 2 as a system reminder. */
	asyncRewake?: boolean;
	/** Remove after the first successful run. Honored for the current session. */
	once?: boolean;
	/** Replaces the spinner text while the hook runs. */
	statusMessage?: string;
	/** `block` turns a crash, timeout, or non-zero exit into a deny. */
	onFailure?: "continue" | "block";
}

export interface CommandHandlerConfig extends BaseHandlerConfig {
	type: "command";
	/** Shell command, or the executable when `args` is present. */
	command: string;
	/** Presence switches to exec form: no shell, each arg passed verbatim. */
	args?: string[];
	shell?: "bash" | "powershell";
}

export interface HttpHandlerConfig extends BaseHandlerConfig {
	type: "http";
	url: string;
	headers?: Record<string, string>;
	allowedEnvVars?: string[];
}

export interface PromptHandlerConfig extends BaseHandlerConfig {
	type: "prompt";
	prompt: string;
	/** `provider/model` or a bare model id on the session's provider. */
	model?: string;
}

export interface AgentHandlerConfig extends BaseHandlerConfig {
	type: "agent";
	prompt: string;
	model?: string;
}

export type HookHandlerConfig =
	| CommandHandlerConfig
	| HttpHandlerConfig
	| PromptHandlerConfig
	| AgentHandlerConfig;

export interface HookMatcherGroup {
	/**
	 * Claude matcher semantics: omitted/`*`/`""` matches everything; a string of
	 * only letters, digits, `_`, `-`, space, `,`, `|` is an exact list; anything
	 * else is an unanchored JavaScript regular expression.
	 */
	matcher?: string;
	hooks: HookHandlerConfig[];
}

/** The `"hooks"` object in `settings.json`. */
export type HooksConfig = Record<string, HookMatcherGroup[]>;

/** A hook after normalization, ready to dispatch. */
export interface NormalizedHook {
	event: HookEventName;
	matcher: string | undefined;
	handler: HookHandlerConfig;
	/** Stable identity for `once` tracking and diagnostics. */
	key: string;
	/** Where the handler came from, for `/hooks` output. */
	source: string;
}

/** Claude-compatible hook input. Event-specific keys are added on top. */
export interface HookInput {
	session_id: string | null;
	transcript_path: string | null;
	cwd: string;
	hook_event_name: HookEventName;
	permission_mode?: string;
	[key: string]: unknown;
}

/** Claude-compatible hook output. Only some fields apply per event. */
export interface HookOutput {
	/** Stop processing entirely when false. */
	continue?: boolean;
	stopReason?: string;
	systemMessage?: string;
	/** Injected into the transcript at the event point. */
	additionalContext?: string;
	/** Allowlisted terminal escape sequence (OSC 0/1/2/9/99/777, BEL). */
	terminalSequence?: string;
	/** Replaces tool arguments. `PreToolUse` only. */
	updatedInput?: Record<string, unknown>;
	/** Replaces the tool result. `PostToolUse` only. */
	updatedToolOutput?: unknown;
	decision?: HookDecision;
	reason?: string;
	/** Set by an `ask` that the user declined. */
	hookEventName?: HookEventName;
}

export interface HookRunResult {
	hook: NormalizedHook;
	/** `null` when the hook was skipped or ran async. */
	output: HookOutput | null;
	/** True when the hook produced output that may change the outcome. */
	applied: boolean;
	durationMs: number;
	error?: string;
}

export interface DispatchOptions {
	/** Abort the whole dispatch. */
	signal?: AbortSignal;
	/** Called with the hook's `statusMessage` while it runs. */
	onStatus?: (message: string | undefined) => void;
	/** Diagnostic sink; silent unless `PI_HOOKS_DEBUG` is set. */
	debug?: (message: string) => void;
	/** In-process handlers registered by other extensions. */
	bus?: InProcessHookHandler[];
	/** Event is dispatched without waiting; decisions are discarded. */
	fireAndForget?: boolean;
}

/** A handler registered by another extension through `pi.events`. */
export interface InProcessHookHandler {
	event: HookEventName;
	/** Optional matcher on `tool_name` for tool events. */
	matcher?: string;
	handler: (input: HookInput) => HookOutput | void | Promise<HookOutput | void>;
	/** The extension that registered it, for diagnostics. */
	source: string;
}

export interface MergedOutcome {
	decision?: HookDecision;
	reason?: string;
	updatedInput?: Record<string, unknown>;
	updatedToolOutput?: unknown;
	additionalContext: string[];
	systemMessage?: string;
	stop?: boolean;
	stopReason?: string;
	terminalSequence?: string;
	ran: number;
	errors: string[];
}
