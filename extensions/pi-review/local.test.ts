import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildPiArgs,
	type HeadlessRunOptions,
	parseRunArgs,
	readReviewArtifact,
	reviewPromptFor,
	reviewTools,
	summarizeEvents,
} from "./local.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function options(overrides: Partial<HeadlessRunOptions> = {}): HeadlessRunOptions {
	return {
		cwd: "/repo",
		extensionPath: "/ext/pi-review/index.ts",
		prompt: "Review pull request #3.",
		tools: reviewTools(false),
		dryRun: true,
		...overrides,
	};
}

describe("parseRunArgs", () => {
	it("defaults to a dry run with read-only tools", () => {
		expect(parseRunArgs([])).toEqual({ post: false, bash: false });
	});

	it("parses every option", () => {
		expect(
			parseRunArgs(["--post", "--pr", "12", "--base", "develop", "--model", "p/m", "--thinking", "high", "--bash"])
		).toEqual({
			post: true,
			prNumber: 12,
			baseRef: "develop",
			model: "p/m",
			thinking: "high",
			bash: true,
		});
	});

	it("lets a later --dry-run override --post", () => {
		expect(parseRunArgs(["--post", "--dry-run"]).post).toBe(false);
	});

	it("rejects unknown flags and bad values", () => {
		expect(() => parseRunArgs(["--nope"])).toThrow("Unknown option");
		expect(() => parseRunArgs(["--pr"])).toThrow("--pr needs a value");
		expect(() => parseRunArgs(["--pr", "abc"])).toThrow("pull request number");
		expect(() => parseRunArgs(["--model", "--post"])).toThrow("--model needs a value");
	});
});

describe("reviewTools", () => {
	it("includes bash only when opted in, and always submit_review", () => {
		expect(reviewTools(false)).toEqual(["read", "grep", "find", "ls", "submit_review"]);
		expect(reviewTools(true)).toEqual(["read", "grep", "find", "ls", "bash", "submit_review"]);
	});
});

describe("buildPiArgs", () => {
	it("isolates the child and ends with the prompt", () => {
		const args = buildPiArgs(options({ model: "provider/model", thinking: "high" }));
		for (const flag of ["-p", "--mode", "json", "--no-session", "-na", "-nc", "--offline", "-ne", "-ns", "-np", "--no-themes", "--no-mcp"]) {
			expect(args).toContain(flag);
		}
		expect(args[args.indexOf("-e") + 1]).toBe("/ext/pi-review/index.ts");
		expect(args[args.indexOf("--tools") + 1]).toBe("read,grep,find,ls,submit_review");
		expect(args[args.indexOf("--model") + 1]).toBe("provider/model");
		expect(args[args.indexOf("--thinking") + 1]).toBe("high");
		expect(args.at(-1)).toBe("Review pull request #3.");
	});

	it("omits model and thinking when not set", () => {
		const args = buildPiArgs(options());
		expect(args).not.toContain("--model");
		expect(args).not.toContain("--thinking");
	});
});

describe("reviewPromptFor", () => {
	it("names the PR and repository, or the branch base", () => {
		expect(reviewPromptFor({ number: 3, repo: { owner: "o", repo: "r" } })).toBe(
			"Review pull request #3 in o/r."
		);
		expect(reviewPromptFor({ baseRef: "main" })).toBe("Review the current branch against main.");
	});
});

describe("summarizeEvents", () => {
	it("keeps the last assistant text and the tool order", () => {
		const stdout = [
			'{"type":"session"}',
			'{"type":"tool_execution_start","toolName":"read"}',
			'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"First draft"}]}}',
			'{"type":"tool_execution_start","toolName":"submit_review"}',
			'{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"Final answer"}]}}',
		].join("\n");
		expect(summarizeEvents(stdout)).toEqual({
			text: "Final answer",
			toolCalls: ["read", "submit_review"],
		});
	});

	it("ignores non-JSON and malformed lines", () => {
		expect(summarizeEvents("not json\n{\"type\":\n\n")).toEqual({ text: "", toolCalls: [] });
	});
});

describe("readReviewArtifact", () => {
	async function write(content: string): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), "pi-review-artifact-"));
		tempDirs.push(dir);
		const path = join(dir, "review.json");
		await writeFile(path, content, "utf8");
		return path;
	}

	it("reads a submitted review", async () => {
		const path = await write(
			JSON.stringify({
				dryRun: true,
				review: { event: "COMMENT", summary: "Hi", comments: [], dropped: [] },
				markdown: "# Review",
			})
		);
		expect(await readReviewArtifact(path)).toMatchObject({
			dryRun: true,
			review: { summary: "Hi" },
			markdown: "# Review",
		});
	});

	it("returns undefined for missing or malformed artifacts", async () => {
		expect(await readReviewArtifact(undefined)).toBeUndefined();
		expect(await readReviewArtifact("/definitely/missing.json")).toBeUndefined();
		expect(await readReviewArtifact(await write("{}"))).toBeUndefined();
		expect(await readReviewArtifact(await write('{"review":{"summary":"x"}}'))).toBeUndefined();
	});
});
