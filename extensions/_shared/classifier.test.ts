import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { boolAnswer, choiceAnswer, decide, resolveClassifier } from "./classifier.ts";

const classifier = (provider: string, id: string) => ({
	type: "classifier" as const,
	provider,
	id,
	api: "typesafe-system-one" as const,
	baseUrl: "https://openrouter.ai/api/v1",
	input: ["text"],
	contextWindow: 1000,
});

const models = [
	classifier("openrouter", "typesafe/jev-1.14"),
	classifier("openrouter", "microsoft/microsoft-decision-1.1"),
	classifier("cloudflare-workers-ai", "clef"),
];

interface Behaviour {
	auth?: boolean;
	stop?: "stop" | "error";
	message?: string;
	hang?: boolean;
	answers?: Record<string, unknown>;
}

function context(behaviours: Record<string, Behaviour> = {}): ExtensionContext {
	const find = (provider: string, id: string) =>
		models.find((model) => model.provider === provider && model.id === id);
	return {
		modelRegistry: {
			findOfType: (_type: string, provider: string, id: string) => find(provider, id),
			getModelsOfType: () => models,
			hasConfiguredAuth: (model: { id: string }) => behaviours[model.id]?.auth !== false,
			classify: async (model: { id: string }) => {
				const behaviour = behaviours[model.id] ?? {};
				if (behaviour.hang) return new Promise(() => {});
				if (behaviour.stop === "error") {
					return { stopReason: "error", errorMessage: behaviour.message ?? "refused", answers: {} };
				}
				return {
					stopReason: "stop",
					answers: behaviour.answers ?? { needs_you: { type: "bool", probability: 0.9 } },
				};
			},
		},
	} as unknown as ExtensionContext;
}

const request = {
	state: { a: 1 },
	questions: { needs_you: { type: "bool" as const, instructions: "x", criteria: { true: "y", false: "n" } } },
};

describe("resolveClassifier", () => {
	it("resolves provider/model, a bare id, and a bare suffix", () => {
		expect(resolveClassifier(context(), "openrouter/typesafe/jev-1.14")?.id).toBe("typesafe/jev-1.14");
		expect(resolveClassifier(context(), "cloudflare-workers-ai/clef")?.id).toBe("clef");
		expect(resolveClassifier(context(), "typesafe/jev-1.14")?.id).toBe("typesafe/jev-1.14");
		expect(resolveClassifier(context(), "jev-1.14")?.id).toBe("typesafe/jev-1.14");
	});

	it("prefers the OpenRouter catalog when no spec is given", () => {
		expect(resolveClassifier(context(), undefined)?.provider).toBe("openrouter");
		expect(resolveClassifier(context(), "")?.provider).toBe("openrouter");
		expect(resolveClassifier(context(), "nope/nothing")?.provider).toBe("openrouter");
	});
});

describe("decide", () => {
	it("answers with the first model in the cascade", async () => {
		const result = await decide(context(), ["openrouter/typesafe/jev-1.14"], request, { timeoutMs: 50 });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.model).toBe("openrouter/typesafe/jev-1.14");
			expect(boolAnswer(result.answers, "needs_you")).toBe(0.9);
		}
	});

	it("falls through a refused request to the next model", async () => {
		const result = await decide(
			context({ "typesafe/jev-1.14": { stop: "error", message: "retired" } }),
			["openrouter/typesafe/jev-1.14", "openrouter/microsoft/microsoft-decision-1.1"],
			request,
			{ timeoutMs: 50 },
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.model).toBe("openrouter/microsoft/microsoft-decision-1.1");
	});

	it("falls through a model with no auth, a missing id, and a timeout", async () => {
		const unauth = await decide(
			context({ "typesafe/jev-1.14": { auth: false } }),
			["openrouter/typesafe/jev-1.14", "openrouter/microsoft/microsoft-decision-1.1"],
			request,
			{ timeoutMs: 50 },
		);
		expect(unauth.ok && unauth.model).toBe("openrouter/microsoft/microsoft-decision-1.1");

		const missing = await decide(
			context(),
			["openrouter/does-not-exist", "openrouter/microsoft/microsoft-decision-1.1"],
			request,
			{ timeoutMs: 50 },
		);
		expect(missing.ok && missing.model).toBe("openrouter/microsoft/microsoft-decision-1.1");

		const slow = await decide(
			context({ "typesafe/jev-1.14": { hang: true } }),
			["openrouter/typesafe/jev-1.14", "openrouter/microsoft/microsoft-decision-1.1"],
			request,
			{ timeoutMs: 10 },
		);
		expect(slow.ok && slow.model).toBe("openrouter/microsoft/microsoft-decision-1.1");
	});

	it("fails with one line per attempted model, never a chat fallback", async () => {
		const result = await decide(
			context({
				"typesafe/jev-1.14": { stop: "error", message: "retired" },
				"microsoft/microsoft-decision-1.1": { auth: false },
			}),
			["openrouter/typesafe/jev-1.14", "openrouter/microsoft/microsoft-decision-1.1"],
			request,
			{ timeoutMs: 50 },
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toHaveLength(2);
			expect(result.errors[0]).toContain("retired");
			expect(result.errors[1]).toContain("no authentication");
		}
	});

	it("stops at an aborted signal", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await decide(context(), ["openrouter/typesafe/jev-1.14"], request, {
			timeoutMs: 50,
			signal: controller.signal,
		});
		expect(result.ok).toBe(false);
	});
});

describe("answer helpers", () => {
	it("reads a bool probability and a choice with its own probability", () => {
		const answers = {
			want: { type: "bool" as const, probability: 0.42 },
			outcome: {
				type: "choice" as const,
				choice: "nothing_to_do",
				probabilities: { nothing_to_do: 0.91, reported: 0.08 },
				confidence: 0.83,
			},
		};
		expect(boolAnswer(answers, "want")).toBe(0.42);
		expect(boolAnswer(answers, "missing")).toBeUndefined();
		expect(choiceAnswer(answers, "outcome")).toEqual({
			choice: "nothing_to_do",
			probability: 0.91,
			confidence: 0.83,
		});
		expect(choiceAnswer(answers, "want")).toBeUndefined();
	});
});
