/**
 * Permissions types.
 *
 * The policy is intentionally separate from the hook engine: the engine
 * dispatches, this extension decides. Everything here is plain data so the
 * decision path can be replayed in tests and benchmarked later.
 */

export type PermissionMode =
	| "default"
	| "acceptEdits"
	| "auto"
	| "dontAsk"
	| "bypass";

export type Decision = "allow" | "ask" | "deny";

export type ReviewerKind = "jev" | "llm" | "off";

export interface RuleEntry {
	/** `Bash(git *)`, `Edit(*.ts)`, `mcp__jira__*`, … */
	rule: string;
	source: "default" | "global" | "project" | "grant";
}

export interface ReviewerConfig {
	provider: ReviewerKind;
	/** `provider/model`, e.g. `openrouter/~typesafe/jev-latest`. */
	model?: string;
	/** Chat model used when the classifier is unavailable. */
	fallbackModel?: string;
	/** Fall back to a chat verdict when the classifier cannot run. */
	fallbackToLlm: boolean;
	/** Probability at or above which a positive signal counts. */
	approveAt: number;
	/** Probability at or above which a danger signal denies. */
	dangerAt: number;
	timeoutSeconds: number;
	cache: boolean;
}

export interface LogConfig {
	enabled: boolean;
	/** Include the unredacted review state. Off by default. */
	fullState: boolean;
}

export interface PermissionsConfig {
	mode: PermissionMode;
	/** What to do when no rule and no reviewer applies. */
	defaultDecision: Decision;
	allow: RuleEntry[];
	ask: RuleEntry[];
	deny: RuleEntry[];
	reviewer: ReviewerConfig;
	/** Tools the auto reviewer is allowed to judge. MCP is matched separately. */
	reviewTools: string[];
	/** Add the built-in deny and read-only allow lists. */
	useDefaultRules: boolean;
	log: LogConfig;
	/** Let "Always allow" write a rule into project settings. */
	persistGrants: boolean;
}

export interface ReviewState {
	tool: string;
	input: Record<string, unknown>;
	cwd: string;
	mode: PermissionMode;
	/** Last user prompt, truncated. Gives the reviewer intent. */
	userIntent?: string;
	/** Recent bash commands in this session, oldest first. */
	recentCommands?: string[];
}

export interface Verdict {
	decision: Decision;
	confidence: number;
	reasons: string[];
	provider: string;
	model?: string;
	probabilities?: Record<string, number>;
	durationMs: number;
	error?: string;
	/** True when the verdict came from the session cache. */
	cached?: boolean;
}

export interface RuleVerdict {
	decision: Decision | "none";
	matched: string[];
	reasons: string[];
}

export interface GateResult {
	decision: Decision;
	reason?: string;
	/** How the decision was reached, for logs and `/permissions`. */
	source: "rule" | "mode" | "reviewer" | "grant" | "user" | "cache";
	rule?: RuleVerdict;
	reviewer?: Verdict;
	grant?: string;
	userChoice?: string;
}

export interface DecisionRecord {
	v: 1;
	ts: string;
	session_id: string;
	cwd: string;
	mode: PermissionMode;
	tool: string;
	input: Record<string, unknown>;
	rule?: RuleVerdict & { decision: Decision | "none" };
	reviewer?: Omit<Verdict, "durationMs"> & { durationMs: number };
	decision: Decision;
	source: GateResult["source"];
	reason?: string;
	grant?: string;
	user_choice?: string;
	cached?: boolean;
	latency_ms: number;
}
