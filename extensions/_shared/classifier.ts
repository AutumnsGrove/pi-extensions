/**
 * Classifier resolution and the decision-model cascade, shared by the
 * extensions that ask a non-generative model for a structured answer.
 *
 * `permissions` asks about one tool call; `pi-attention` asks whether a turn
 * needs a person. Both go through pi's classifier registry, which is the same
 * one-request-per-question shape for every decision model in the catalog, so
 * there is one adapter rather than one per model.
 *
 * The cascade is ordered and fails loud: try the first model, fall through on
 * an error or a timeout, and report failure only when every model failed. The
 * caller decides what failure means — both of these callers treat it as "ask
 * the human", never as "fine".
 */

import type {
	Api,
	ClassifierApi,
	ClassifierAnswer,
	ClassifierModel,
	ClassifierQuestion,
	JsonObject,
	Model,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type Classifier = ClassifierModel<ClassifierApi>;

/**
 * Resolve a classifier by `provider/model`, a bare model id, or a bare suffix
 * like `jev-1.14`. Exact only: a pinned id that no longer exists must fail, not
 * quietly become a different model.
 */
export function findClassifier(ctx: ExtensionContext, spec: string): Classifier | undefined {
	const trimmed = spec.trim();
	if (!trimmed) return undefined;
	const slash = trimmed.indexOf("/");
	if (slash > 0) {
		return ctx.modelRegistry.findOfType(
			"classifier",
			trimmed.slice(0, slash),
			trimmed.slice(slash + 1),
		);
	}
	const models = ctx.modelRegistry.getModelsOfType("classifier");
	return (
		models.find((model) => model.id === trimmed) ??
		models.find((model) => model.id.endsWith(`/${trimmed}`))
	);
}

/**
 * A classifier to use when the caller did not pin one. Prefer the OpenRouter
 * catalog, because that is where the decision models live.
 */
export function defaultClassifier(ctx: ExtensionContext): Classifier | undefined {
	const models = ctx.modelRegistry.getModelsOfType("classifier");
	return models.find((model) => model.provider === "openrouter") ?? models[0];
}

/** Exact lookup, then the default. */
export function resolveClassifier(
	ctx: ExtensionContext,
	spec: string | undefined,
): Classifier | undefined {
	const trimmed = spec?.trim();
	return (trimmed ? findClassifier(ctx, trimmed) : undefined) ?? defaultClassifier(ctx);
}

/** Race a promise against a timeout without leaking an unhandled rejection. */
export async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	label: string,
): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out`)), Math.max(1, timeoutMs));
		if (timer.unref) timer.unref();
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** Truncate a string for a classifier's limited context window. */
export function clip(value: unknown, max = 2000): string {
	if (typeof value !== "string") return "";
	return value.length > max ? value.slice(0, max) : value;
}

export interface DecideRequest {
	state: JsonObject;
	questions: Record<string, ClassifierQuestion>;
}

export interface DecideSuccess {
	ok: true;
	/** The model that answered, as `provider/id`. */
	model: string;
	answers: Record<string, ClassifierAnswer>;
	durationMs: number;
}

export interface DecideFailure {
	ok: false;
	/** One line per attempted model, in cascade order. */
	errors: string[];
	durationMs: number;
}

export type DecideResult = DecideSuccess | DecideFailure;

/**
 * Ask the first available model in `specs` and fall through on failure.
 *
 * A retired or misspelled id, missing auth, a refused request, an error stop
 * reason, and a timeout all count as that model failing. No chat-model fallback:
 * a decision model answering badly is one thing, a generative model inventing
 * an answer nobody watches is another.
 */
export async function decide(
	ctx: ExtensionContext,
	specs: string[],
	request: DecideRequest,
	options: { timeoutMs: number; signal?: AbortSignal } = { timeoutMs: 2_500 },
): Promise<DecideResult> {
	const started = Date.now();
	const errors: string[] = [];
	const candidates = specs.length > 0 ? specs : [undefined];

	for (const spec of candidates) {
		if (options.signal?.aborted) {
			errors.push("aborted");
			break;
		}
		const model = spec ? findClassifier(ctx, spec) : defaultClassifier(ctx);
		const label = spec ?? "default classifier";
		if (!model) {
			errors.push(`${label}: no such classifier`);
			continue;
		}
		const id = `${model.provider}/${model.id}`;
		if (!ctx.modelRegistry.hasConfiguredAuth(model as unknown as Model<Api>)) {
			errors.push(`${id}: no authentication`);
			continue;
		}
		try {
			const result = await withTimeout(
				ctx.modelRegistry.classify(model, request),
				options.timeoutMs,
				`${id} decision`,
			);
			if (result.stopReason !== "stop") {
				errors.push(`${id}: ${result.errorMessage ?? `stopped (${result.stopReason})`}`);
				continue;
			}
			return {
				ok: true,
				model: id,
				answers: result.answers,
				durationMs: Date.now() - started,
			};
		} catch (error) {
			errors.push(`${id}: ${(error as Error).message}`);
		}
	}

	return { ok: false, errors, durationMs: Date.now() - started };
}

/** A bool answer's probability, or `undefined` when the model skipped it. */
export function boolAnswer(
	answers: Record<string, ClassifierAnswer>,
	id: string,
): number | undefined {
	const answer = answers[id];
	return answer?.type === "bool" ? answer.probability : undefined;
}

/** A choice answer plus the probability the model gave the chosen option. */
export function choiceAnswer(
	answers: Record<string, ClassifierAnswer>,
	id: string,
): { choice: string; probability: number; confidence: number } | undefined {
	const answer = answers[id];
	if (answer?.type !== "choice") return undefined;
	return {
		choice: answer.choice,
		probability: answer.probabilities[answer.choice] ?? answer.confidence,
		confidence: answer.confidence,
	};
}
