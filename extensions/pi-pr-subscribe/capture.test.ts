import { describe, expect, it } from "vitest";
import { extractPostedIds, extractPostedTarget, targetMatches } from "./capture.ts";

describe("extractPostedIds", () => {
	it("reads the fragment URLs gh prints", () => {
		expect(
			extractPostedIds(
				"https://github.com/o/r/pull/32#issuecomment-3550000001\nhttps://github.com/o/r/pull/32#discussion_r4590049707"
			)
		).toEqual(["3550000001", "4590049707"]);
		expect(
			extractPostedIds("https://github.com/o/r/pull/32#pullrequestreview-5912796196")
		).toEqual(["5912796196"]);
	});

	it("reads a JSON API response next to its pull-request URL", () => {
		const body = JSON.stringify({
			id: 3550000002,
			html_url: "https://github.com/o/r/pull/32#issuecomment-3550000002",
			body: "x",
		});
		expect(extractPostedIds(body)).toEqual(["3550000002"]);
		const reversed = '{"id": 42, "html_url": "https://github.com/o/r/pull/32#discussion_r42"}';
		expect(extractPostedIds(reversed)).toEqual(["42"]);
	});

	it("ignores an unrelated id with no pull-request URL beside it", () => {
		expect(extractPostedIds('{"id": 7, "html_url": "https://example.com/x"}')).toEqual([]);
		expect(extractPostedIds("nothing here")).toEqual([]);
	});
});

describe("extractPostedTarget", () => {
	it("reads an explicit PR number", () => {
		expect(extractPostedTarget("gh pr comment 32 --body 'hello'")).toMatchObject({ number: 32, kind: "issue-comment" });
		expect(extractPostedTarget("gh pr review 7 --approve")).toMatchObject({ number: 7, kind: "review" });
	});

	it("leaves the number implicit", () => {
		expect(extractPostedTarget("gh pr comment --body 'hello'")).toMatchObject({ kind: "issue-comment" });
		expect(extractPostedTarget("gh pr comment --body 'hello'")?.number).toBeUndefined();
	});

	it("reads gh api paths, including the repo", () => {
		expect(
			extractPostedTarget("gh api repos/o/r/issues/32/comments -f body=hi")
		).toEqual({ owner: "o", repo: "r", number: 32, kind: "issue-comment" });
		expect(
			extractPostedTarget("gh api repos/o/r/pulls/32/comments -f body=hi")
		).toEqual({ owner: "o", repo: "r", number: 32, kind: "review-comment" });
		expect(extractPostedTarget("gh api --method POST repos/o/r/pulls/32/reviews -f event=APPROVE")).toEqual({
			owner: "o",
			repo: "r",
			number: 32,
			kind: "review",
		});
	});

	it("ignores other commands", () => {
		expect(extractPostedTarget("gh pr checks 32")).toBeUndefined();
		expect(extractPostedTarget("git commit -m 'gh pr comment 32'")).toBeUndefined();
		expect(extractPostedTarget("ls")).toBeUndefined();
	});
});

describe("targetMatches", () => {
	const ref = { owner: "o", repo: "r", number: 32 };
	const cwdRepo = { owner: "o", repo: "r" };

	it("matches on repo and number when the command names them", () => {
		expect(targetMatches({ owner: "o", repo: "r", number: 32, kind: "review" }, ref, cwdRepo)).toBe(true);
		expect(targetMatches({ owner: "o", repo: "r", number: 31, kind: "review" }, ref, cwdRepo)).toBe(false);
		expect(targetMatches({ owner: "o", repo: "other", number: 32, kind: "review" }, ref, cwdRepo)).toBe(false);
	});

	it("falls back to the cwd repo when the command omits it", () => {
		expect(targetMatches({ number: 32, kind: "issue-comment" }, ref, cwdRepo)).toBe(true);
		expect(targetMatches({ number: 32, kind: "issue-comment" }, ref, undefined)).toBe(false);
		expect(targetMatches({ number: 32, kind: "issue-comment" }, ref, { owner: "x", repo: "y" })).toBe(false);
	});

	it("does nothing without a target", () => {
		expect(targetMatches(undefined, ref, cwdRepo)).toBe(false);
	});
});
