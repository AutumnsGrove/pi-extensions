import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Exec } from "./detect.ts";
import { parseDiff } from "./diff.ts";
import { REVIEW_MARKER, STICKY_MARKER } from "./markers.ts";
import {
	createSubmitReviewTool,
	postReview,
	renderStickySummary,
	upsertStickyComment,
} from "./submit.ts";

const diffText = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,3 @@
 import { setup } from "./setup";
+console.log("ready");
 export default setup;
`;

const parsed = parseDiff(diffText);
const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempFile(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-review-test-"));
	tempDirs.push(dir);
	return join(dir, "review.json");
}

const review = {
	summary: "Looks reasonable.",
	comments: [{ path: "src/app.ts", line: 2, body: "Remove the debug log." }],
};

type Tool = ReturnType<typeof createSubmitReviewTool>;

async function execute(tool: Tool, params: unknown) {
	return tool.execute("call-1", params as never, undefined, undefined, {} as never);
}

describe("submit_review tool", () => {
	it("writes a dry-run artifact and terminates", async () => {
		const outputPath = await tempFile();
		const tool = createSubmitReviewTool({ getDiff: async () => parsed, dryRun: true, outputPath });
		const result = await execute(tool, review);

		expect(result.terminate).toBe(true);
		expect(result.isError).toBeUndefined();
		const details = result.details as { dryRun: boolean; review: { comments: unknown[] } };
		expect(details.dryRun).toBe(true);
		expect(details.review.comments).toHaveLength(1);

		const artifact = JSON.parse(await readFile(outputPath, "utf8"));
		expect(artifact.dryRun).toBe(true);
		expect(artifact.review.summary).toBe("Looks reasonable.");
		expect(artifact.markdown).toContain("## Pi review");
	});

	it("folds invalid inline positions into the summary", async () => {
		const tool = createSubmitReviewTool({ getDiff: async () => parsed, dryRun: true });
		const result = await execute(tool, {
			summary: "Summary.",
			comments: [{ path: "src/app.ts", line: 99, body: "Off the end." }],
		});
		const first = result.content[0];
		const text = first && first.type === "text" ? first.text : "";
		expect(text).toContain("could not be attached to the diff");
		expect(text).toContain("Off the end.");
	});

	it("posts through the injected poster and reports the URL", async () => {
		const post = vi.fn(async () => ({ url: "https://github.com/o/r/pull/1#pullrequestreview-1" }));
		const tool = createSubmitReviewTool({ getDiff: async () => parsed, dryRun: false, post });
		const result = await execute(tool, review);
		expect(post).toHaveBeenCalledOnce();
		expect(result.terminate).toBe(true);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: "Review posted: https://github.com/o/r/pull/1#pullrequestreview-1",
		});
	});

	it("refuses a second submission", async () => {
		const tool = createSubmitReviewTool({ getDiff: async () => parsed, dryRun: true });
		await execute(tool, review);
		const second = await execute(tool, review);
		expect(second.isError).toBe(true);
		expect(second.terminate).toBeUndefined();
	});

	it("keeps the run open when posting fails so the model can retry", async () => {
		const outputPath = await tempFile();
		const post = vi.fn(async () => {
			throw new Error("422 Unprocessable Entity");
		});
		const tool = createSubmitReviewTool({ getDiff: async () => parsed, dryRun: false, post, outputPath });
		const result = await execute(tool, review);
		expect(result.isError).toBe(true);
		expect(result.terminate).toBeUndefined();
		const first = result.content[0];
		const text = first && first.type === "text" ? first.text : "";
		expect(text).toContain("422 Unprocessable Entity");
		// The validated review survives a failed post, for the step summary.
		const artifact = JSON.parse(await readFile(outputPath, "utf8"));
		expect(artifact.error).toContain("422 Unprocessable Entity");
		// The workflow fails the job on this marker, so an abandoned post is not green.
		expect(artifact.incomplete).toBe(true);
		expect(artifact.review.summary).toBe("Looks reasonable.");
	});

	it("errors when there is no target to post to", async () => {
		const tool = createSubmitReviewTool({ getDiff: async () => parsed, dryRun: false });
		const result = await execute(tool, review);
		expect(result.isError).toBe(true);
	});
});

describe("postReview", () => {
	it("builds the review payload and reads the html_url", async () => {
		let payload: unknown;
		const exec: Exec = async (command, args) => {
			expect(command).toBe("gh");
			const inputIndex = args.indexOf("--input");
			payload = JSON.parse(await readFile(args[inputIndex + 1]!, "utf8"));
			return { stdout: JSON.stringify({ html_url: "https://example.test/review" }), code: 0 };
		};
		const result = await postReview(
			exec,
			{ repo: { owner: "o", repo: "r" }, number: 3, commitId: "head-sha" },
			{
				event: "COMMENT",
				summary: "Body.",
				comments: [{ path: "src/app.ts", line: 2, side: "RIGHT", body: "Hi." }],
				dropped: [],
			}
		);
		expect(result.url).toBe("https://example.test/review");
		expect(payload).toEqual({
			commit_id: "head-sha",
			event: "COMMENT",
			body: `Body.\n\n${REVIEW_MARKER}`,
			comments: [{ path: "src/app.ts", line: 2, side: "RIGHT", body: "Hi." }],
		});
	});

	it("throws gh's message on failure", async () => {
		const exec: Exec = async () => ({ stdout: "", stderr: "Bad credentials", code: 1 });
		await expect(
			postReview(exec, { repo: { owner: "o", repo: "r" }, number: 3 }, {
				event: "COMMENT",
				summary: "Body.",
				comments: [],
				dropped: [],
			})
		).rejects.toThrow("Bad credentials");
	});
});

describe("upsertStickyComment", () => {
	function fakeExec(list: unknown, options: { failWrite?: boolean } = {}) {
		const calls: string[][] = [];
		const exec: Exec = async (_command, args) => {
			calls.push(args);
			if (args[1]?.endsWith("/comments?per_page=100")) {
				return { stdout: JSON.stringify(list), stderr: "", code: 0 };
			}
			if (options.failWrite) return { stdout: "", stderr: "HTTP 403", code: 1 };
			return { stdout: JSON.stringify({ html_url: "https://example.test/comment" }), stderr: "", code: 0 };
		};
		return Object.assign(exec, { calls });
	}

	const review = {
		event: "COMMENT" as const,
		summary: "Body.",
		comments: [{ path: "src/app.ts", line: 2, side: "RIGHT" as const, body: "Hi." }],
		dropped: [],
	};
	const target = { repo: { owner: "o", repo: "r" }, number: 3, commitId: "abcdef1234567890" };

	it("creates the sticky comment when none exists", async () => {
		const exec = fakeExec([]);
		const result = await upsertStickyComment(exec, target, review, "https://example.test/review", {
			cwd: "/repo",
		});
		expect(result.url).toBe("https://example.test/comment");
		const write = exec.calls.find((args) => args[1] === "--method" && args[2] === "POST")!;
		expect(write[3]).toBe("repos/o/r/issues/3/comments");
		expect(write.join(" ")).toContain(STICKY_MARKER);
	});

	it("updates the existing marker comment in place", async () => {
		const exec = fakeExec([
			{ id: 5, body: "unrelated" },
			{ id: 7, body: `${STICKY_MARKER}\nold` },
		]);
		await upsertStickyComment(exec, target, review, "https://example.test/review", { cwd: "/repo" });
		const write = exec.calls.find((args) => args[1] === "--method" && args[2] === "PATCH")!;
		expect(write[3]).toBe("repos/o/r/issues/comments/7");
		expect(exec.calls.some((args) => args[2] === "POST")).toBe(false);
	});

	it("throws when the write fails", async () => {
		await expect(
			upsertStickyComment(fakeExec([], { failWrite: true }), target, review, undefined, { cwd: "/repo" })
		).rejects.toThrow("HTTP 403");
	});

	it("renders a compact status line", () => {
		const text = renderStickySummary(review, target, "https://example.test/review");
		expect(text.startsWith(STICKY_MARKER)).toBe(true);
		expect(text).toContain("reviewed `abcdef123456`");
		expect(text).toContain("comment ·");
		expect(text).toContain("1 inline comment");
		expect(text).toContain("[details](https://example.test/review)");
	});
});
