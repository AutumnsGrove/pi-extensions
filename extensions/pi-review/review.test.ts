import { describe, expect, it } from "vitest";
import { parseDiff } from "./diff.ts";
import { renderReviewMarkdown, validateReview } from "./review.ts";

const diff = parseDiff(`diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 import { setup } from "./setup";
 
+console.log("ready");
 export default setup;
diff --git a/docs/old.md b/docs/old.md
deleted file mode 100644
index 1111111..0000000
--- a/docs/old.md
+++ /dev/null
@@ -1,2 +0,0 @@
-hello
-world
`);

describe("validateReview", () => {
	it("keeps comments that point at diff lines and defaults the side", () => {
		const review = validateReview(
			{
				summary: "Looks good overall.",
				comments: [
					{ path: "src/app.ts", line: 3, body: "Remove this debug log." },
					{ path: "src/app.ts", line: 4, side: "RIGHT", body: "Nice." },
					{ path: "docs/old.md", line: 2, side: "LEFT", body: "Why delete this?" },
				],
			},
			diff
		);
		expect(review.event).toBe("COMMENT");
		expect(review.comments).toHaveLength(3);
		expect(review.comments[0]).toMatchObject({ path: "src/app.ts", line: 3, side: "RIGHT" });
		expect(review.dropped).toEqual([]);
		expect(review.summary).toBe("Looks good overall.");
	});

	it("folds invalid positions into the summary instead of dropping them", () => {
		const review = validateReview(
			{
				summary: "Summary.",
				comments: [
					{ path: "src/app.ts", line: 99, body: "Off the end." },
					{ path: "src/missing.ts", line: 1, body: "Unknown file." },
					{ path: "docs/old.md", line: 1, side: "RIGHT", body: "Removed line, wrong side." },
					{ path: "src/app.ts", line: 3, body: "" },
				],
			},
			diff
		);
		expect(review.comments).toEqual([]);
		expect(review.dropped).toHaveLength(4);
		expect(review.summary).toContain("could not be attached to the diff");
		expect(review.summary).toContain("Off the end.");
		expect(review.summary).toContain("Unknown file.");
		expect(review.summary).toContain("Removed line, wrong side.");
		expect(review.summary).toContain("the comment body was empty");
	});

	it("falls back to a generated summary when only comments were given", () => {
		const review = validateReview(
			{ comments: [{ path: "src/app.ts", line: 3, body: "One thing." }] },
			diff
		);
		expect(review.summary).toContain("left 1 inline comment");
	});

	it("does not offer REQUEST_CHANGES unless it is enabled", () => {
		expect(validateReview({ summary: "x", event: "REQUEST_CHANGES" }, diff).event).toBe("COMMENT");
		expect(
			validateReview({ summary: "x", event: "REQUEST_CHANGES" }, diff, { requestChanges: true }).event
		).toBe("REQUEST_CHANGES");
		expect(validateReview({ summary: "x", event: "APPROVE" }, diff, { requestChanges: true }).event).toBe(
			"COMMENT"
		);
	});

	it("clears an invalid start_line but keeps the comment", () => {
		const review = validateReview(
			{ comments: [{ path: "src/app.ts", line: 3, start_line: 99, body: "Range." }] },
			diff
		);
		expect(review.comments).toHaveLength(1);
		expect(review.comments[0]!.start_line).toBeUndefined();
	});

	it("accepts a valid start_line", () => {
		const review = validateReview(
			{ comments: [{ path: "src/app.ts", line: 3, start_line: 2, body: "Range." }] },
			diff
		);
		expect(review.comments[0]!.start_line).toBe(2);
	});

	it("caps the number of inline comments", () => {
		const comments = Array.from({ length: 5 }, () => ({ path: "src/app.ts", line: 3, body: "Same line." }));
		const review = validateReview({ comments }, diff, { maxComments: 2 });
		expect(review.comments).toHaveLength(2);
		expect(review.dropped).toHaveLength(3);
		expect(review.dropped[0]!.reason).toContain("only the first 2");
	});

	it("normalizes paths with a leading ./", () => {
		const review = validateReview(
			{ comments: [{ path: "./src/app.ts", line: 3, body: "hi" }] },
			diff
		);
		expect(review.comments[0]!.path).toBe("src/app.ts");
	});
});

describe("renderReviewMarkdown", () => {
	it("renders the header, summary, and inline comments", () => {
		const review = validateReview(
			{
				summary: "Summary line.",
				comments: [{ path: "src/app.ts", line: 3, start_line: 2, body: "First\nSecond" }],
			},
			diff
		);
		const markdown = renderReviewMarkdown(review, {
			repo: { owner: "owner", repo: "repo" },
			number: 7,
			model: "provider/model",
			baseRef: "main",
			headSha: "0123456789abcdef",
		});
		expect(markdown).toContain("## Pi review — owner/repo#7");
		expect(markdown).toContain("event `COMMENT`");
		expect(markdown).toContain("model `provider/model`");
		expect(markdown).toContain("Summary line.");
		expect(markdown).toContain("### Inline comments (1)");
		expect(markdown).toContain("`src/app.ts:2-3`");
		expect(markdown).toContain("> First\n> Second");
	});

	it("says so when there is nothing inline", () => {
		const markdown = renderReviewMarkdown(validateReview({ summary: "Only a summary." }, diff));
		expect(markdown).toContain("_No inline comments._");
	});
});

describe("validateReview on renames", () => {
	const renameDiff = parseDiff(`diff --git a/src/before.ts b/src/after.ts
similarity index 88%
rename from src/before.ts
rename to src/after.ts
index 1111111..2222222 100644
--- a/src/before.ts
+++ b/src/after.ts
@@ -1 +1 @@
-export const name = "before";
+export const name = "after";
`);

	it("rewrites an old-path comment to the post-rename path", () => {
		const review = validateReview(
			{ comments: [{ path: "src/before.ts", line: 1, body: "Renamed." }] },
			renameDiff
		);
		expect(review.comments).toHaveLength(1);
		expect(review.comments[0]!.path).toBe("src/after.ts");
	});
});
