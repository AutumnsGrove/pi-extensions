/**
 * `prompt` hooks: a single-turn model judgment.
 *
 * The handler prompt may use `$ARGUMENTS` for the event JSON. The model must
 * answer with JSON: `{"decision":"allow|deny|ask","reason":"..."}`. Everything
 * else (context fences, prose) is tolerated and stripped.
 *
 * `agent` hooks are intentionally not implemented yet. Pi's own tools plus a
 * prompt rating are enough for the permission flow; a tool-using subagent is a
 * later addition.
 */

import { uuidv7 } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HookDecision, HookInput, HookOutput, NormalizedHook } from "../types.ts";

export interface PromptHookResult {
	output: HookOutput | null;
	error?: string;
	blocked: boolean;
	durationMs: number;
}

const VERDICT_SYSTEM = [
	"You are a hook evaluator for a coding agent.",
	"Decide the question using only the event JSON provided.",
	"Answer with a single JSON object and nothing else:",
	'{"decision":"allow"|"deny"|"ask","reason":"one short sentence"}',
	"`ask` means a human should decide. Use `deny` only when the action is unsafe or clearly against the user's intent.",
].join("\n");

export function resolveModel(
	ctx: ExtensionContext,
	spec: string | undefined,
): Model<Api> | undefined {
	const trimmed = spec?.trim();
	if (!trimmed) return ctx.model as Model<Api> | undefined;
	const slash = trimmed.indexOf("/");
	if (slash > 0) {
		return (
			ctx.modelRegistry.find(trimmed.slice(0, slash), trimmed.slice(slash + 1)) ??
			undefined
		);
	}
	if (ctx.model) {
		const sameProvider = ctx.modelRegistry.find(ctx.model.provider, trimmed);
		if (sameProvider) return sameProvider;
	}
	return ctx.modelRegistry.getAll().find((model) => model.id === trimmed);
}

export function buildPrompt(template: string, input: HookInput): string {
	const json = JSON.stringify(input, null, 2);
	if (template.includes("$ARGUMENTS")) {
		return template.replaceAll("$ARGUMENTS", json);
	}
	return `${template}\n\nEvent JSON:\n${json}`;
}

/** Pull the first JSON object out of a model response. */
export function parseVerdict(text: string): { decision?: HookDecision; reason?: string } {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const candidate = (fenced?.[1] ?? text).trim();
	const start = candidate.indexOf("{");
	const end = candidate.lastIndexOf("}");
	if (start === -1 || end <= start) return {};
	try {
		const parsed = JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
		const raw = parsed.decision ?? parsed.permissionDecision;
		const decision =
			raw === "allow" || raw === "deny" || raw === "ask"
				? raw
				: raw === "block"
					? "deny"
					: raw === "approve"
						? "allow"
						: undefined;
		return {
			decision,
			reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
		};
	} catch {
		return {};
	}
}

export async function runPromptHook(
	hook: NormalizedHook,
	input: HookInput,
	ctx: ExtensionContext,
	options: { timeoutMs: number; signal?: AbortSignal; debug?: (message: string) => void },
): Promise<PromptHookResult> {
	const handler = hook.handler as Extract<NormalizedHook["handler"], { type: "prompt" }>;
	const started = Date.now();
	const model = resolveModel(ctx, handler.model);
	if (!model) {
		return {
			output: null,
			error: "no model available for prompt hook",
			blocked: handler.onFailure === "block",
			durationMs: Date.now() - started,
		};
	}
	if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
		return {
			output: null,
			error: `no authentication configured for ${model.provider}/${model.id}`,
			blocked: handler.onFailure === "block",
			durationMs: Date.now() - started,
		};
	}

	let timedOut = false;
	const timeout = new Promise<never>((_, reject) => {
		const timer = setTimeout(() => {
			timedOut = true;
			reject(new Error("prompt hook timed out"));
		}, Math.max(1, options.timeoutMs));
		if (timer.unref) timer.unref();
	});

	try {
		const response = await Promise.race([
			ctx.modelRegistry.complete(
				model,
				{
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: buildPrompt(handler.prompt, input) },
							],
							timestamp: Date.now(),
						},
					],
					systemPrompt: VERDICT_SYSTEM,
				},
				{ cacheRetention: "none", sessionId: uuidv7() },
			),
			timeout,
		]);

		const text = response.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		const verdict = parseVerdict(text);
		if (!verdict.decision) {
			return {
				output: null,
				error: `model did not return a decision: ${text.slice(0, 200)}`,
				blocked: handler.onFailure === "block",
				durationMs: Date.now() - started,
			};
		}
		options.debug?.(`prompt hook ${hook.key} -> ${verdict.decision}`);
		return {
			output: { decision: verdict.decision, reason: verdict.reason },
			blocked: false,
			durationMs: Date.now() - started,
		};
	} catch (error) {
		return {
			output: null,
			error: timedOut
				? `prompt hook timed out after ${options.timeoutMs}ms`
				: (error as Error).message,
			blocked: handler.onFailure === "block",
			durationMs: Date.now() - started,
		};
	}
}
