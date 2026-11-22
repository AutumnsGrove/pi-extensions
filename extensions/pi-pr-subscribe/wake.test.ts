import { describe, expect, it } from "vitest";
import type { PrEvent } from "./diff.ts";
import { MAX_SUMMARY, isInformational, readyToMergePayload, wakeEventTypes, wakePayload, wakeSummary } from "./wake.ts";

const ref = { owner: "AutumnsGrove", repo: "pi-extensions", number: 63 };

const check = (conclusion: string): PrEvent => ({
	type: "check.completed",
	key: `check:${conclusion}`,
	name: conclusion,
	conclusion,
});

const settle = (state: "success" | "failure", failed: string[] = []): PrEvent => ({
	type: "checks.settled",
	headSha: "4381b74eca43b95247750e2c14b74a5ab95ca7f6",
	state,
	total: 2,
	failed,
	definition: "all",
	missingRequired: [],
});

const comment = (): PrEvent => ({
	type: "comment.created",
	comment: { id: "1", kind: "issue", author: "AutumnsGrove", bot: false, body: "look" },
});

describe("isInformational", () => {
	it("is true only for passing checks and an all-green settle", () => {
		expect(isInformational([check("success")])).toBe(true);
		expect(isInformational([check("skipped"), check("neutral")])).toBe(true);
		expect(isInformational([settle("success"), check("success")])).toBe(true);
	});

	it("is false for anything that asks for a human or the agent", () => {
		expect(isInformational([])).toBe(false);
		expect(isInformational([check("failure")])).toBe(false);
		expect(isInformational([check("cancelled")])).toBe(false);
		expect(isInformational([settle("failure", ["test"])])).toBe(false);
		expect(isInformational([comment()])).toBe(false);
		expect(
			isInformational([
				{
					type: "review.submitted",
					review: { id: "1", bot: true, author: "pi-review-autumnsgrove[bot]", state: "CHANGES_REQUESTED", body: "fix" },
				},
			])
		).toBe(false);
		expect(isInformational([{ type: "head.updated", to: "bbb" }])).toBe(false);
		expect(isInformational([{ type: "subscription.error", kind: "auth", message: "bad" }])).toBe(false);
		expect(isInformational([{ type: "subscription.expired", quietMs: 1 }])).toBe(false);
		expect(isInformational([{ type: "pr.merged", number: 1 }])).toBe(false);
		expect(isInformational([{ type: "pr.closed", number: 1 }])).toBe(false);
	});

	it("is false when green and not-green are mixed", () => {
		expect(isInformational([check("success"), comment()])).toBe(false);
	});

	it("is true for a head move onto the session's own tip", () => {
		const own = new Set(["bbb"]);
		expect(isInformational([{ type: "head.updated", to: "bbb" }], own)).toBe(true);
		expect(isInformational([{ type: "head.updated", to: "bbb" }, check("success")], own)).toBe(true);
		// A head that is not the local tip, or a batch with anything else in it, still wakes.
		expect(isInformational([{ type: "head.updated", to: "ccc" }], own)).toBe(false);
		expect(isInformational([{ type: "head.updated", to: "bbb" }, comment()], own)).toBe(false);
	});
});

describe("wake payloads", () => {
	it("lists distinct event types in delivery order", () => {
		expect(wakeEventTypes([check("success"), settle("success"), check("success")])).toEqual([
			"check.completed",
			"checks.settled",
		]);
	});

	it("carries the PR, the types, and the flag", () => {
		expect(wakePayload(ref, [settle("success")])).toMatchObject({
			owner: "AutumnsGrove",
			repo: "pi-extensions",
			pullNumber: 63,
			eventTypes: ["checks.settled"],
			informational: true,
		});
	});

	it("summarizes each event on one line and caps the text", () => {
		expect(wakeSummary([settle("failure", ["review"])])).toContain("checks settled on 4381b74: failure");
		expect(wakeSummary([settle("failure", ["review"])])).toContain("failed: review");
		expect(wakeSummary([comment()])).toBe("comment by AutumnsGrove");
		const many = Array.from({ length: 200 }, () => comment());
		const summary = wakeSummary(many);
		expect(summary).toHaveLength(MAX_SUMMARY);
		expect(summary.endsWith("…")).toBe(true);
	});

	it("summarizes an own push as one, and a foreign one as a plain head move", () => {
		const own = new Set(["bbb"]);
		expect(wakeSummary([{ type: "head.updated", to: "bbb" }], own)).toContain("this session's own push");
		expect(wakeSummary([{ type: "head.updated", to: "ccc" }], own)).toBe("new commits, head ccc");
	});

	it("builds a ready-to-merge payload with and without a reason", () => {
		expect(readyToMergePayload(ref, "green")).toEqual({
			owner: "AutumnsGrove",
			repo: "pi-extensions",
			pullNumber: 63,
			reason: "green",
		});
		expect(readyToMergePayload(ref)).not.toHaveProperty("reason");
	});
});
