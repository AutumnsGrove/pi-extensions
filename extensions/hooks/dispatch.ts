/**
 * Select hooks for an event, run them (in parallel, like Claude), and merge
 * their outputs.
 *
 * Merge rules:
 *   - `deny` beats `ask` beats `allow`
 *   - `continue: false` wins over everything and stops the run
 *   - `updatedInput` fields merge in config order, later hooks win
 *   - `additionalContext` accumulates and is deduplicated
 *
 * Async hooks are started and never awaited; their output is discarded, which
 * matches Claude: an async `PreToolUse` hook cannot block.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultTimeout } from "./config.ts";
import {
	isToolEvent,
	matcherSubject,
	matchesMatcher,
	matchesPermissionRule,
	parsePermissionRule,
} from "./events.ts";
import { runProcess, interpretProcessResult } from "./handlers/command.ts";
import { runHttpHook } from "./handlers/http.ts";
import { runPromptHook } from "./handlers/prompt.ts";
import type {
	DispatchOptions,
	HookDecision,
	HookEventName,
	HookInput,
	HookOutput,
	HookRunResult,
	InProcessHookHandler,
	MergedOutcome,
	NormalizedHook,
} from "./types.ts";

export interface DispatchState {
	/** Keys of `once` hooks that already ran successfully this session. */
	once: Set<string>;
}

export function createDispatchState(): DispatchState {
	return { once: new Set() };
}

const DECISION_RANK: Record<HookDecision, number> = { allow: 1, ask: 2, deny: 3 };

export function selectHooks(
	event: HookEventName,
	input: HookInput,
	hooks: NormalizedHook[],
	state?: DispatchState,
): NormalizedHook[] {
	const selected: NormalizedHook[] = [];
	const subject = matcherSubject(event, input);
	const caseInsensitive = isToolEvent(event);

	for (const hook of hooks) {
		if (hook.event !== event) continue;
		if (hook.matcher !== undefined) {
			if (subject === undefined) continue;
			if (!matchesMatcher(hook.matcher, subject, caseInsensitive)) continue;
		}
		if (hook.handler.if !== undefined) {
			const rule = parsePermissionRule(hook.handler.if);
			if (!rule) continue;
			const toolName = typeof input.tool_name === "string" ? input.tool_name : undefined;
			const toolInput =
				input.tool_input && typeof input.tool_input === "object"
					? (input.tool_input as Record<string, unknown>)
					: undefined;
			if (!toolName || !toolInput) continue;
			if (!matchesPermissionRule(rule, toolName, toolInput)) continue;
		}
		if (hook.handler.once && state?.once.has(hook.key)) continue;
		selected.push(hook);
	}
	return selected;
}

/** Turn a failed hook into a deny when it asked to block on failure. */
function failedOutput(
	output: HookOutput | null,
	error: string | undefined,
	blocked: boolean,
): HookOutput | null {
	if (output !== null || !blocked) return output;
	return { decision: "deny", reason: error ?? "hook failed" };
}

async function runOne(
	hook: NormalizedHook,
	input: HookInput,
	ctx: ExtensionContext,
	options: DispatchOptions,
): Promise<HookRunResult> {
	const started = Date.now();
	const handler = hook.handler;
	const timeoutMs = (handler.timeout ?? defaultTimeout(handler.type)) * 1000;
	if (options.onStatus) options.onStatus?.(handler.statusMessage);

	try {
		if (handler.type === "command") {
			const processResult = await runProcess(handler.command, handler.args, input, {
				cwd: input.cwd,
				shell: handler.shell,
				timeoutMs,
				signal: options.signal,
			});
			const interpreted = interpretProcessResult(hook, processResult);
			return {
				hook,
				output: failedOutput(
					interpreted.output,
					interpreted.error,
					interpreted.blocked,
				),
				applied: interpreted.output !== null || interpreted.blocked,
				durationMs: interpreted.durationMs,
				error: interpreted.error,
			};
		}
		if (handler.type === "http") {
			const result = await runHttpHook(hook, input, {
				timeoutMs,
				signal: options.signal,
				debug: options.debug,
			});
			return {
				hook,
				output: failedOutput(result.output, result.error, result.blocked),
				applied: result.output !== null || result.blocked,
				durationMs: result.durationMs,
				error: result.error,
			};
		}
		if (handler.type === "prompt") {
			const result = await runPromptHook(hook, input, ctx, {
				timeoutMs,
				signal: options.signal,
				debug: options.debug,
			});
			return {
				hook,
				output: failedOutput(result.output, result.error, result.blocked),
				applied: result.output !== null || result.blocked,
				durationMs: result.durationMs,
				error: result.error,
			};
		}
		return {
			hook,
			output: null,
			applied: false,
			durationMs: Date.now() - started,
			error: `handler type "${handler.type}" is not implemented`,
		};
	} catch (error) {
		return {
			hook,
			output: null,
			applied: false,
			durationMs: Date.now() - started,
			error: (error as Error).message,
		};
	} finally {
		if (options.onStatus) options.onStatus?.(undefined);
	}
}

/** Run one in-process handler registered through `pi.events`. */
async function runBusHandler(
	handler: InProcessHookHandler,
	input: HookInput,
	options: DispatchOptions,
): Promise<HookRunResult> {
	const started = Date.now();
	try {
		const output = (await handler.handler(input)) ?? null;
		return {
			hook: {
				event: handler.event,
				matcher: handler.matcher,
				handler: { type: "command", command: "<in-process>" },
				key: `bus:${handler.source}`,
				source: handler.source,
			},
			output,
			applied: output !== null,
			durationMs: Date.now() - started,
		};
	} catch (error) {
		return {
			hook: {
				event: handler.event,
				matcher: handler.matcher,
				handler: { type: "command", command: "<in-process>" },
				key: `bus:${handler.source}`,
				source: handler.source,
			},
			output: null,
			applied: false,
			durationMs: Date.now() - started,
			error: (error as Error).message,
		};
	}
}

export function mergeResults(event: HookEventName, results: HookRunResult[]): MergedOutcome {
	const outcome: MergedOutcome = {
		additionalContext: [],
		ran: results.length,
		errors: [],
	};

	let winning: HookDecision | undefined;
	const contexts = new Set<string>();

	for (const result of results) {
		if (result.error) outcome.errors.push(`${result.hook.key}: ${result.error}`);
		const output: HookOutput | null = result.output;
		if (!output) continue;

		if (output.continue === false && !outcome.stop) {
			outcome.stop = true;
			outcome.stopReason = output.stopReason;
		}
		if (output.decision) {
			if (!winning || DECISION_RANK[output.decision] > DECISION_RANK[winning]) {
				winning = output.decision;
				outcome.reason = output.reason;
			}
		}
		if (output.updatedInput) {
			outcome.updatedInput = { ...outcome.updatedInput, ...output.updatedInput };
		}
		if (output.updatedToolOutput !== undefined) {
			outcome.updatedToolOutput = output.updatedToolOutput;
		}
		if (output.additionalContext) contexts.add(output.additionalContext);
		if (output.systemMessage) outcome.systemMessage = output.systemMessage;
		if (output.terminalSequence) outcome.terminalSequence = output.terminalSequence;
	}

	if (winning) outcome.decision = winning;
	if (contexts.size > 0) outcome.additionalContext = [...contexts];
	// Exit-2 output on post events is feedback, not a verdict.
	if (!winning && event.startsWith("Post")) outcome.decision = undefined;
	return outcome;
}

export async function dispatchHooks(
	event: HookEventName,
	input: HookInput,
	ctx: ExtensionContext,
	hooks: NormalizedHook[],
	options: DispatchOptions = {},
	state?: DispatchState,
): Promise<MergedOutcome> {
	const selected = selectHooks(event, input, hooks, state);
	const busHandlers = (options.bus ?? []).filter((handler) => {
		if (handler.event !== event) return false;
		if (handler.matcher === undefined) return true;
		const subject = matcherSubject(event, input);
		return (
			subject !== undefined &&
			matchesMatcher(handler.matcher, subject, isToolEvent(event))
		);
	});

	const runs: Promise<HookRunResult>[] = [];
	for (const hook of selected) {
		if (hook.handler.async) {
			// Fire and forget: an async hook cannot decide anything.
			void runOne(hook, input, ctx, options).catch((error) => {
				options.debug?.(`async hook ${hook.key} failed: ${(error as Error).message}`);
			});
			continue;
		}
		runs.push(runOne(hook, input, ctx, options));
	}
	for (const handler of busHandlers) {
		runs.push(runBusHandler(handler, input, options));
	}

	const results = options.fireAndForget
		? await Promise.all(runs.map((run) => run.catch(() => undefined)))
		: await Promise.all(runs);

	const filtered = results.filter((result): result is HookRunResult => result !== undefined);
	for (const result of filtered) {
		if (result.hook.handler.once && !result.error) {
			state?.once.add(result.hook.key);
		}
	}
	return mergeResults(event, filtered);
}
