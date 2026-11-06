import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Exec } from "./detect.ts";
import { parseDiff } from "./diff.ts";
import { createSubmitReviewTool, postReview } from "./submit.ts";

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
		const post = vi.fn(async () => {
			throw new Error("422 Unprocessable Entity");
		});
		const tool = createSubmitReviewTool({ getDiff: async () => parsed, dryRun: false, post });
		const result = await execute(tool, review);
		expect(result.isError).toBe(true);
		expect(result.terminate).toBeUndefined();
		const first = result.content[0];
		const text = first && first.type === "text" ? first.text : "";
		expect(text).toContain("422 Unprocessable Entity");
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
			body: "Body.",
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
