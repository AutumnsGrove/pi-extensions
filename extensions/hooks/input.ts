/**
 * Build the Claude-compatible input envelope for a pi event.
 *
 * Field names are Claude's snake_case so a hook script written for Claude Code
 * can read `tool_name`, `tool_input`, `cwd`, and friends without changes.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	HookEventName,
	HookInput,
	HookOutput,
	HookDecision,
} from "./types.ts";

export function baseInput(event: HookEventName, ctx: ExtensionContext): HookInput {
	return {
		session_id: ctx.sessionManager.getSessionId(),
		transcript_path: ctx.sessionManager.getSessionFile() ?? null,
		cwd: ctx.cwd,
		hook_event_name: event,
	};
}

export function sessionStartSource(
	reason: "startup" | "reload" | "new" | "resume" | "fork",
): string {
	switch (reason) {
		case "startup":
		case "reload":
			return "startup";
		case "new":
			return "clear";
		case "resume":
			return "resume";
		case "fork":
			return "fork";
	}
}

export function sessionEndReason(
	reason: "quit" | "reload" | "new" | "resume" | "fork",
): string {
	switch (reason) {
		case "quit":
			return "prompt_input_exit";
		case "reload":
			return "other";
		case "new":
			return "clear";
		case "resume":
			return "resume";
		case "fork":
			return "other";
	}
}

/** Per-event dispatchable names. `SessionEnd` also reports pi's shutdown reason. */
export function toolInput(
	event: "PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "PermissionRequest" | "PermissionDenied",
	ctx: ExtensionContext,
	toolName: string,
	input: Record<string, unknown>,
	toolCallId: string,
	extra: Record<string, unknown> = {},
): HookInput {
	return {
		...baseInput(event, ctx),
		tool_name: toolName,
		tool_input: input,
		tool_use_id: toolCallId,
		...extra,
	};
}

/** Parse `permissionDecision` and friends out of Claude's `hookSpecificOutput`. */
export function normalizeOutput(raw: unknown): HookOutput {
	if (!raw || typeof raw !== "object") return {};
	const value = raw as Record<string, unknown>;
	const specific =
		value.hookSpecificOutput && typeof value.hookSpecificOutput === "object"
			? (value.hookSpecificOutput as Record<string, unknown>)
			: {};

	const decision = normalizeDecision(
		specific.permissionDecision ?? value.permissionDecision ?? value.decision,
	);
	const reason =
		stringOrUndefined(specific.permissionDecisionReason) ??
		stringOrUndefined(value.reason) ??
		stringOrUndefined(specific.reason);

	const output: HookOutput = {};
	if (decision) output.decision = decision;
	if (reason) output.reason = reason;
	if (typeof value.continue === "boolean") output.continue = value.continue;
	const stopReason = stringOrUndefined(value.stopReason);
	if (stopReason) output.stopReason = stopReason;
	const systemMessage = stringOrUndefined(value.systemMessage);
	if (systemMessage) output.systemMessage = systemMessage;
	const additional = stringOrUndefined(specific.additionalContext);
	if (additional) output.additionalContext = additional;
	const terminal = stringOrUndefined(value.terminalSequence);
	if (terminal) output.terminalSequence = terminal;
	const updatedInput = objectOrUndefined(specific.updatedInput ?? value.updatedInput);
	if (updatedInput) output.updatedInput = updatedInput;
	if (specific.updatedToolOutput !== undefined) {
		output.updatedToolOutput = specific.updatedToolOutput;
	}
	return output;
}

function normalizeDecision(value: unknown): HookDecision | undefined {
	if (value === "allow" || value === "deny" || value === "ask") return value;
	// Claude uses `decision: "block"` for non-tool events.
	if (value === "block") return "deny";
	if (value === "approve") return "allow";
	return undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function objectOrUndefined(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
