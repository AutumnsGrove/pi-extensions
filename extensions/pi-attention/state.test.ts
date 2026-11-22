import { describe, expect, it } from "vitest";
import { decideRules, isSameUpdate } from "./state.ts";
import type { AttentionUpdate, TurnFacts, WakeSignal } from "./types.ts";

const wake = (informational: boolean): WakeSignal => ({
	receivedAt: 1,
	payload: {
		owner: "AutumnsGrove",
		repo: "pi-extensions",
		pullNumber: 63,
		eventTypes: ["checks.settled"],
		informational,
		summary: "checks settled",
	},
});

const facts = (overrides: Partial<TurnFacts> = {}): TurnFacts => ({
	toolCalls: 0,
	prompted: false,
	aborted: false,
	released: false,
	...overrides,
});

const state = (outcome: ReturnType<typeof decideRules>): string | undefined =>
	outcome.kind === "decided" ? outcome.update.state : undefined;

describe("decideRules", () => {
	it("makes a done release ready, whatever else happened", () => {
		const outcome = decideRules(
			facts({ released: true, releaseReason: "green", wake: wake(false), prompted: true }),
		);
		expect(state(outcome)).toBe("ready");
		if (outcome.kind === "decided") {
			expect(outcome.update.reason).toBe("released as done: green");
			expect(outcome.update.source).toBe("signal");
		}
	});

	it("always needs you for a wake that was not informational", () => {
		for (const toolCalls of [0, 3]) {
			const outcome = decideRules(facts({ wake: wake(false), toolCalls }));
			expect(state(outcome)).toBe("needs_you");
			if (outcome.kind === "decided") expect(outcome.update.source).toBe("rule");
		}
	});

	it("waits on an informational wake that made no tool calls", () => {
		expect(state(decideRules(facts({ wake: wake(true), toolCalls: 0 })))).toBe("waiting");
	});

	it("sends an informational wake with work to the model", () => {
		const outcome = decideRules(facts({ wake: wake(true), toolCalls: 2 }));
		expect(outcome.kind).toBe("model");
	});

	it("is idle for an ordinary turn, and for an aborted one", () => {
		expect(state(decideRules(facts()))).toBe("idle");
		expect(state(decideRules(facts({ toolCalls: 4 })))).toBe("idle");
		const aborted = decideRules(facts({ aborted: true, toolCalls: 1 }));
		expect(state(aborted)).toBe("idle");
		if (aborted.kind === "decided") expect(aborted.update.reason).toContain("aborted");
	});
});

describe("isSameUpdate", () => {
	const update: AttentionUpdate = { state: "idle", source: "rule", reason: "settled" };

	it("treats an identical consecutive state as noise", () => {
		expect(isSameUpdate(update, { ...update })).toBe(true);
		expect(isSameUpdate(undefined, update)).toBe(false);
		expect(isSameUpdate(update, { ...update, state: "waiting" })).toBe(false);
		expect(isSameUpdate(update, { ...update, reason: "other" })).toBe(false);
		expect(isSameUpdate(update, { ...update, source: "signal" })).toBe(false);
	});
});
