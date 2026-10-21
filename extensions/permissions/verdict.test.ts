import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ReviewerConfig, ReviewState } from "./types.ts";
import { createReviewer } from "./verdict/index.ts";
import { interpretJev, jevQuestions, resolveClassifier } from "./verdict/jev.ts";
import { parseLlmVerdict, resolveChatModel } from "./verdict/llm.ts";

const model = { provider: "openrouter", id: "typesafe/jev-1.14" } as never;

const config: ReviewerConfig = {
	provider: "jev",
	model: "openrouter/typesafe/jev-1.14",
	fallbackToLlm: true,
	approveAt: 0.9,
	dangerAt: 0.9,
	timeoutSeconds: 5,
	cache: true,
};

const state: ReviewState = {
	tool: "bash",
	input: { command: "npm install" },
	cwd: "/repo",
	mode: "auto",
	userIntent: "install dependencies",
	recentCommands: ["git status"],
};

const safeAnswers = {
	destructive: { type: "bool", probability: 0.02 },
	exfiltration: { type: "bool", probability: 0.01 },
	user_intent: { type: "bool", probability: 0.97 },
	scope: { type: "choice", choice: "within_cwd" },
	risk: { type: "score", score: 1 },
};

describe("jevQuestions", () => {
	it("asks bool, choice, and score questions", () => {
		const questions = jevQuestions() as Record<string, { type: string }>;
		expect(questions.destructive?.type).toBe("bool");
		expect(questions.scope?.type).toBe("choice");
		expect(questions.risk?.type).toBe("score");
	});
});

describe("interpretJev", () => {
	it("allows a safe, in-scope call", () => {
		const verdict = interpretJev(safeAnswers, config, model, 5);
		expect(verdict.decision).toBe("allow");
		expect(verdict.confidence).toBeGreaterThan(0.9);
	});

	it("denies a destructive call", () => {
		const verdict = interpretJev(
			{ ...safeAnswers, destructive: { type: "bool", probability: 0.95 } },
			config,
			model,
			5,
		);
		expect(verdict.decision).toBe("deny");
	});

	it("denies exfiltration", () => {
		const verdict = interpretJev(
			{ ...safeAnswers, exfiltration: { type: "bool", probability: 0.97 } },
			config,
			model,
			5,
		);
		expect(verdict.decision).toBe("deny");
	});

	it("asks when risk is high even if intent is clear", () => {
		const verdict = interpretJev(
			{ ...safeAnswers, risk: { type: "score", score: 2 } },
			config,
			model,
			5,
		);
		expect(verdict.decision).toBe("ask");
	});

	it("fails when an answer is missing", () => {
		const verdict = interpretJev({ ...safeAnswers, risk: undefined } as never, config, model, 5);
		expect(verdict.error).toContain("omitted");
	});
});

describe("parseLlmVerdict", () => {
	it("parses plain and fenced JSON", () => {
		expect(parseLlmVerdict('{"decision":"deny","confidence":0.8}')).toMatchObject({
			decision: "deny",
			confidence: 0.8,
		});
		expect(parseLlmVerdict('here you go\n```json\n{"decision":"allow","reason":"ok"}\n```')).toMatchObject({
			decision: "allow",
			reason: "ok",
		});
	});

	it("maps Claude's block to deny", () => {
		expect(parseLlmVerdict('{"decision":"block"}').decision).toBe("deny");
	});

	it("returns nothing for prose", () => {
		expect(parseLlmVerdict("I think it is fine")).toEqual({});
	});
});

function fakeCtx(options: {
	classify?: () => Promise<unknown>;
	complete?: () => Promise<unknown>;
} = {}): ExtensionContext {
	const classifier = {
		provider: "openrouter",
		id: "typesafe/jev-1.14",
		type: "classifier",
	};
	const chat = { provider: "anthropic", id: "claude-haiku-4" };
	return {
		model: chat,
		modelRegistry: {
			findOfType: () => classifier,
			getModelsOfType: () => [classifier],
			hasConfiguredAuth: () => true,
			classify:
				options.classify ??
				(async () => ({
					stopReason: "stop",
					answers: safeAnswers,
					provider: "openrouter",
					model: "typesafe/jev-1.14",
				})),
			find: () => chat,
			getAll: () => [chat],
			complete:
				options.complete ??
				(async () => ({
					content: [{ type: "text", text: '{"decision":"allow","confidence":0.9,"reason":"ok"}' }],
				})),
		},
	} as unknown as ExtensionContext;
}

describe("createReviewer", () => {
	it("returns undefined when the reviewer is off", () => {
		expect(createReviewer(fakeCtx(), { ...config, provider: "off" })).toBeUndefined();
	});

	it("uses JEV when it works", async () => {
		const reviewer = createReviewer(fakeCtx(), config)!;
		await expect(reviewer.review(state)).resolves.toMatchObject({
			provider: "jev",
			decision: "allow",
		});
	});

	it("falls back to the LLM when JEV errors", async () => {
		const reviewer = createReviewer(
			fakeCtx({
				classify: async () => ({ stopReason: "error", errorMessage: "no key" }),
			}),
			config,
		)!;
		const verdict = await reviewer.review(state);
		expect(verdict.provider).toBe("llm");
		expect(verdict.decision).toBe("allow");
		expect(verdict.reasons[0]).toContain("jev unavailable");
	});

	it("denies when both reviewers fail", async () => {
		const reviewer = createReviewer(
			fakeCtx({
				classify: async () => ({ stopReason: "error", errorMessage: "no key" }),
				complete: async () => {
					throw new Error("gateway down");
				},
			}),
			config,
		)!;
		const verdict = await reviewer.review(state);
		expect(verdict.decision).toBe("deny");
		expect(verdict.error).toBe("reviewer unavailable");
	});
});

describe("model resolution", () => {
	it("finds a classifier by provider/id and by suffix", () => {
		const ctx = fakeCtx();
		expect(resolveClassifier(ctx, "openrouter/typesafe/jev-1.14")).toBeDefined();
		expect(resolveClassifier(ctx, "jev-1.14")).toBeDefined();
	});

	it("falls back to the session model", () => {
		expect(resolveChatModel(fakeCtx(), undefined)?.id).toBe("claude-haiku-4");
	});
});
