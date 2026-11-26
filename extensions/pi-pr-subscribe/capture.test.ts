import { describe, expect, it } from "vitest";
import { extractPostedIds, extractPostedTarget, shellSegments, targetMatches } from "./capture.ts";

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

	it("does not treat a read of the same path as a post", () => {
		// The thread is read through the very path a reply is written to, and a read
		// must not open the echo window: it posts nothing, and the window would
		// silence a comment the user writes on github.com.
		expect(extractPostedTarget("gh api repos/o/r/issues/32/comments")).toBeUndefined();
		expect(extractPostedTarget("gh api repos/o/r/pulls/32/comments --jq '.[] | .body'")).toBeUndefined();
		expect(extractPostedTarget("gh api repos/o/r/pulls/32/reviews -X GET")).toBeUndefined();
		expect(extractPostedTarget("gh api --paginate repos/o/r/pulls/32/comments")).toBeUndefined();
	});

	it("reads the write flags gh api accepts", () => {
		const write = (command: string): boolean => extractPostedTarget(command) !== undefined;
		expect(write("gh api repos/o/r/issues/32/comments -f body=hi")).toBe(true);
		expect(write("gh api repos/o/r/issues/32/comments --raw-field body=hi")).toBe(true);
		expect(write("gh api repos/o/r/pulls/32/comments -F body=@/tmp/reply.md")).toBe(true);
		expect(write("gh api repos/o/r/pulls/32/reviews --field event=APPROVE")).toBe(true);
		expect(write("gh api repos/o/r/pulls/32/reviews --input /tmp/review.json")).toBe(true);
		expect(write("gh api --method POST repos/o/r/pulls/32/comments")).toBe(true);
		expect(write("gh api -X POST repos/o/r/pulls/32/comments")).toBe(true);
		// pflag takes the joined forms, and a session that writes them is writing.
		expect(write("gh api repos/o/r/pulls/32/comments -XPOST")).toBe(true);
		expect(write("gh api repos/o/r/pulls/32/comments --method=POST")).toBe(true);
		expect(write("gh api repos/o/r/pulls/32/comments -fbody=hi")).toBe(true);
		expect(write("gh api repos/o/r/pulls/32/comments -Fbody=@/tmp/reply.md")).toBe(true);
		expect(write("gh api repos/o/r/pulls/32/reviews --input=/tmp/review.json")).toBe(true);
	});

	it("keeps a later segment's flags out of gh's argument list", () => {
		// Both are reads of the thread. `grep -F` and the second command's `-f`
		// belong to something else; reading them as gh's own write would open the
		// echo window on a read.
		expect(
			extractPostedTarget("gh api repos/o/r/pulls/32/comments --jq '.[].body' | grep -F thanks")
		).toBeUndefined();
		expect(
			extractPostedTarget("gh api repos/o/r/pulls/32/comments > /tmp/c.json; ls -F")
		).toBeUndefined();
		// The write in a later segment is still found.
		expect(
			extractPostedTarget("gh api repos/o/r/pulls/32/comments > /tmp/c.json; gh api repos/o/r/issues/32/comments -f body=hi")
		).toMatchObject({ kind: "issue-comment", number: 32 });
	});

	it("splits a command on the shell's separators, respecting quotes", () => {
		expect(shellSegments("gh api x --jq '.[] | .body' | jq .id")).toEqual([
			"gh api x --jq '.[] | .body' ",
			" jq .id",
		]);
		expect(shellSegments("a; b && c")).toEqual(["a", " b ", "", " c"]);
	});

	it("follows a backslash escape, so a shell-escaped apostrophe does not trap the scan", () => {
		// `'\''` is close-quote, escaped quote, reopen-quote: a valid way to put an
		// apostrophe in a single-quoted string. Reading the backslash as a literal
		// left the scan inside a quote, swallowed the `| grep -F`, and made a read
		// look like a write.
		const command = String.raw`gh api repos/o/r/pulls/32/comments --jq '.[] | select(.body | contains("don'\''t"))' | grep -F thanks`;
		expect(shellSegments(command)).toHaveLength(2);
		expect(extractPostedTarget(command)).toBeUndefined();

		// The same quoting in a real write still counts.
		expect(
			extractPostedTarget(String.raw`gh api repos/o/r/pulls/32/comments -f body='don'\''t'`)
		).toMatchObject({ kind: "review-comment" });
	});

	it("treats $'…' as ANSI-C quoting, where \\' escapes the apostrophe", () => {
		// bash's ANSI-C quoting uses the single-quote delimiter with C escapes, so a
		// backslash apostrophe there does not end the string. Reading it as a plain
		// single quote closed and reopened the string and swallowed the pipeline.
		const command = String.raw`gh api repos/o/r/pulls/32/comments --jq $'.[] | select(.body | contains("don\'t"))' | grep -F thanks`;
		expect(shellSegments(command)).toHaveLength(2);
		expect(extractPostedTarget(command)).toBeUndefined();

		// A real write in the same quoting is still a write.
		expect(
			extractPostedTarget(String.raw`gh api repos/o/r/issues/32/comments -f body=$'don\'t'`)
		).toMatchObject({ kind: "issue-comment" });
	});

	it("treats an escaped quote inside double quotes as part of the string", () => {
		expect(shellSegments(`gh api x --jq "a\\"b" | jq .id`)).toHaveLength(2);
		expect(extractPostedTarget(`gh api repos/o/r/pulls/32/comments --jq "a\\"b" | grep -F x`)).toBeUndefined();
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
