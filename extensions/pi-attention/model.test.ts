import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./config.ts";
import {
	MAX_LAST_TEXT,
	attentionQuestions,
	attentionState,
	failedUpdate,
	interpretAttention,
} from "./model.ts";
import type { TurnFacts } from "./types.ts";

const config = DEFAULT_CONFIG;
const model = "openrouter/typesafe/jev-1.14";

const answer = (probability: number) => ({ type: "bool" as const, probability });
const choice = (picked: "nothing_to_do" | "reported" | "blocked", probability: number) => ({
	type: "choice" as const,
	choice: picked,
	probabilities: { nothing_to_do: probability, reported: 1 - probability - 0.01, blocked: 0.01 },
	confidence: probability,
});

describe("attentionQuestions", () => {
	it("asks one bool and one three-way choice", () => {
		const questions = attentionQuestions();
		expect(questions.needs_you?.type).toBe("bool");
		expect(questions.outcome?.type).toBe("choice");
		if (questions.outcome?.type === "choice") {
			expect(Object.keys(questions.outcome.criteria).sort()).toEqual([
				"blocked",
				"nothing_to_do",
				"reported",
			]);
		}
	});
});

describe("attentionState", () => {
	const facts = (overrides: Partial<TurnFacts> = {}): TurnFacts => ({
		toolCalls: 1,
		prompted: false,
		aborted: false,
		errored: false,
		released: false,
		lastText: "Fixed the flaky test.",
		wake: {
			receivedAt: 1,
			payload: {
				owner: "o",
				repo: "r",
				pullNumber: 7,
				eventTypes: ["checks.settled"],
				informational: true,
				summary: "checks settled: success",
			},
		},
		...overrides,
	});

	it("carries the PR, the wake summary, the reply, and the tool count", () => {
		expect(attentionState(facts(), "o/r#7")).toEqual({
			pull_request: "o/r#7",
			pr_event: "checks settled: success",
			agent_last_message: "Fixed the flaky test.",
			tool_calls: 1,
		});
	});

	it("caps the agent's message", () => {
		const long = attentionState(facts({ lastText: "x".repeat(MAX_LAST_TEXT + 100) }), "o/r#7");
		expect(String(long.agent_last_message)).toHaveLength(MAX_LAST_TEXT);
	});

	it("tolerates a turn with no reply and no wake", () => {
		expect(attentionState(facts({ lastText: undefined, wake: undefined }), "no pull request")).toEqual({
			pull_request: "no pull request",
			pr_event: "",
			agent_last_message: "",
			tool_calls: 1,
		});
	});
});

describe("interpretAttention", () => {
	it("needs you above the threshold", () => {
		const result = interpretAttention(
			{ needs_you: answer(0.8), outcome: choice("reported", 0.9) },
			config,
			model,
			100,
		);
		expect(result?.update.state).toBe("needs_you");
		expect(result?.update.source).toBe("model");
		expect(result?.update.confidence).toBeCloseTo(0.8);
		expect(result?.update.reason).toContain("100ms");
	});

	it("waits only when nothing-to-do is confident enough", () => {
		const confident = interpretAttention(
			{ needs_you: answer(0.1), outcome: choice("nothing_to_do", 0.9) },
			config,
			model,
			50,
		);
		expect(confident?.update.state).toBe("waiting");
		expect(confident?.update.confidence).toBeCloseTo(0.9);

		const unsure = interpretAttention(
			{ needs_you: answer(0.1), outcome: choice("nothing_to_do", 0.6) },
			config,
			model,
			50,
		);
		expect(unsure?.update.state).toBe("needs_you");
		expect(unsure?.update.reason).toContain("not confident");
	});

	it("needs you when the outcome is reported but the bool disagrees", () => {
		const result = interpretAttention(
			{ needs_you: answer(0.2), outcome: choice("reported", 0.6) },
			config,
			model,
			10,
		);
		expect(result?.update.state).toBe("needs_you");
	});

	it("treats a missing bool as no answer at all", () => {
		expect(interpretAttention({ outcome: choice("nothing_to_do", 0.99) }, config, model, 1)).toBeUndefined();
	});

	it("does not require the outcome answer", () => {
		const result = interpretAttention({ needs_you: answer(0.9) }, config, model, 1);
		expect(result?.update.state).toBe("needs_you");
	});
});

describe("failedUpdate", () => {
	it("asks for you on any cascade failure, quoting the last error", () => {
		const update = failedUpdate({
			ok: false,
			errors: ["a: no authentication", "b: timed out"],
			durationMs: 2500,
		});
		expect(update.state).toBe("needs_you");
		expect(update.source).toBe("model");
		expect(update.reason).toContain("b: timed out");
	});

	it("still says something when the cascade reported no detail", () => {
		expect(failedUpdate({ ok: false, errors: [], durationMs: 0 }).reason).toContain("no model answered");
	});
});
