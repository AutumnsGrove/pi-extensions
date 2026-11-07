import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Exec } from "./detect.ts";
import { isReviewRunner, registerReviewRunner } from "./runner.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

const diff = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,3 @@
 import { setup } from "./setup";
+console.log("ready");
 export default setup;
`;

const view = {
	number: 5,
	title: "Add readiness log",
	body: "Body",
	author: { login: "octocat" },
	baseRefName: "main",
	baseRefOid: "base-sha",
	headRefOid: "head-sha",
};

function fakeExec(): Exec {
	return async (command, args) => {
		const key = `${command} ${args.join(" ")}`;
		if (key === "git remote get-url origin") return { stdout: "git@github.com:owner/repo.git", code: 0 };
		if (key.startsWith("gh pr view 5")) return { stdout: JSON.stringify(view), code: 0 };
		if (key === "gh pr diff 5") return { stdout: diff, code: 0 };
		if (command === "gh" && args[0] === "api") {
			return { stdout: JSON.stringify({ html_url: "https://example.test/r/1" }), code: 0 };
		}
		return { stdout: "", stderr: "missing", code: 1 };
	};
}

function fakePi(exec: Exec): {
	pi: Parameters<typeof registerReviewRunner>[0];
	tools: ToolDefinition[];
	events: Map<string, Handler>;
} {
	const tools: ToolDefinition[] = [];
	const events = new Map<string, Handler>();
	const pi = {
		exec,
		registerTool: (tool: ToolDefinition) => {
			tools.push(tool);
		},
		on: (event: string, handler: Handler) => {
			events.set(event, handler);
			return () => {};
		},
	} as unknown as Parameters<typeof registerReviewRunner>[0];
	return { pi, tools, events };
}

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function outputPath(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-review-runner-"));
	tempDirs.push(dir);
	return join(dir, "review.json");
}

async function executeTool(tool: ToolDefinition, params: unknown) {
	return tool.execute("call", params as never, undefined, undefined, {} as never);
}

describe("isReviewRunner", () => {
	it("only activates on PI_REVIEW=1", () => {
		expect(isReviewRunner({ PI_REVIEW: "1" })).toBe(true);
		expect(isReviewRunner({ PI_REVIEW: "0" })).toBe(false);
		expect(isReviewRunner({})).toBe(false);
	});
});

describe("registerReviewRunner", () => {
	it("registers submit_review", () => {
		const { pi, tools } = fakePi(fakeExec());
		registerReviewRunner(pi, { env: { PI_REVIEW: "1", PR_NUMBER: "5" } });
		expect(tools.map((tool) => tool.name)).toEqual(["submit_review"]);
	});

	it("injects the review instructions and PR context", async () => {
		const { pi, events } = fakePi(fakeExec());
		registerReviewRunner(pi, { env: { PI_REVIEW: "1", PR_NUMBER: "5" } });
		const handler = events.get("before_agent_start")!;
		const result = (await handler(
			{ messageType: "user", prompt: "Review pull request #5.", systemPrompt: "BASE PROMPT" },
			{ cwd: "/repo" }
		)) as { systemPrompt: string; message: { content: string } };

		expect(result.systemPrompt.startsWith("BASE PROMPT")).toBe(true);
		expect(result.systemPrompt).toContain("Pull-request review mode (pi-review)");
		expect(result.message.content).toContain("Pull request: #5");
		expect(result.message.content).toContain("+console.log(\"ready\");");
	});

	it("keeps going with notes when gh and git both fail", async () => {
		const failing: Exec = async () => {
			throw new Error("network down");
		};
		const { pi, events } = fakePi(failing);
		registerReviewRunner(pi, { env: { PI_REVIEW: "1", PR_NUMBER: "5" } });
		const result = (await events.get("before_agent_start")!(
			{ messageType: "user", prompt: "x", systemPrompt: "BASE" },
			{ cwd: "/repo" }
		)) as { systemPrompt: string; message: { content: string } };
		expect(result.systemPrompt).toContain("Pull-request review mode");
		expect(result.message.content).toContain("Could not detect a github.com `origin` remote.");
		expect(result.message.content).toContain("Could not read pull request #5");
	});

	it("writes a dry-run artifact through the tool", async () => {
		const path = await outputPath();
		const { pi, tools, events } = fakePi(fakeExec());
		registerReviewRunner(pi, {
			env: { PI_REVIEW: "1", PI_REVIEW_DRY_RUN: "1", PI_REVIEW_OUTPUT: path, PR_NUMBER: "5" },
		});
		await events.get("before_agent_start")!(
			{ messageType: "user", prompt: "x", systemPrompt: "BASE" },
			{ cwd: "/repo" }
		);
		const result = await executeTool(tools[0]!, {
			summary: "Looks fine.",
			comments: [{ path: "src/app.ts", line: 2, body: "Debug log." }],
		});
		expect(result.terminate).toBe(true);
		const artifact = JSON.parse(await readFile(path, "utf8"));
		expect(artifact.dryRun).toBe(true);
		expect(artifact.review.comments).toHaveLength(1);
		expect(artifact.markdown).toContain("owner/repo#5");
	});

	it("posts when not in dry-run and records the URL", async () => {
		const path = await outputPath();
		const { pi, tools, events } = fakePi(fakeExec());
		registerReviewRunner(pi, { env: { PI_REVIEW: "1", PI_REVIEW_OUTPUT: path, PR_NUMBER: "5" } });
		await events.get("before_agent_start")!(
			{ messageType: "user", prompt: "x", systemPrompt: "BASE" },
			{ cwd: "/repo" }
		);
		const result = await executeTool(tools[0]!, { summary: "Looks fine.", comments: [] });
		expect(result.terminate).toBe(true);
		const artifact = JSON.parse(await readFile(path, "utf8"));
		expect(artifact.url).toBe("https://example.test/r/1");
	});

	it("injects the context message once, even when the run restarts", async () => {
		const { pi, events } = fakePi(fakeExec());
		registerReviewRunner(pi, { env: { PI_REVIEW: "1", PR_NUMBER: "5" } });
		const handler = events.get("before_agent_start")!;
		const first = (await handler(
			{ messageType: "user", prompt: "x", systemPrompt: "BASE" },
			{ cwd: "/repo" }
		)) as { message?: { content: string } };
		const second = (await handler(
			{ messageType: "user", prompt: "x", systemPrompt: "BASE" },
			{ cwd: "/repo" }
		)) as { message?: { content: string }; systemPrompt: string };

		expect(first.message?.content).toContain("Pull request: #5");
		expect(second.message).toBeUndefined();
		expect(second.systemPrompt).toContain("Pull-request review mode");
	});

	it("honors PI_REVIEW_MAX_COMMENTS", async () => {
		const path = await outputPath();
		const { pi, tools, events } = fakePi(fakeExec());
		registerReviewRunner(pi, {
			env: {
				PI_REVIEW: "1",
				PI_REVIEW_DRY_RUN: "1",
				PI_REVIEW_OUTPUT: path,
				PI_REVIEW_MAX_COMMENTS: "1",
				PR_NUMBER: "5",
			},
		});
		await events.get("before_agent_start")!(
			{ messageType: "user", prompt: "x", systemPrompt: "BASE" },
			{ cwd: "/repo" }
		);
		const result = (await executeTool(tools[0]!, {
			summary: "Fine.",
			comments: [
				{ path: "src/app.ts", line: 2, body: "One." },
				{ path: "src/app.ts", line: 2, body: "Two." },
			],
		})) as { details: { review?: { comments: unknown[]; dropped: unknown[] } } };
		expect(result.details.review?.comments).toHaveLength(1);
		expect(result.details.review?.dropped).toHaveLength(1);
	});

	it("offers open bot threads and the resolve tool when enabled", async () => {
		const threadsPayload = {
			data: {
				repository: {
					pullRequest: {
						reviewThreads: {
							nodes: [
								{
									id: "T1",
									isResolved: false,
									isOutdated: false,
									path: "src/app.ts",
									line: 2,
									comments: {
										nodes: [
											{
												body: "The null check is missing.",
												author: { login: "pi-review-x[bot]", __typename: "Bot" },
											},
										],
									},
								},
							],
						},
					},
				},
			},
		};
		const exec: Exec = async (command, args) => {
			if (command === "gh" && args[0] === "api" && args[1] === "graphql") {
				return { stdout: JSON.stringify(threadsPayload), stderr: "", code: 0 };
			}
			const key = `${command} ${args.join(" ")}`;
			const table: Record<string, { stdout?: string; code?: number }> = {
				"git remote get-url origin": { stdout: "git@github.com:owner/repo.git" },
				"gh pr view 5 --json number,title,body,author,baseRefName,baseRefOid,headRefOid": {
					stdout: JSON.stringify(view),
				},
				"gh pr diff 5": { stdout: diff },
			};
			const hit = table[key] ?? { code: 1 };
			return { stdout: hit.stdout ?? "", stderr: "", code: hit.code ?? 0 };
		};
		const { pi, tools, events } = fakePi(exec);
		registerReviewRunner(pi, {
			env: { PI_REVIEW: "1", PR_NUMBER: "5", PI_REVIEW_RESOLVE_THREADS: "1" },
		});
		expect(tools.map((tool) => tool.name)).toContain("resolve_review_threads");
		const result = (await events.get("before_agent_start")!(
			{ messageType: "user", prompt: "x", systemPrompt: "BASE" },
			{ cwd: "/repo" }
		)) as { systemPrompt: string; message: { content: string } };
		expect(result.message.content).toContain("<open-review-threads>");
		expect(result.message.content).toContain("id: `T1`");
		expect(result.systemPrompt).toContain("resolve_review_threads");
	});

	it("does not register the resolve tool when disabled", () => {
		const { pi, tools } = fakePi(fakeExec());
		registerReviewRunner(pi, { env: { PI_REVIEW: "1", PR_NUMBER: "5" } });
		expect(tools.map((tool) => tool.name)).not.toContain("resolve_review_threads");
	});

	it("passes the configured strictness into the prompt", async () => {
		const { pi, events } = fakePi(fakeExec());
		registerReviewRunner(pi, { env: { PI_REVIEW: "1", PR_NUMBER: "5", PI_REVIEW_STRICTNESS: "thorough" } });
		const result = (await events.get("before_agent_start")!(
			{ messageType: "user", prompt: "x", systemPrompt: "BASE" },
			{ cwd: "/repo" }
		)) as { systemPrompt: string };
		expect(result.systemPrompt).toContain("then minor suggestions marked as non-blocking");
	});

	it("passes the dependency install outcome into the prompt", async () => {
		const { pi, events } = fakePi(fakeExec());
		registerReviewRunner(pi, {
			env: { PI_REVIEW: "1", PR_NUMBER: "5", PI_REVIEW_DEPS: "unavailable" },
		});
		const result = (await events.get("before_agent_start")!(
			{ messageType: "user", prompt: "x", systemPrompt: "BASE" },
			{ cwd: "/repo" }
		)) as { systemPrompt: string };
		expect(result.systemPrompt).toContain("Dependency installation did not succeed");
	});

	it("validates comments against the full PR diff, not the increment", async () => {
		const fullDiff = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,2 +1,3 @@
 import { setup } from "./setup";
+console.log("ready");
 export default setup;
`;
		const incremental = `diff --git a/src/other.ts b/src/other.ts
new file mode 100644
--- /dev/null
+++ b/src/other.ts
@@ -0,0 +1 @@
+export const other = 1;
`;
		const exec: Exec = async (command, args) => {
			const key = `${command} ${args.join(" ")}`;
			const table: Record<string, { stdout?: string; code?: number }> = {
				"git remote get-url origin": { stdout: "git@github.com:owner/repo.git" },
				"gh pr view 5 --json number,title,body,author,baseRefName,baseRefOid,headRefOid": {
					stdout: JSON.stringify(view),
				},
				"gh pr diff 5": { stdout: fullDiff },
				"gh api repos/owner/repo/pulls/5/reviews?per_page=100": {
					stdout: JSON.stringify([
						{
							body: "old <!-- pi-review:review -->",
							commit_id: "prev-sha",
							submitted_at: "2026-01-01T00:00:00Z",
						},
					]),
				},
				"git merge-base --is-ancestor prev-sha head-sha": { code: 0 },
				"git diff --no-color --no-ext-diff prev-sha...head-sha": { stdout: incremental },
			};
			const hit = table[key] ?? { code: 1 };
			return { stdout: hit.stdout ?? "", stderr: "", code: hit.code ?? 0 };
		};
		const path = await outputPath();
		const { pi, tools, events } = fakePi(exec);
		registerReviewRunner(pi, {
			env: { PI_REVIEW: "1", PI_REVIEW_DRY_RUN: "1", PI_REVIEW_OUTPUT: path, PR_NUMBER: "5" },
		});
		await events.get("before_agent_start")!(
			{ messageType: "user", prompt: "x", systemPrompt: "BASE" },
			{ cwd: "/repo" }
		);
		const result = (await executeTool(tools[0]!, {
			summary: "Summary.",
			comments: [
				{ path: "src/app.ts", line: 2, body: "In the PR." },
				{ path: "src/other.ts", line: 1, body: "Only in the increment." },
			],
		})) as {
			details: { review?: { comments: { path: string }[]; dropped: { path: string }[] } };
		};
		// The PR diff accepts src/app.ts; the incremental-only file is folded away.
		expect(result.details.review?.comments.map((comment) => comment.path)).toEqual(["src/app.ts"]);
		expect(result.details.review?.dropped.map((comment) => comment.path)).toEqual(["src/other.ts"]);
	});

	it("marks a run that never submitted a review as incomplete", async () => {
		const path = await outputPath();
		const { pi, events } = fakePi(fakeExec());
		registerReviewRunner(pi, {
			env: { PI_REVIEW: "1", PI_REVIEW_DRY_RUN: "1", PI_REVIEW_OUTPUT: path, PR_NUMBER: "5" },
		});
		await events.get("before_agent_start")!(
			{ messageType: "user", prompt: "x", systemPrompt: "BASE" },
			{ cwd: "/repo" }
		);
		await events.get("agent_settled")!({}, { cwd: "/repo" });
		const artifact = JSON.parse(await readFile(path, "utf8"));
		expect(artifact.incomplete).toBe(true);
		expect(artifact.error).toContain("without submitting");
	});
});
