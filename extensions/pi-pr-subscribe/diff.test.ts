import { describe, expect, it } from "vitest";
import { MAX_SEEN_IDS, diffSnapshot, initCursor, isTerminal, jobIdFromUrl, type Cursor } from "./diff.ts";
import type { CheckEntry, CommentEntry, Snapshot } from "./snapshot.ts";

const HEAD = "4381b74eca43b95247750e2c14b74a5ab95ca7f6";
const NEXT = "9999999999999999999999999999999999999999";

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
	return {
		pull: {
			number: 32,
			title: "feat(pi-tag)",
			url: "https://github.com/o/r/pull/32",
			state: "open",
			merged: false,
			draft: false,
			headSha: HEAD,
			headRef: "feat/pi-tag",
			baseRef: "main",
			author: "AutumnsGrove",
			authorBot: false,
			...overrides.pull,
		},
		checks: overrides.checks ?? [],
		comments: overrides.comments ?? [],
		reviews: overrides.reviews ?? [],
	};
}

const comment = (id: string, overrides: Partial<CommentEntry> = {}): CommentEntry => ({
	id,
	kind: "issue",
	author: "AutumnsGrove",
	bot: false,
	body: `body ${id}`,
	createdAt: "2026-11-15T21:00:00Z",
	...overrides,
});

const check = (id: string, name: string, status: CheckEntry["status"], conclusion: string | null): CheckEntry => ({
	key: `check:${id}`,
	name,
	status,
	conclusion,
});

describe("initCursor", () => {
	it("seeds ids and checks without inventing events", () => {
		const cursor = initCursor(
			snapshot({ checks: [check("1", "review", "completed", "success")], comments: [comment("10")] })
		);
		expect(cursor.headSha).toBe(HEAD);
		expect(cursor.commentIds).toEqual(["10"]);
		expect(cursor.checks["check:1"]).toEqual({ status: "completed", conclusion: "success" });
		expect(diffSnapshot(snapshot(), initCursor(snapshot())).events).toEqual([]);
	});

	it("does not re-announce checks that were already finished", () => {
		const done = snapshot({ checks: [check("1", "review", "completed", "success")] });
		const result = diffSnapshot(done, initCursor(done));
		expect(result.events).toEqual([]);
		expect(result.cursor.settledSha).toBe(HEAD);
	});
});

describe("comments and reviews", () => {
	it("fires a new comment once and records it", () => {
		const base = initCursor(snapshot());
		const first = diffSnapshot(snapshot({ comments: [comment("10")] }), base);
		expect(first.events).toEqual([{ type: "comment.created", comment: comment("10") }]);
		expect(first.cursor.commentIds).toContain("10");
		expect(first.dirty).toBe(true);

		const second = diffSnapshot(snapshot({ comments: [comment("10")] }), first.cursor);
		expect(second.events).toEqual([]);
		expect(second.dirty).toBe(false);
	});

	it("skips an id the session posted itself", () => {
		const base = { ...initCursor(snapshot()), ownIds: ["10"], commentIds: ["10"] };
		expect(diffSnapshot(snapshot({ comments: [comment("10")] }), base).events).toEqual([]);
	});

	it("delivers several new comments oldest first", () => {
		const base = initCursor(snapshot());
		const items = [
			{ ...comment("10"), createdAt: "2026-11-15T21:01:00Z" },
			{ ...comment("11"), createdAt: "2026-11-15T21:02:00Z" },
		];
		const result = diffSnapshot(snapshot({ comments: items }), base);
		expect(result.events.map((event) => (event.type === "comment.created" ? event.comment.id : ""))).toEqual([
			"10",
			"11",
		]);
		expect(result.cursor.commentIds).toEqual(["10", "11"]);
	});

	it("does not fire for an edited comment that keeps its id", () => {
		const base = initCursor(snapshot({ comments: [comment("10")] }));
		const edited = snapshot({ comments: [{ ...comment("10"), body: "edited" }] });
		expect(diffSnapshot(edited, base).events).toEqual([]);
	});

	it("fires a review, skipping a bare COMMENTED placeholder", () => {
		const base = initCursor(snapshot());
		const result = diffSnapshot(
			snapshot({
				reviews: [
					{ id: "5", author: "pi-review-autumnsgrove[bot]", bot: true, state: "COMMENTED", body: "" },
					{ id: "6", author: "pi-review-autumnsgrove[bot]", bot: true, state: "CHANGES_REQUESTED", body: "fix it" },
				],
			}),
			base
		);
		expect(result.events).toHaveLength(1);
		expect(result.events[0]).toMatchObject({ type: "review.submitted", review: { id: "6" } });
		expect(result.cursor.reviewIds).toEqual(["5", "6"]);
	});

	it("caps the ids it remembers", () => {
		const dated = (index: number): CommentEntry => ({
			...comment(String(index)),
			createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
		});
		const base = initCursor(
			snapshot({ comments: Array.from({ length: MAX_SEEN_IDS }, (_, index) => dated(index)) })
		);
		const result = diffSnapshot(
			snapshot({
				comments: [
					...Array.from({ length: MAX_SEEN_IDS }, (_, index) => dated(index)),
					{ ...comment("new"), createdAt: "2026-02-01T00:00:00Z" },
				],
			}),
			base
		);
		expect(result.cursor.commentIds).toHaveLength(MAX_SEEN_IDS);
		expect(result.cursor.commentIds.at(-1)).toBe("new");
		expect(result.cursor.commentIds).not.toContain("0");
	});
});

describe("head updates", () => {
	it("fires and resets the check picture", () => {
		const base = initCursor(snapshot({ checks: [check("1", "review", "completed", "success")] }));
		const result = diffSnapshot(snapshot({ pull: { ...snapshot().pull, headSha: NEXT } }), base);
		expect(result.events[0]).toEqual({ type: "head.updated", from: HEAD, to: NEXT });
		expect(result.cursor.checks).toEqual({});
		expect(result.cursor.settledSha).toBeNull();
	});

	it("reports checks on the new head as new", () => {
		const base = initCursor(snapshot());
		const result = diffSnapshot(
			snapshot({
				pull: { ...snapshot().pull, headSha: NEXT },
				checks: [check("2", "review", "completed", "failure")],
			}),
			base
		);
		expect(result.events.map((event) => event.type)).toEqual(["head.updated", "check.completed", "checks.settled"]);
	});
});

describe("checks", () => {
	it("fires when a run reaches a terminal conclusion, and not again", () => {
		const base = initCursor(snapshot({ checks: [check("1", "review", "in_progress", null)] }));
		const done = snapshot({ checks: [check("1", "review", "completed", "failure")] });
		const first = diffSnapshot(done, base);
		expect(first.events).toContainEqual({
			type: "check.completed",
			key: "check:1",
			name: "review",
			conclusion: "failure",
		});
		expect(diffSnapshot(done, first.cursor).events).toEqual([]);
	});

	it("fires again for a rerun of the same job", () => {
		const done = snapshot({ checks: [check("1", "review", "completed", "success")] });
		const first = diffSnapshot(done, initCursor(snapshot({ checks: [check("1", "review", "in_progress", null)] })));
		const rerun = diffSnapshot(
			snapshot({ checks: [check("1", "review", "completed", "failure")] }),
			first.cursor
		);
		expect(rerun.events).toContainEqual(expect.objectContaining({ type: "check.completed", conclusion: "failure" }));
	});

	it("does not fire for queued or running checks", () => {
		const base = initCursor(snapshot());
		const result = diffSnapshot(snapshot({ checks: [check("1", "review", "queued", null)] }), base);
		expect(result.events).toEqual([]);
	});

	it("settles once when every check is terminal", () => {
		const base = initCursor(snapshot({ checks: [check("1", "a", "in_progress", null)] }));
		const allDone = snapshot({ checks: [check("1", "a", "completed", "success"), check("2", "b", "completed", "skipped")] });
		const first = diffSnapshot(allDone, base);
		expect(first.events).toContainEqual(
			expect.objectContaining({ type: "checks.settled", state: "success", total: 2, definition: "all" })
		);
		const second = diffSnapshot(allDone, first.cursor);
		expect(second.events.filter((event) => event.type === "checks.settled")).toEqual([]);
	});

	it("reports a failing verdict and the failed names", () => {
		const base = initCursor(snapshot({ checks: [check("1", "a", "in_progress", null)] }));
		const result = diffSnapshot(
			snapshot({ checks: [check("1", "a", "completed", "failure"), check("2", "b", "completed", "success")] }),
			base
		);
		expect(result.events).toContainEqual(
			expect.objectContaining({ type: "checks.settled", state: "failure", failed: ["a"] })
		);
	});

	it("waits for a required check that is still pending", () => {
		const base = initCursor(snapshot());
		const result = diffSnapshot(
			snapshot({ checks: [check("1", "review", "completed", "success"), check("2", "test", "in_progress", null)] }),
			base,
			{ required: ["review", "test"] }
		);
		expect(result.events.filter((event) => event.type === "checks.settled")).toEqual([]);
	});

	it("settles against every check when a required context never appears", () => {
		const base = initCursor(snapshot());
		const result = diffSnapshot(
			snapshot({ checks: [check("1", "review", "completed", "success")] }),
			base,
			{ required: ["review", "ghost"] }
		);
		expect(result.events).toContainEqual(
			expect.objectContaining({
				type: "checks.settled",
				definition: "all",
				missingRequired: ["ghost"],
				state: "success",
			})
		);
	});

	it("waits a few polls before settling a head with no checks at all", () => {
		const base = initCursor(snapshot());
		const first = diffSnapshot(snapshot(), base);
		const second = diffSnapshot(snapshot(), first.cursor);
		const third = diffSnapshot(snapshot(), second.cursor);
		expect(first.events).toEqual([]);
		expect(second.events).toEqual([]);
		expect(third.events).toContainEqual(
			expect.objectContaining({ type: "checks.settled", total: 0, state: "success" })
		);
		expect(diffSnapshot(snapshot(), third.cursor).events).toEqual([]);
	});

	it("restarts the empty-check count when the head moves", () => {
		const base = initCursor(snapshot());
		const first = diffSnapshot(snapshot(), base);
		const moved = diffSnapshot(snapshot({ pull: { ...snapshot().pull, headSha: NEXT } }), first.cursor);
		expect(moved.events.map((event) => event.type)).toEqual(["head.updated"]);
		expect(moved.cursor.zeroCheckPolls).toBe(1);
	});

	it("names the log job from a details URL", () => {
		expect(jobIdFromUrl("https://github.com/o/r/actions/runs/43761622502/job/132957496420")).toBe(
			"132957496420"
		);
		expect(jobIdFromUrl("https://ci.example/x")).toBeUndefined();
		expect(jobIdFromUrl(undefined)).toBeUndefined();
	});
});

describe("terminal states", () => {
	it("fires pr.merged once and ends", () => {
		const base = initCursor(snapshot());
		const merged = snapshot({ pull: { ...snapshot().pull, state: "closed", merged: true } });
		const first = diffSnapshot(merged, base);
		expect(first.events).toEqual([
			{ type: "pr.merged", number: 32, url: "https://github.com/o/r/pull/32" },
		]);
		expect(isTerminal(first.events[0]!)).toBe(true);
		expect(diffSnapshot(merged, first.cursor).events).toEqual([]);
	});

	it("fires pr.closed when closed without merging", () => {
		const base = initCursor(snapshot());
		const closed = snapshot({ pull: { ...snapshot().pull, state: "closed" } });
		const result = diffSnapshot(closed, base);
		expect(result.events).toEqual([{ type: "pr.closed", number: 32, url: "https://github.com/o/r/pull/32" }]);
	});

	it("reports a merged PR once, not the same event on the next poll", () => {
		const merged = snapshot({ pull: { ...snapshot().pull, state: "closed", merged: true } });
		const cursor: Cursor = { ...initCursor(snapshot()), merged: true, state: "closed" };
		expect(diffSnapshot(merged, cursor).events).toEqual([]);
	});
});
