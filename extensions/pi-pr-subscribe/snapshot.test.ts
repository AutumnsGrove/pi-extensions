import { describe, expect, it } from "vitest";
import {
	buildSnapshot,
	checkSummary,
	parseCheckRuns,
	parseCommitStatuses,
	parseIssueComments,
	parsePull,
	parseReviewComments,
	parseReviews,
} from "./snapshot.ts";

const pullPayload = {
	number: 32,
	title: "feat(pi-tag): read the tree",
	html_url: "https://github.com/o/r/pull/32",
	state: "open",
	merged: false,
	draft: false,
	user: { login: "AutumnsGrove", type: "User" },
	head: { sha: "4381b74eca43b95247750e2c14b74a5ab95ca7f6", ref: "feat/pi-tag" },
	base: { sha: "d58fb18", ref: "main" },
	updated_at: "2026-11-16T18:52:32Z",
};

describe("parsePull", () => {
	it("normalizes a pull request", () => {
		expect(parsePull(pullPayload)).toEqual({
			number: 32,
			title: "feat(pi-tag): read the tree",
			url: "https://github.com/o/r/pull/32",
			state: "open",
			merged: false,
			draft: false,
			headSha: "4381b74eca43b95247750e2c14b74a5ab95ca7f6",
			headRef: "feat/pi-tag",
			baseRef: "main",
			baseSha: "d58fb18",
			author: "AutumnsGrove",
			authorBot: false,
			updatedAt: "2026-11-16T18:52:32Z",
		});
	});

	it("refuses a payload without a number or head SHA", () => {
		expect(parsePull({ number: 1 })).toBeUndefined();
		expect(parsePull({ number: 1, head: {} })).toBeUndefined();
		expect(parsePull(null)).toBeUndefined();
		expect(parsePull("nope")).toBeUndefined();
	});

	it("marks App bots and closed merged PRs", () => {
		const pull = parsePull({
			number: 7,
			state: "closed",
			merged: true,
			user: { login: "pi-review-autumnsgrove[bot]", type: "Bot" },
			head: { sha: "abc", ref: "x" },
			base: { ref: "main" },
		});
		expect(pull?.state).toBe("closed");
		expect(pull?.merged).toBe(true);
		expect(pull?.authorBot).toBe(true);
	});

	it("treats an unknown state as open rather than dropping the PR", () => {
		expect(parsePull({ ...pullPayload, state: "weird" })?.state).toBe("open");
	});
});

describe("checks", () => {
	it("parses check runs", () => {
		const checks = parseCheckRuns({
			total_count: 2,
			check_runs: [
				{
					id: 132957496420,
					name: "review",
					status: "completed",
					conclusion: "success",
					html_url: "https://github.com/o/r/actions/runs/43761622502/job/132957496420",
					app: { name: "GitHub Actions" },
					started_at: "2026-11-15T21:04:55Z",
					completed_at: "2026-11-15T21:06:37Z",
				},
				{ id: 2, name: "lint", status: "in_progress", conclusion: null },
				{ id: 3, name: "", status: "completed" },
			],
		});
		expect(checks).toHaveLength(2);
		expect(checks[0]).toMatchObject({
			key: "check:132957496420",
			name: "review",
			status: "completed",
			conclusion: "success",
			app: "GitHub Actions",
		});
		expect(checks[1]).toMatchObject({ key: "check:2", status: "in_progress", conclusion: null });
	});

	it("parses legacy commit statuses, including pending", () => {
		const checks = parseCommitStatuses({
			state: "pending",
			statuses: [
				{ context: "ci/build", state: "PENDING", target_url: "https://ci/1", created_at: "2026-11-15T21:00:00Z" },
				{ context: "ci/lint", state: "SUCCESS" },
				{ context: "ci/test", state: "FAILURE" },
				{ context: "ci/err", state: "ERROR" },
				{ context: "", state: "SUCCESS" },
			],
		});
		expect(checks.map((check) => [check.key, check.status, check.conclusion])).toEqual([
			["status:ci/build", "in_progress", null],
			["status:ci/lint", "completed", "success"],
			["status:ci/test", "completed", "failure"],
			["status:ci/err", "completed", "error"],
		]);
	});

	it("summarizes counts", () => {
		const summary = checkSummary([
			{ key: "a", name: "a", status: "completed", conclusion: "success" },
			{ key: "b", name: "b", status: "completed", conclusion: "failure" },
			{ key: "c", name: "c", status: "in_progress", conclusion: null },
			{ key: "d", name: "d", status: "queued", conclusion: null },
		]);
		expect(summary).toEqual({ total: 4, done: 2, failed: 1, pending: 2 });
	});
});

describe("comments and reviews", () => {
	it("parses issue comments", () => {
		const [comment] = parseIssueComments([
			{
				id: 3550000000,
				user: { login: "pi-review-autumnsgrove[bot]", type: "Bot" },
				body: "looks good",
				created_at: "2026-11-15T21:06:37Z",
				html_url: "https://github.com/o/r/pull/32#issuecomment-3550000000",
			},
			{ body: "no id" },
		]);
		expect(comment).toEqual({
			id: "3550000000",
			kind: "issue",
			author: "pi-review-autumnsgrove[bot]",
			bot: true,
			body: "looks good",
			createdAt: "2026-11-15T21:06:37Z",
			url: "https://github.com/o/r/pull/32#issuecomment-3550000000",
		});
		expect(parseIssueComments([{ body: "no id" }])).toHaveLength(0);
	});

	it("parses inline review comments with path, line, and reply target", () => {
		const [comment] = parseReviewComments([
			{
				id: 1234,
				user: { login: "AutumnsGrove" },
				body: "why?",
				path: "extensions/pi-tag/index.ts",
				original_line: 42,
				in_reply_to_id: 1200,
				created_at: "2026-11-15T21:06:37Z",
			},
		]);
		expect(comment).toMatchObject({
			id: "1234",
			kind: "review",
			bot: false,
			path: "extensions/pi-tag/index.ts",
			line: 42,
			replyTo: "1200",
		});
	});

	it("tags a pi-review review by its marker even without a bot login", () => {
		const [review] = parseReviews([
			{ id: 6, user: { login: "AutumnsGrove" }, state: "COMMENTED", body: "x\n<!-- pi-review:review -->" },
		]);
		expect(review).toMatchObject({ bot: true, source: "pi-review" });
	});

	it("parses reviews and uppercase states", () => {
		const [review] = parseReviews([
			{ id: 5, user: { login: "pi-review-autumnsgrove[bot]", type: "Bot" }, state: "changes_requested", body: "fix" },
			{ body: "no id" },
		]);
		expect(review).toMatchObject({ id: "5", state: "CHANGES_REQUESTED", bot: true, author: "pi-review-autumnsgrove[bot]" });
	});

});

describe("buildSnapshot", () => {
	it("combines the six payloads and drops a bad pull", () => {
		const snapshot = buildSnapshot({
			pull: pullPayload,
			checkRuns: { check_runs: [{ id: 1, name: "review", status: "completed", conclusion: "success" }] },
			statuses: { statuses: [{ context: "ci", state: "pending" }] },
			issueComments: [{ id: 10, body: "hi" }],
			reviewComments: [{ id: 11, body: "nit", path: "a.ts" }],
			reviews: [{ id: 12, state: "APPROVED", body: "" }],
		});
		expect(snapshot?.checks).toHaveLength(2);
		expect(snapshot?.comments.map((comment) => comment.id)).toEqual(["10", "11"]);
		expect(snapshot?.reviews).toHaveLength(1);
		expect(
			buildSnapshot({
				pull: { number: 1 },
				checkRuns: undefined,
				statuses: undefined,
				issueComments: undefined,
				reviewComments: undefined,
				reviews: undefined,
			})
		).toBeUndefined();
	});
});
